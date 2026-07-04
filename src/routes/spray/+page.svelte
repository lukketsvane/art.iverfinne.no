<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot, placeCaulk, getProfile } from '$lib/api';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix, downscaleJpeg } from '$lib/spots';
	import { caulkMaterial, buildCaulk } from '$lib/library';
	import { fmtVolume, type Profile, type Spot } from '$lib/types';

	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };
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
	let stroke: Array<[number, number]> | null = null;
	let strokePreview: THREE.Group | null = null;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

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
			errorMsg = e instanceof Error ? e.message : String(e);
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
			clearTimeout(lockTimer);
		};
		anchor.onTargetLost = () => {
			if (phase === 'ready') phase = 'locking';
			armLockTimer();
		};

		await mindar.start();
		phase = 'locking';
		armLockTimer();
		mindar.renderer.setAnimationLoop(() => {
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
		if (phase !== 'ready' || stroke) return;
		const p = wallPoint(ev);
		if (!p || !anchorGroup) return;
		stroke = [[p.x, p.y]];
		strokePreview = new THREE.Group();
		anchorGroup.add(strokePreview);
		addBead(p.x, p.y);
	}

	function onMove(ev: PointerEvent) {
		if (!stroke || !strokePreview) return;
		const p = wallPoint(ev);
		if (!p) return;
		const last = stroke[stroke.length - 1];
		const r = CAULK_RADIUS[thickness];
		if (Math.hypot(p.x - last[0], p.y - last[1]) < r * 0.6 || stroke.length >= 200) return;
		stroke.push([p.x, p.y]);
		addBead(p.x, p.y);
	}

	function addBead(x: number, y: number) {
		if (!strokePreview) return;
		const r = CAULK_RADIUS[thickness];
		const bead = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), caulkMaterial());
		bead.position.set(x, y, depthCm / 100 + r * 0.2);
		strokePreview.add(bead);
	}

	async function onUp() {
		if (!stroke) return;
		const points = stroke;
		const preview = strokePreview;
		stroke = null;
		strokePreview = null;
		if (points.length < 2 || !anchorGroup) {
			preview?.parent?.remove(preview);
			return;
		}
		const r = CAULK_RADIUS[thickness];
		const z = depthCm / 100;
		// Bead preview → smooth tube, in anchor (wall) space.
		preview?.parent?.remove(preview);
		const tube = buildCaulk(points, r, z);
		anchorGroup.add(tube);
		try {
			if (!spotPromise) throw new Error('wall not anchored yet');
			const spot = await spotPromise;
			const placed = await placeCaulk({
				spotId: spot.id,
				lat: spot.lat,
				lon: spot.lon,
				accuracy: gps?.accuracy ?? null,
				points,
				radius: r,
				depth: z
			});
			if (profile) profile = await getProfile(profile.id);
			showToast(`−${fmtVolume(placed.volume_cm3)}`);
		} catch (e) {
			tube.parent?.remove(tube);
			const msg = e instanceof Error ? e.message : String(e);
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

	// ---- map-building wireframe (drawn on top of the live feed) --------------

	function rnd(k: number): number {
		const x = Math.sin(k * 12.9898) * 43758.5453;
		return x - Math.floor(x);
	}

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
		meshGroup = new THREE.Group();
		const w = window.innerWidth;
		const h = window.innerHeight;
		const cols = 13;
		const rows = 21;
		const jit = (i: number, j: number, k: number) =>
			(rnd(i * 37.1 + j * 17.7 + k * 5.3) - 0.5) * (w / cols) * 0.4;
		const vx = (i: number, j: number): [number, number] => [
			-w / 2 + (i * w) / cols + jit(i, j, 1),
			h / 2 - (j * h) / rows + jit(i, j, 2)
		];
		const pos: number[] = [];
		for (let j = 0; j <= rows; j++)
			for (let i = 0; i < cols; i++) {
				const a = vx(i, j);
				const b = vx(i + 1, j);
				pos.push(a[0], a[1], 1, b[0], b[1], 1);
			}
		for (let i = 0; i <= cols; i++)
			for (let j = 0; j < rows; j++) {
				const a = vx(i, j);
				const b = vx(i, j + 1);
				pos.push(a[0], a[1], 1, b[0], b[1], 1);
			}
		const lgeo = new THREE.BufferGeometry();
		lgeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		const lines = new THREE.LineSegments(
			lgeo,
			new THREE.LineBasicMaterial({ color: 0x7b61ff, transparent: true, opacity: 0.5 })
		);
		meshGroup.add(lines);
		const ppos: number[] = [];
		const pointCount = 260;
		for (let k = 0; k < pointCount; k++)
			ppos.push((rnd(k + 1) - 0.5) * w, (rnd(k * 3 + 2) - 0.5) * h, 2);
		const pgeo = new THREE.BufferGeometry();
		pgeo.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
		const pts = new THREE.Points(
			pgeo,
			new THREE.PointsMaterial({ color: 0xffffff, size: 3.5, transparent: true, opacity: 0.9 })
		);
		meshGroup.add(pts);
		meshGroup.userData = { lines, pts, lineVerts: pos.length / 3, pointCount };
		meshScene!.add(meshGroup);
		updateMesh(0);
	}

	function updateMesh(pct: number) {
		if (!meshGroup) return;
		const { lines, pts, lineVerts, pointCount } = meshGroup.userData as {
			lines: THREE.LineSegments;
			pts: THREE.Points;
			lineVerts: number;
			pointCount: number;
		};
		lines.geometry.setDrawRange(0, Math.floor((lineVerts * pct) / 100 / 2) * 2);
		pts.geometry.setDrawRange(0, Math.floor((pointCount * pct) / 100));
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
			{:else if phase === 'building'}BUILDING 3D MAP · {buildPct.toFixed(0)}%
			{:else if phase === 'locking'}{remapCount > 0 ? 'REMAPPING · ' : ''}LOCKING…
			{:else if phase === 'ready'}3D MAP LOCKED{/if}
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
				{phase === 'ready'
					? 'Draw directly on the wall'
					: 'Hold the camera on the wall you mapped…'}
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
