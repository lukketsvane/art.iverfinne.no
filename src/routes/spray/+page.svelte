<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot, placeVoxels, getProfile, errText } from '$lib/api';
	import { VoxelBrush } from '$lib/voxel';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix, downscaleJpeg } from '$lib/spots';
	import { detectFeatures, triangulate } from '$lib/mesh';

	import { fmtVolume, type Profile, type Spot } from '$lib/types';

	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };
	const VOX_SIZE: Record<Thickness, number> = { thin: 0.012, medium: 0.024, thick: 0.04 };
	const LOCK_TIMEOUT_MS = 7000;

	let video: HTMLVideoElement;
	let overlay: HTMLCanvasElement;
	let container: HTMLDivElement;
	let stream: MediaStream | null = null;

	// boot → aim (auto-capture) → building (compile+mesh) → locking → ready
	let phase = $state<'boot' | 'aim' | 'building' | 'locking' | 'ready' | 'error'>('boot');
	let buildPct = $state(0);
	let remapCount = $state(0);
	let thickness = $state<Thickness>('medium');
	let depthCm = $state(3);
	let errorMsg = $state('');
	let toast = $state('');
	let profile = $state<Profile | null>(null);
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);

	let frame: Blob | null = null; // 1280px reference photo
	let frameW = 0;
	let frameH = 0;
	let detectData: ImageData | null = null; // small copy for feature detection
	let featureCount = $state(0);

	// The wall's DB row is created in the background; strokes await it.
	let spotPromise: Promise<Spot> | null = null;
	let spotId = $state<string | null>(null);

	// MindAR (true 3D: strokes live in the tracked anchor's space)
	let mindar: any = null;
	let anchorGroup: THREE.Group | null = null;
	let tapPlane: THREE.Mesh | null = null;
	const raycaster = new THREE.Raycaster();
	let lockTimer: ReturnType<typeof setTimeout> | undefined;

	// stroke state (anchor space)
	let brush: VoxelBrush | null = null;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	// Precision gate: pose must settle before caulking is allowed. Enter/exit
	// thresholds differ (hysteresis) so hand tremor doesn't flicker the gate,
	// and steady tracking unlocks it after a few seconds regardless.
	let precise = $state(false);
	const lastAnchorPos = new THREE.Vector3();
	let poseEma = 1;
	let readySince = 0;
	const PRECISE_ENTER = 0.006; // ~6 mm/frame drift on a ~1 m wall
	const PRECISE_EXIT = 0.018;
	const PRECISE_TIMEOUT_MS = 4000; // tracking held this long → good enough

	// overlay renderer: ONLY for the map-building wireframe on top of the feed
	let meshRenderer: THREE.WebGLRenderer | null = null;
	let meshScene: THREE.Scene | null = null;
	let meshCamera: THREE.OrthographicCamera | null = null;
	let meshGroup: THREE.Group | null = null;

	const remaining = $derived(profile ? profile.total_volume - profile.used_volume : 0);
	const meterPct = $derived(
		profile && profile.total_volume > 0
			? Math.max(0, Math.min(100, (remaining / profile.total_volume) * 100))
			: 0
	);

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 2600);
	}

	onMount(async () => {
		try {
			const userId = await ensureSession();
			void getProfile(userId).then((p) => (profile = p));
			const forceNew = Boolean(page.url.searchParams.get('new'));
			const gpsPromise = collectAveragedFix(3).then((f) => (gps = f ?? gps));

			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'environment', width: { ideal: 1920 } }
			});
			video.srcObject = stream;
			await video.play();
			phase = 'aim';

			if (!forceNew) {
				void gpsPromise.then(async () => {
					if (!gps || phase !== 'aim') return;
					try {
						const spots = await nearbySpots(gps.lat, gps.lon, 500);
						if (spots.length > 0 && phase === 'aim') {
							stopEverything();
							void goto(`/spots/${spots[0].id}`, { replaceState: true });
						}
					} catch {
						/* offline lookup — keep mapping locally */
					}
				});
			}

			// Automatic: a beat to aim/expose, then the wall is captured and mapped.
			setTimeout(() => {
				if (phase === 'aim') void buildMap();
			}, 1300);
		} catch (e) {
			phase = 'error';
			const err = e as { name?: string };
			errorMsg =
				err?.name === 'NotAllowedError'
					? 'Camera access denied — allow it in Settings and reload.'
					: e instanceof Error
						? e.message
						: String(e);
		}
	});

	async function captureFrame(src: HTMLVideoElement): Promise<Blob> {
		const maxEdge = 1280;
		const scale = Math.min(1, maxEdge / Math.max(src.videoWidth, src.videoHeight));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(src.videoWidth * scale);
		canvas.height = Math.round(src.videoHeight * scale);
		canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
		frameW = canvas.width;
		frameH = canvas.height;
		// Small grayscale-ready copy for the real feature-detection overlay
		const dScale = 420 / Math.max(canvas.width, canvas.height);
		const dc = document.createElement('canvas');
		dc.width = Math.max(2, Math.round(canvas.width * dScale));
		dc.height = Math.max(2, Math.round(canvas.height * dScale));
		const dctx = dc.getContext('2d', { willReadFrequently: true })!;
		dctx.drawImage(canvas, 0, 0, dc.width, dc.height);
		detectData = dctx.getImageData(0, 0, dc.width, dc.height);
		return await new Promise((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/jpeg', 0.85)
		);
	}

	/** Capture → compile the 3D map → boot tracking. Caulk unlocks at lock. */
	async function buildMap(sourceVideo?: HTMLVideoElement) {
		try {
			phase = 'building';
			buildPct = 0;
			frame = await captureFrame(sourceVideo ?? video);
			const compileInput = await downscaleJpeg(frame, 800);
			showMesh();
			const target = await compileWallTarget(compileInput, (p) => {
				buildPct = p;
				updateMesh(p);
			});
			hideMesh();

			// Wall row + assets persist in the background; strokes await spotPromise.
			if (!spotPromise) {
				const photo = frame;
				spotPromise = (async () => {
					gps = (await collectAveragedFix(1)) ?? gps;
					const { imagePath, targetPath } = await uploadSpotAssets(photo!, target);
					const spot = await createSpot({
						lat: gps?.lat ?? 0,
						lon: gps?.lon ?? 0,
						accuracy: gps?.accuracy ?? null,
						name: null,
						imagePath,
						targetPath
					});
					spotId = spot.id;
					return spot;
				})();
				spotPromise.catch(() => (spotPromise = null));
			}

			await bootTracking(URL.createObjectURL(target));
		} catch (e) {
			phase = 'error';
			errorMsg = errText(e);
		}
	}

	async function bootTracking(targetUrl: string) {
		// Raw preview camera off — MindAR takes over with the fresh map.
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		video.style.display = 'none';
		overlay.style.display = 'none';
		disposeMindar();

		const { MindARThree } = await import('$lib/vendor/mindar/mindar-image-three.prod.js');
		mindar = new MindARThree({
			container,
			imageTargetSrc: targetUrl,
			uiLoading: 'no',
			uiScanning: 'no',
			uiError: 'no',
			filterMinCF: 0.0001,
			filterBeta: 0.001
		});
		mindar.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.4));
		const anchor = mindar.addAnchor(0);
		anchorGroup = anchor.group;
		tapPlane = new THREE.Mesh(
			new THREE.PlaneGeometry(5, 5),
			new THREE.MeshBasicMaterial({ visible: false })
		);
		anchorGroup!.add(tapPlane);

		anchor.onTargetFound = () => {
			phase = 'ready';
			readySince = performance.now();
			poseEma = 0.05; // converge from near-threshold, not from 1
			clearTimeout(lockTimer);
		};
		anchor.onTargetLost = () => {
			if (phase === 'ready') phase = 'locking';
			armLockTimer();
		};

		await mindar.start();
		phase = 'locking';
		armLockTimer();
		const probe = new THREE.Vector3();
		mindar.renderer.setAnimationLoop(() => {
			if (phase === 'ready' && anchorGroup) {
				anchorGroup.getWorldPosition(probe);
				poseEma = poseEma * 0.85 + probe.distanceTo(lastAnchorPos) * 0.15;
				lastAnchorPos.copy(probe);
				precise =
					performance.now() - readySince > PRECISE_TIMEOUT_MS ||
					(precise ? poseEma < PRECISE_EXIT : poseEma < PRECISE_ENTER);
			} else {
				precise = false;
				poseEma = 1;
			}
			mindar.renderer.render(mindar.scene, mindar.camera);
		});
	}

	/** Map didn't lock in time → remap from what the camera sees NOW. */
	function armLockTimer() {
		clearTimeout(lockTimer);
		lockTimer = setTimeout(() => {
			if (phase !== 'locking') return;
			const mv = container.querySelector('video:not([style*="display: none"])') as
				| HTMLVideoElement
				| null;
			if (!mv || remapCount >= 4) return;
			remapCount += 1;
			spotPromise = null; // previous map never locked; replace the wall row
			spotId = null;
			void buildMap(mv);
		}, LOCK_TIMEOUT_MS);
	}

	function disposeMindar() {
		try {
			clearTimeout(lockTimer);
			mindar?.renderer?.setAnimationLoop(null);
			mindar?.stop();
			for (const v of Array.from(container?.querySelectorAll('video') ?? [])) {
				if (v === video) continue;
				const st = (v as HTMLVideoElement).srcObject as MediaStream | null;
				st?.getTracks().forEach((t) => t.stop());
				v.remove();
			}
			mindar?.renderer?.domElement?.remove();
		} catch {
			/* teardown must never throw */
		}
		mindar = null;
		anchorGroup = null;
		tapPlane = null;
	}

	// ---- Caulk in TRUE 3D: raycast onto the tracked wall plane ---------------

	function wallPoint(ev: PointerEvent): THREE.Vector3 | null {
		if (!mindar || !anchorGroup || !tapPlane) return null;
		const el = mindar.renderer.domElement as HTMLCanvasElement;
		const r = el.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((ev.clientX - r.left) / r.width) * 2 - 1,
			-(((ev.clientY - r.top) / r.height) * 2 - 1)
		);
		raycaster.setFromCamera(ndc, mindar.camera);
		const hits = raycaster.intersectObject(tapPlane, false);
		if (!hits.length) return null;
		return anchorGroup.worldToLocal(hits[0].point.clone());
	}

	function onDown(ev: PointerEvent) {
		// Only on a SUPERPRECISE, stabilized 3D plane.
		if (phase !== 'ready' || !precise || brush) return;
		const p = wallPoint(ev);
		if (!p || !anchorGroup) return;
		brush = new VoxelBrush(VOX_SIZE[thickness], depthCm / 100);
		anchorGroup.add(brush.group);
		brush.stampAt(p.x, p.y, CAULK_RADIUS[thickness]);
	}

	function onMove(ev: PointerEvent) {
		if (!brush) return;
		const p = wallPoint(ev);
		if (!p) return;
		brush.stampAt(p.x, p.y, CAULK_RADIUS[thickness]);
	}

	async function onUp() {
		if (!brush) return;
		const b = brush;
		brush = null;
		if (b.cells.length < 1) {
			b.dispose();
			return;
		}
		try {
			if (!spotPromise) throw new Error('wall not anchored yet');
			const spot = await spotPromise;
			const placed = await placeVoxels({
				spotId: spot.id,
				lat: spot.lat,
				lon: spot.lon,
				accuracy: gps?.accuracy ?? null,
				cells: b.cells,
				vox: VOX_SIZE[thickness],
				depth: depthCm / 100
			});
			if (profile) profile = await getProfile(profile.id);
			showToast(`−${fmtVolume(placed.volume_cm3)} · ${b.cells.length} voxels`);
		} catch (e) {
			b.dispose();
			const msg = errText(e);
			showToast(msg.includes('insufficient') ? 'Spray can is empty!' : msg);
		}
	}

	async function share() {
		if (!spotId) return;
		const url = `${location.origin}/spots/${spotId}`;
		try {
			if (navigator.share) await navigator.share({ title: 'ART wall', url });
			else {
				await navigator.clipboard.writeText(url);
				showToast('Link copied');
			}
		} catch {
			/* cancelled */
		}
	}

	// ---- map-building mesh: REAL detected wall features, drawn over the feed --

	function showMesh() {
		if (!meshRenderer) {
			meshRenderer = new THREE.WebGLRenderer({ canvas: overlay, alpha: true, antialias: true });
			meshRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			meshRenderer.setSize(window.innerWidth, window.innerHeight);
			meshScene = new THREE.Scene();
			const w = window.innerWidth;
			const h = window.innerHeight;
			meshCamera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 100);
			meshCamera.position.z = 10;
			meshRenderer.setAnimationLoop(() => {
				if (meshRenderer && meshScene && meshCamera)
					meshRenderer.render(meshScene, meshCamera);
			});
		}
		overlay.style.display = 'block';
		hideMesh();
		if (!detectData) return;

		// Real Shi-Tomasi corners on the captured wall frame, Delaunay-meshed.
		const feats = detectFeatures(detectData, 300);
		featureCount = feats.length;
		const edges = triangulate(feats);
		// Points reveal strongest-first; an edge appears once both ends exist.
		edges.sort((a, b) => Math.max(a[0], a[1]) - Math.max(b[0], b[1]));

		// Map detection-image px → screen px with the video's object-fit: cover
		const w = window.innerWidth;
		const h = window.innerHeight;
		const s = Math.max(w / detectData.width, h / detectData.height);
		const offX = (w - detectData.width * s) / 2;
		const offY = (h - detectData.height * s) / 2;
		const ox = (f: { x: number; y: number }) => offX + f.x * s - w / 2;
		const oy = (f: { x: number; y: number }) => h / 2 - (offY + f.y * s);

		meshGroup = new THREE.Group();
		const pos: number[] = [];
		const edgeMaxRank: number[] = [];
		for (const [a, b] of edges) {
			pos.push(ox(feats[a]), oy(feats[a]), 1, ox(feats[b]), oy(feats[b]), 1);
			edgeMaxRank.push(Math.max(a, b));
		}
		const lgeo = new THREE.BufferGeometry();
		lgeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		const lines = new THREE.LineSegments(
			lgeo,
			new THREE.LineBasicMaterial({ color: 0x7b61ff, transparent: true, opacity: 0.5 })
		);
		meshGroup.add(lines);
		const ppos: number[] = [];
		for (const f of feats) ppos.push(ox(f), oy(f), 2);
		const pgeo = new THREE.BufferGeometry();
		pgeo.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
		const pts = new THREE.Points(
			pgeo,
			new THREE.PointsMaterial({ color: 0xffffff, size: 3.5, transparent: true, opacity: 0.9 })
		);
		meshGroup.add(pts);
		meshGroup.userData = { lines, pts, pointCount: feats.length, edgeMaxRank };
		meshScene!.add(meshGroup);
		updateMesh(0);
	}

	function updateMesh(pct: number) {
		if (!meshGroup) return;
		const { lines, pts, pointCount, edgeMaxRank } = meshGroup.userData as {
			lines: THREE.LineSegments;
			pts: THREE.Points;
			pointCount: number;
			edgeMaxRank: number[];
		};
		const shown = Math.floor((pointCount * pct) / 100);
		pts.geometry.setDrawRange(0, shown);
		let edgeCount = 0;
		while (edgeCount < edgeMaxRank.length && edgeMaxRank[edgeCount] < shown) edgeCount++;
		lines.geometry.setDrawRange(0, edgeCount * 2);
	}

	function hideMesh() {
		meshGroup?.parent?.remove(meshGroup);
		meshGroup = null;
	}

	function stopEverything() {
		clearTimeout(lockTimer);
		clearTimeout(toastTimer);
		meshRenderer?.setAnimationLoop(null);
		meshRenderer?.dispose();
		meshRenderer = null;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		disposeMindar();
	}

	onDestroy(stopEverything);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="spray-root"
	bind:this={container}
	onpointerdown={onDown}
	onpointermove={onMove}
	onpointerup={onUp}
	onpointercancel={onUp}
