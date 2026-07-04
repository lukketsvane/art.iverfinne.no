<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot, placeVoxels, getProfile, errText } from '$lib/api';
	import { VoxelBrush } from '$lib/voxel';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix, downscaleJpeg } from '$lib/spots';
	import { triangulate, avgLuminance, type Feature } from '$lib/mesh';
	import { sampleFrame, burstSample, encodeSample, type FrameSample } from '$lib/wallmap';

	import { fmtVolume, fmtArt, toArt, USD_PER_ART, type Profile, type Spot } from '$lib/types';

	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };
	const VOX_SIZE: Record<Thickness, number> = { thin: 0.012, medium: 0.024, thick: 0.04 };
	const LOCK_TIMEOUT_MS = 7000;
	const DEPTH_SEGMENTS = 12;

	let video: HTMLVideoElement;
	let overlay: HTMLCanvasElement;
	let container: HTMLDivElement;
	let stream: MediaStream | null = null;

	// boot → aim (auto-capture) → building (compile+mesh) → locking → ready
	let phase = $state<'boot' | 'aim' | 'building' | 'locking' | 'ready' | 'error'>('boot');
	let buildPct = $state(0);
	let remapCount = $state(0);
	let thickness = $state<Thickness>('medium');
	let errorMsg = $state('');
	let toast = $state('');
	let profile = $state<Profile | null>(null);
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);

	let frame: Blob | null = null; // 1280px reference photo
	let detectData: ImageData | null = null; // small copy the CV ran on
	let featureCount = $state(0);

	// Scanner: live feature detection on the feed; best-scoring frame wins.
	const MIN_FEATURES = 70;
	const SCAN_TICK_MS = 350;
	const SCAN_GIVE_UP_MS = 8000; // then take the best frame seen so far
	let scanTimer: ReturnType<typeof setInterval> | undefined;
	let scanStart = 0;
	let goodStreak = 0;
	let bestSample: FrameSample | null = null;

	// The wall's DB row is created in the background; strokes await it.
	let spotPromise: Promise<Spot> | null = null;
	let spotId = $state<string | null>(null);

	// MindAR (true 3D: strokes live in the tracked anchor's space)
	let mindar: any = null;
	let anchorGroup: THREE.Group | null = null;
	let tapPlane: THREE.Mesh | null = null;
	const raycaster = new THREE.Raycaster();
	let lockTimer: ReturnType<typeof setTimeout> | undefined;

	// Pending bead (anchor space): strokes accumulate, EXTRUDE commits.
	let brush: VoxelBrush | null = null;
	let drawing = false;
	let pendingCells = $state(0);
	let extrudePct = $state(0);
	let committing = $state(false);
	let activeVox = $state(VOX_SIZE.medium);
	let extrudeTimer: ReturnType<typeof setInterval> | undefined;
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
	const pendingVolCm3 = $derived(
		pendingCells ? Math.max(10, Math.round(pendingCells * activeVox ** 3 * 1e6)) : 0
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

			// Live scan: features draw on the feed as they're detected; capture
			// fires once the wall shows enough trackable detail (or times out
			// onto the best frame seen).
			startScanning();
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

	/** Live scan loop: detect features on the feed, capture when it's good. */
	function startScanning() {
		clearInterval(scanTimer);
		goodStreak = 0;
		bestSample = null;
		scanStart = performance.now();
		scanTimer = setInterval(() => {
			if (phase !== 'aim') {
				clearInterval(scanTimer);
				return;
			}
			const s = sampleFrame(video);
			if (!s) return;
			if (!bestSample || s.score > bestSample.score) bestSample = s;
			renderFeatureMesh(s.detect, s.features, 100);
			goodStreak = s.features.length >= MIN_FEATURES ? goodStreak + 1 : 0;
			if (goodStreak >= 2 || performance.now() - scanStart > SCAN_GIVE_UP_MS) {
				void buildMap();
			}
		}, SCAN_TICK_MS);
	}

	function makeWallFrame(aspect: number): THREE.Group {
		const g = new THREE.Group();
		const hw = 0.5;
		const hh = Math.max(0.2, aspect / 2);
		const corners: Array<[number, number]> = [
			[-hw, -hh],
			[hw, -hh],
			[hw, hh],
			[-hw, hh]
		];
		const geo = new THREE.BufferGeometry().setFromPoints(
			[...corners, corners[0]].map(([x, y]) => new THREE.Vector3(x, y, 0))
		);
		const line = new THREE.Line(
			geo,
			new THREE.LineDashedMaterial({
				color: 0x7b61ff,
				dashSize: 0.03,
				gapSize: 0.022,
				transparent: true,
				opacity: 0.8
			})
		);
		line.computeLineDistances();
		g.add(line);
		const dotGeo = new THREE.SphereGeometry(0.011, 10, 8);
		const dotMat = new THREE.MeshBasicMaterial({ color: 0x8b7bff });
		for (const [x, y] of corners) {
			const d = new THREE.Mesh(dotGeo, dotMat);
			d.position.set(x, y, 0);
			g.add(d);
		}
		return g;
	}

	/** Best frame → compile the 3D map → boot tracking. Caulk unlocks at lock. */
	async function buildMap(sourceVideo?: HTMLVideoElement) {
		try {
			clearInterval(scanTimer);
			clearPending();
			phase = 'building';
			buildPct = 0;
			let sample = bestSample;
			bestSample = null;
			if (sourceVideo || !sample) sample = await burstSample(sourceVideo ?? video, 3);
			if (!sample) throw new Error('camera not ready — try again');
			frame = await encodeSample(sample);
			detectData = sample.detect;
			const compileInput = await downscaleJpeg(frame, 800);
			renderFeatureMesh(sample.detect, sample.features, 0);
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
		// Light the caulk like the room, not like a showroom: a dim scene gets
		// dim paint, otherwise the blobs glow like stickers pasted on the feed.
		const lum = detectData ? avgLuminance(detectData) : 0.45;
		mindar.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.5 + 2.6 * lum));
		const key = new THREE.DirectionalLight(0xffffff, 0.2 + 1.1 * lum);
		key.position.set(0.6, 1, 1.2);
		mindar.scene.add(key);
		const anchor = mindar.addAnchor(0);
		anchorGroup = anchor.group;
		tapPlane = new THREE.Mesh(
			new THREE.PlaneGeometry(5, 5),
			new THREE.MeshBasicMaterial({ visible: false })
		);
		anchorGroup!.add(tapPlane);
		// Dashed registration frame glued to the mapped wall — the honest 3D
		// cue: it holds perspective and parallax with the physical surface.
		anchorGroup!.add(makeWallFrame(detectData ? detectData.height / detectData.width : 0.75));

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

	function syncPending() {
		pendingCells = brush?.cells.length ?? 0;
		extrudePct = brush ? (brush.maxHeight() / brush.maxLayerCount) * 100 : 0;
	}

	function onDown(ev: PointerEvent) {
		// Only on a locked, stabilized 3D plane.
		if (phase !== 'ready' || !precise || committing) return;
		const p = wallPoint(ev);
		if (!p || !anchorGroup) return;
		if (!brush) {
			activeVox = VOX_SIZE[thickness];
			brush = new VoxelBrush(activeVox, 0, DEPTH_SEGMENTS);
			anchorGroup.add(brush.group);
		}
		drawing = true;
		brush.stampTo(p.x, p.y, CAULK_RADIUS[thickness]);
		syncPending();
	}

	function onMove(ev: PointerEvent) {
		if (!drawing || !brush) return;
		const p = wallPoint(ev);
		if (!p) return;
		brush.stampTo(p.x, p.y, CAULK_RADIUS[thickness]);
		syncPending();
	}

	function onUp() {
		drawing = false;
		brush?.endStroke();
	}

	function clearPending() {
		clearInterval(extrudeTimer);
		brush?.dispose();
		brush = null;
		drawing = false;
		pendingCells = 0;
		extrudePct = 0;
	}

	function extrudeDown(ev: PointerEvent) {
		ev.stopPropagation();
		if (!brush || committing) return;
		(ev.target as HTMLElement)?.setPointerCapture?.(ev.pointerId);
		clearInterval(extrudeTimer);
		extrudeTimer = setInterval(() => {
			if (!brush || !brush.extrude()) {
				clearInterval(extrudeTimer);
				return;
			}
			syncPending();
		}, 220);
	}

	async function extrudeUp() {
		clearInterval(extrudeTimer);
		extrudeTimer = undefined;
		await commit();
	}

	/** Persist the pending bead; the committed mesh stays on the wall. */
	async function commit() {
		if (!brush || committing) return;
		if (brush.cells.length < 1) {
			clearPending();
			return;
		}
		const b = brush;
		committing = true;
		try {
			if (!spotPromise) throw new Error('wall not anchored yet');
			const spot = await spotPromise;
			const placed = await placeVoxels({
				spotId: spot.id,
				lat: spot.lat,
				lon: spot.lon,
				accuracy: gps?.accuracy ?? null,
				cells: b.cells,
				vox: activeVox,
				depth: 0
			});
			brush = null; // committed bead stays rendered in anchor space
			pendingCells = 0;
			extrudePct = 0;
			if (profile) profile = await getProfile(profile.id);
			showToast(`−${fmtVolume(placed.volume_cm3)} · placed`);
		} catch (e) {
			clearPending();
			const msg = errText(e);
			showToast(
				msg.includes('insufficient')
					? 'Spray can is empty!'
					: /schema|function|pgrst/i.test(msg)
						? 'Save failed — reload the app and try again'
						: /fetch|network|load failed/i.test(msg)
							? 'Offline — stroke not saved'
							: msg
			);
		} finally {
			committing = false;
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

	// ---- live wall mesh: REAL detected features, drawn over the feed ---------

	function ensureOverlay() {
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
	}

	function renderFeatureMesh(detect: ImageData, feats: Feature[], revealPct: number) {
		ensureOverlay();
		hideMesh();
		featureCount = feats.length;
		const edges = triangulate(feats);
		// Points reveal strongest-first; an edge appears once both ends exist.
		edges.sort((a, b) => Math.max(a[0], a[1]) - Math.max(b[0], b[1]));

		// Map detection-image px → screen px with the video's object-fit: cover
		const w = window.innerWidth;
		const h = window.innerHeight;
		const s = Math.max(w / detect.width, h / detect.height);
		const offX = (w - detect.width * s) / 2;
		const offY = (h - detect.height * s) / 2;
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
		updateMesh(revealPct);
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
		if (!meshGroup) return;
		meshGroup.parent?.remove(meshGroup);
		// The scanner rebuilds this a few times per second — free GPU buffers.
		for (const obj of meshGroup.children as Array<THREE.LineSegments | THREE.Points>) {
			obj.geometry.dispose();
			(obj.material as THREE.Material).dispose();
		}
		meshGroup = null;
	}

	function stopEverything() {
		clearInterval(scanTimer);
		clearInterval(extrudeTimer);
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
		<div class="pill" class:live={phase === 'ready' && precise}>
			<span class="pill-dot"></span>
			<span class="pill-lines">
				{#if phase === 'boot'}<strong>STARTING</strong><small>camera…</small>
				{:else if phase === 'aim'}<strong>SCANNING WALL</strong><small>{featureCount} pts live</small>
				{:else if phase === 'building'}<strong>BUILDING 3D MAP</strong><small
						>{buildPct.toFixed(0)}% · {Math.floor((featureCount * buildPct) / 100)} pts</small>
				{:else if phase === 'locking'}<strong>{remapCount > 0 ? 'REMAPPING' : 'LOCKING'}</strong><small
						>hold on the wall</small>
				{:else if phase === 'ready'}<strong>{precise ? 'WALL LOCKED' : 'STABILIZING'}</strong><small
						>{precise ? '3D wall live' : 'hold still…'}</small>{/if}
			</span>
		</div>
		{#if spotId}
			<button class="chip" onclick={share}>share</button>
		{/if}
	</div>

	{#if phase === 'aim'}
		<div class="hud bottom">
			<p class="tip">
				{featureCount >= MIN_FEATURES
					? 'Good wall — locking on…'
					: 'Aim at a textured wall — more detail, better lock'}
			</p>
		</div>
	{/if}

	{#if phase === 'ready' || phase === 'locking'}
		<div class="depth-meter" aria-hidden="true">
			<span class="dm-label">DEPTH</span>
			<div class="dm-track">
				{#each Array(DEPTH_SEGMENTS) as _, i (i)}
					<span
						class="dm-seg"
						class:on={extrudePct >= ((DEPTH_SEGMENTS - i) / DEPTH_SEGMENTS) * 100 - 0.5}
					></span>
				{/each}
			</div>
			<span class="dm-pct">{extrudePct.toFixed(0)}%</span>
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="hud bottom" onpointerdown={(e) => e.stopPropagation()}>
			{#if phase !== 'ready' || !precise}
				<p class="tip">
					{phase !== 'ready'
						? 'Hold the camera on the wall you mapped…'
						: 'Hold still — locking the wall…'}
				</p>
			{:else if !pendingCells}
				<p class="tip">Draw on the wall, then hold EXTRUDE</p>
			{/if}
			<div class="thickness">
				{#each ['thin', 'medium', 'thick'] as const as t}
					<button class="thick-btn" class:active={thickness === t} onclick={() => (thickness = t)}>
						<span class="dot {t}"></span>
						{t}
					</button>
				{/each}
			</div>
			<div class="board">
				<div class="stat">
					<span class="stat-label">VOLUME COST</span>
					<strong class="stat-big">{(toArt(pendingVolCm3) * 100).toFixed(0)}%</strong>
					<small>~{toArt(pendingVolCm3).toFixed(2)} ART</small>
				</div>
				<div class="stat">
					<span class="stat-label">BALANCE</span>
					<strong class="stat-big">{fmtArt(remaining)} ART</strong>
					<small>≈ ${(toArt(remaining) * USD_PER_ART).toFixed(2)}</small>
				</div>
				<button
					class="extrude"
					disabled={!pendingCells || committing}
					onpointerdown={extrudeDown}
					onpointerup={extrudeUp}
					onpointercancel={extrudeUp}
				>
					{committing ? 'SAVING…' : 'EXTRUDE'}
					<small>{pendingCells ? 'HOLD TO EXTRUDE' : 'DRAW FIRST'}</small>
				</button>
			</div>
		</div>
		{#if pendingCells && !committing}
			<button
				class="undo"
				onpointerdown={(e) => e.stopPropagation()}
				onclick={clearPending}
				aria-label="discard pending bead">✕</button>
		{/if}
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
	/* Status pill: live dot + two lines, like the mock's VPS LOCKED chip */
	.pill {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		justify-content: center;
		background: rgba(10, 10, 14, 0.82);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		padding: 0.45rem 1rem;
		backdrop-filter: blur(10px);
	}
	.pill-dot {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 10px var(--accent);
		flex-shrink: 0;
	}
	.pill.live .pill-dot {
		background: #4ade80;
		box-shadow: 0 0 10px #4ade80;
	}
	.pill-lines {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		line-height: 1.15;
	}
	.pill-lines strong {
		font-size: 0.82rem;
		letter-spacing: 0.06em;
		color: var(--accent-2, #a78bfa);
	}
	.pill.live .pill-lines strong {
		color: #e9e6ff;
	}
	.pill-lines small {
		font-size: 0.68rem;
		color: var(--muted);
	}

	/* Segmented DEPTH meter (fills while holding EXTRUDE) */
	.depth-meter {
		position: absolute;
		left: 0.9rem;
		bottom: calc(env(safe-area-inset-bottom) + 13.5rem);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		z-index: 8;
		pointer-events: none;
	}
	.dm-label {
		font-size: 0.6rem;
		letter-spacing: 0.14em;
		color: var(--text);
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
	}
	.dm-track {
		display: flex;
		flex-direction: column;
		gap: 0.22rem;
		background: rgba(10, 10, 14, 0.75);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 999px;
		padding: 0.45rem 0.35rem;
	}
	.dm-seg {
		width: 0.95rem;
		height: 0.42rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.14);
	}
	.dm-seg.on {
		background: var(--accent);
		box-shadow: 0 0 6px rgba(123, 97, 255, 0.7);
	}
	.dm-pct {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--accent-2, #a78bfa);
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
	}

	/* Bottom board: VOLUME COST | BALANCE | EXTRUDE */
	.board {
		display: flex;
		align-items: stretch;
		gap: 0.9rem;
		background: rgba(10, 10, 14, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 1.4rem;
		padding: 0.9rem 1.1rem;
		backdrop-filter: blur(12px);
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		justify-content: center;
		min-width: 0;
	}
	.stat + .stat {
		border-left: 1px solid rgba(255, 255, 255, 0.12);
		padding-left: 0.9rem;
	}
	.stat-label {
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		color: var(--muted);
		white-space: nowrap;
	}
	.stat-big {
		font-size: 1.25rem;
		font-weight: 800;
		color: var(--accent-2, #a78bfa);
		white-space: nowrap;
	}
	.stat small {
		font-size: 0.7rem;
		color: var(--muted);
		white-space: nowrap;
	}
	.extrude {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.15rem;
		border: none;
		border-radius: 1.1rem;
		background: linear-gradient(135deg, #6d5ef6, #8b7bff);
		color: #fff;
		font-weight: 800;
		font-size: 1.05rem;
		letter-spacing: 0.05em;
		padding: 0.8rem 1rem;
		touch-action: none;
	}
	.extrude small {
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		opacity: 0.8;
	}
	.extrude:disabled {
		opacity: 0.45;
	}
	.undo {
		position: absolute;
		bottom: calc(env(safe-area-inset-bottom) + 12.2rem);
		left: 50%;
		transform: translateX(-50%);
		width: 2.6rem;
		height: 2.6rem;
		border-radius: 999px;
		background: rgba(10, 10, 14, 0.85);
		border: 1.5px solid var(--accent);
		color: var(--text);
		font-size: 1rem;
		z-index: 11;
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