>
	<!-- svelte-ignore a11y_media_has_caption -->
	<video bind:this={video} playsinline muted></video>
	<canvas bind:this={overlay} class="mesh-overlay"></canvas>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="hud top" onpointerdown={(e) => e.stopPropagation()}>
		<button class="chip" onclick={() => goto('/')}>‹</button>
		<span class="chip status" class:ready={phase === 'ready'}>
			{#if phase === 'boot'}Starting…
			{:else if phase === 'aim'}MAPPING WALL…
			{:else if phase === 'building'}BUILDING 3D MAP · {buildPct.toFixed(0)}%{featureCount
					? ` · ${Math.floor((featureCount * buildPct) / 100)} pts`
					: ''}
			{:else if phase === 'locking'}{remapCount > 0 ? 'REMAPPING · ' : ''}LOCKING…
			{:else if phase === 'ready'}{precise ? 'SUPERPRECISE ✓' : 'STABILIZING…'}{/if}
		</span>
		{#if spotId}
			<button class="chip" onclick={share}>share</button>
		{/if}
	</div>

	{#if profile && phase !== 'boot' && phase !== 'error'}
		<div class="meter" aria-hidden="true">
			<span class="meter-label">VOLUME</span>
			<div class="meter-bar"><div class="meter-fill" style="height: {meterPct}%"></div></div>
			<span class="meter-pct">{meterPct.toFixed(0)}%</span>
		</div>
	{/if}

	{#if phase === 'ready' || phase === 'locking'}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="hud bottom" onpointerdown={(e) => e.stopPropagation()}>
			<label class="depth">
				<span class="depth-label">DEPTH</span>
				<input type="range" min="-5" max="15" step="1" bind:value={depthCm} />
				<span class="depth-val">{depthCm} cm</span>
			</label>
			<div class="thickness">
				{#each ['thin', 'medium', 'thick'] as const as t}
					<button class="thick-btn" class:active={thickness === t} onclick={() => (thickness = t)}>
						<span class="dot {t}"></span>
						{t}
					</button>
				{/each}
			</div>
			<p class="tip">
				{phase !== 'ready'
					? 'Hold the camera on the wall you mapped…'
					: precise
						? 'Build on the wall — layer over layer'
						: 'Hold still — stabilizing the plane…'}
			</p>
		</div>
	{/if}

	{#if phase === 'error'}
		<div class="center">
			<p>{errorMsg}</p>
			<button class="cta" onclick={() => location.reload()}>Retry</button>
		</div>
	{/if}

	{#if toast}<div class="toast">{toast}</div>{/if}
</div>

<style>
	.spray-root {
		position: fixed;
		inset: 0;
		background: #000;
		overflow: hidden;
		touch-action: none;
	}
	video {
		object-fit: cover;
	}
	.spray-root :global(video),
	.spray-root :global(canvas) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.mesh-overlay {
		pointer-events: none;
		z-index: 3;
		display: none;
	}
	.hud {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem;
		z-index: 10;
	}
	.hud.top {
		top: env(safe-area-inset-top);
		align-items: center;
	}
	.hud.bottom {
		bottom: calc(env(safe-area-inset-bottom) + 0.75rem);
		flex-direction: column;
		align-items: stretch;
	}
	.chip {
		background: rgba(11, 11, 15, 0.75);
		color: var(--text);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		padding: 0.4rem 0.9rem;
		font-size: 0.85rem;
		backdrop-filter: blur(8px);
	}
	.chip.status {
		flex: 1;
		text-align: center;
		letter-spacing: 0.04em;
	}
	.chip.status.ready {
		color: #4ade80;
		border-color: rgba(74, 222, 128, 0.5);
	}
	.meter {
		position: absolute;
		left: 0.9rem;
		top: 50%;
		transform: translateY(-38%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		z-index: 8;
		pointer-events: none;
	}
	.meter-label {
		font-size: 0.6rem;
		letter-spacing: 0.12em;
		color: var(--text);
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
	}
	.meter-bar {
		width: 0.85rem;
		height: 7.5rem;
		border-radius: 999px;
		background: rgba(11, 11, 15, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.25);
		overflow: hidden;
		display: flex;
		align-items: flex-end;
	}
	.meter-fill {
		width: 100%;
		background: linear-gradient(180deg, var(--accent-2), var(--accent));
		transition: height 0.3s ease;
	}
	.meter-pct {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text);
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
	}
	.depth {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		background: rgba(11, 11, 15, 0.7);
		border-radius: 999px;
		padding: 0.35rem 0.9rem;
	}
	.depth-label {
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		color: var(--muted);
	}
	.depth input {
		flex: 1;
		accent-color: var(--accent);
	}
	.depth-val {
		font-size: 0.78rem;
		font-weight: 700;
		min-width: 3.2rem;
		text-align: right;
	}
	.thickness {
		display: flex;
		gap: 0.5rem;
	}
	.thick-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		background: rgba(11, 11, 15, 0.75);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.9rem;
		color: var(--text);
		padding: 0.6rem;
		font-size: 0.85rem;
		text-transform: capitalize;
	}
	.thick-btn.active {
		background: rgba(123, 97, 255, 0.35);
		border-color: var(--accent);
	}
	.dot {
		background: #fff;
		border-radius: 999px;
	}
	.dot.thin {
		width: 0.4rem;
		height: 0.4rem;
	}
	.dot.medium {
		width: 1.6rem;
		height: 0.5rem;
	}
	.dot.thick {
		width: 2.4rem;
		height: 0.6rem;
	}
	.tip {
		color: var(--text);
		background: rgba(11, 11, 15, 0.7);
		border-radius: 999px;
		padding: 0.45rem 1rem;
		font-size: 0.9rem;
		margin: 0 auto;
	}
	.cta {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #0b0b0f;
		font-weight: 800;
		font-size: 1.15rem;
		border: none;
		border-radius: 1rem;
		padding: 1.1rem 2.5rem;
	}
	.center {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		z-index: 5;
		color: var(--text);
		text-align: center;
		padding: 2rem;
		background: rgba(0, 0, 0, 0.45);
	}
	.toast {
		position: absolute;
		top: calc(env(safe-area-inset-top) + 4rem);
		left: 50%;
		transform: translateX(-50%);
		background: rgba(11, 11, 15, 0.9);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		padding: 0.5rem 1.1rem;
		font-size: 0.9rem;
		z-index: 30;
		white-space: nowrap;
	}
</style>
