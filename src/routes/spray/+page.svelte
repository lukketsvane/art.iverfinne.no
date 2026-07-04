<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot, placeCaulk, getProfile } from '$lib/api';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix } from '$lib/spots';
	import { caulkMaterial, caulkJitter, buildCaulk } from '$lib/library';
	import { fmtVolume, type Profile } from '$lib/types';

	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };

	let video: HTMLVideoElement;
	let overlay: HTMLCanvasElement;
	let stream: MediaStream | null = null;

	let phase = $state<'boot' | 'live' | 'drawing' | 'saving' | 'error'>('boot');
	let thickness = $state<Thickness>('medium');
	let depthCm = $state(3); // stand-off from the wall, in image-percent 'cm'
	let errorMsg = $state('');
	let saveLabel = $state('');
	let progress = $state(0);
	let strokeCount = $state(0);
	let pendingCost = $state(0);
	let profile = $state<Profile | null>(null);
	let holding = $state(false);
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);
	let holdTimer: ReturnType<typeof setTimeout> | undefined;

	const remaining = $derived(profile ? profile.total_volume - profile.used_volume : 0);
	const meterPct = $derived(
		profile && profile.total_volume > 0
			? Math.max(0, Math.min(100, ((remaining - pendingCost) / profile.total_volume) * 100))
			: 0
	);
	const costPct = $derived(remaining > 0 ? Math.min(100, (pendingCost / remaining) * 100) : 0);

	// Frozen-frame drawing state
	let frame: Blob | null = null;
	let frameW = 0;
	let frameH = 0;
	let strokes: Array<{ points: Array<[number, number]>; r: number; z: number }> = [];
	let current: Array<[number, number]> | null = null;

	// three.js screen-space overlay (glossy caulk look without tracking)
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.OrthographicCamera | null = null;
	let strokeGroups: THREE.Group[] = [];
	let currentGroup: THREE.Group | null = null;
	let blobIndex = 0;
	let meshGroup: THREE.Group | null = null;

	function rnd(k: number): number {
		const x = Math.sin(k * 12.9898) * 43758.5453;
		return x - Math.floor(x);
	}

	/** Blueprint mesh: violet wireframe + feature points revealed with progress. */
	function showMesh() {
		if (!scene) return;
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
		scene.add(meshGroup);
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

	onMount(async () => {
		try {
			const userId = await ensureSession();
			void getProfile(userId).then((p) => (profile = p));
			const forceNew = Boolean(page.url.searchParams.get('new'));
			const gpsPromise = collectAveragedFix(forceNew ? 2 : 3).then((f) => (gps = f ?? gps));
			const mediaStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'environment', width: { ideal: 1920 } }
			});
			const fix = forceNew ? null : await gpsPromise.then(() => gps);

			// Auto-access: if a tracked wall is nearby, use it — invisible redirect.
			// ?new=1 skips this (came here to spray a DIFFERENT wall).
			if (fix && !forceNew) {
				try {
					const spots = await nearbySpots(fix.lat, fix.lon, 500);
					if (spots.length > 0) {
						mediaStream.getTracks().forEach((t) => t.stop());
						await goto(`/spots/${spots[0].id}`, { replaceState: true });
						return;
					}
				} catch {
					/* nearby lookup down — carry on, drawing still works */
				}
			}

			stream = mediaStream;
			video.srcObject = stream;
			await video.play();
			initOverlay();
			phase = 'live';
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

	function initOverlay() {
		renderer = new THREE.WebGLRenderer({ canvas: overlay, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(window.innerWidth, window.innerHeight);
		scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.4));
		const w = window.innerWidth;
		const h = window.innerHeight;
		camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 2000);
		camera.position.z = 500;
		renderer.setAnimationLoop(() => {
			if (renderer && scene && camera) renderer.render(scene, camera);
		});
	}

	/** object-fit: cover mapping between screen px and camera-frame coords. */
	function coverMap() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		const scale = Math.max(w / frameW, h / frameH);
		const dispW = frameW * scale;
		const dispH = frameH * scale;
		return { w, h, dispW, dispH, offX: (dispW - w) / 2, offY: (dispH - h) / 2 };
	}

	/** Screen px → target-image coords (image width = 1, origin centre, y up). */
	function toImage(px: number, py: number): [number, number] {
		const m = coverMap();
		const u = (px + m.offX) / m.dispW;
		const v = (py + m.offY) / m.dispH;
		return [u - 0.5, (0.5 - v) * (frameH / frameW)];
	}

	/** Caulk radius in image units → screen px. */
	function screenRadius(r: number): number {
		return r * coverMap().dispW;
	}

	async function captureFrame(): Promise<void> {
		const maxEdge = 1280;
		const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
		frameW = canvas.width;
		frameH = canvas.height;
		frame = await new Promise((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/jpeg', 0.85)
		);
	}

	function addBlob(px: number, py: number) {
		if (!scene || !currentGroup) return;
		const rPx = screenRadius(CAULK_RADIUS[thickness]);
		const blob = new THREE.Mesh(new THREE.SphereGeometry(rPx, 20, 14), caulkMaterial());
		blob.position.set(px - window.innerWidth / 2, window.innerHeight / 2 - py, 0);
		blob.scale.setScalar(caulkJitter(blobIndex++));
		currentGroup.add(blob);
	}

	async function onDown(ev: PointerEvent) {
		if (phase === 'live') {
			// The frame you draw on becomes the wall — freeze is invisible (same pixels).
			await captureFrame();
			video.pause();
			phase = 'drawing';
		}
		if (phase !== 'drawing' || current) return;
		(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
		current = [toImage(ev.clientX, ev.clientY)];
		currentGroup = new THREE.Group();
		scene?.add(currentGroup);
		addBlob(ev.clientX, ev.clientY);
	}

	function onMove(ev: PointerEvent) {
		if (!current) return;
		const rPx = screenRadius(CAULK_RADIUS[thickness]);
		const p = toImage(ev.clientX, ev.clientY);
		const last = current[current.length - 1];
		const distPx = Math.hypot(p[0] - last[0], p[1] - last[1]) * coverMap().dispW;
		if (distPx < rPx * 0.6 || current.length >= 200) return;
		current.push(p);
		addBlob(ev.clientX, ev.clientY);
	}

	function strokeCost(points: Array<[number, number]>, r: number): number {
		let len = 0;
		for (let i = 1; i < points.length; i++)
			len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
		return Math.max(10, Math.round(Math.PI * r * r * len * 1e5));
	}

	function onUp() {
		if (!current) return;
		if (current.length >= 2 && currentGroup && scene) {
			const r = CAULK_RADIUS[thickness];
			const z = depthCm / 100;
			// Swap the live bead preview for the smooth glossy tube (mock look).
			currentGroup.parent?.remove(currentGroup);
			const tube = buildCaulk(current, r, z);
			tube.scale.setScalar(coverMap().dispW);
			scene.add(tube);
			strokes.push({ points: current, r, z });
			strokeGroups.push(tube);
			strokeCount = strokes.length;
			pendingCost += strokeCost(current, r);
		} else {
			currentGroup?.parent?.remove(currentGroup);
		}
		current = null;
		currentGroup = null;
	}

	function undo() {
		const g = strokeGroups.pop();
		g?.parent?.remove(g);
		const st = strokes.pop();
		if (st) pendingCost = Math.max(0, pendingCost - strokeCost(st.points, st.r));
		strokeCount = strokes.length;
		if (strokes.length === 0) resumeLive();
	}

	function discard() {
		for (const g of strokeGroups) g.parent?.remove(g);
		strokeGroups = [];
		strokes = [];
		strokeCount = 0;
		pendingCost = 0;
		resumeLive();
	}

	function resumeLive() {
		frame = null;
		void video.play();
		phase = 'live';
	}

	/** Background: wall → anchor → spot → strokes. User just watches a pill. */
	async function save() {
		if (!frame || strokes.length === 0 || phase === 'saving') return;
		phase = 'saving';
		try {
			saveLabel = 'Anchoring';
			progress = 0;
			showMesh();
			const target = await compileWallTarget(frame, (p) => {
				progress = p;
				updateMesh(p);
			});
			updateMesh(100);

			saveLabel = 'Saving';
			gps = (await collectAveragedFix(1)) ?? gps;
			const { imagePath, targetPath } = await uploadSpotAssets(frame, target);
			const spot = await createSpot({
				lat: gps?.lat ?? 0,
				lon: gps?.lon ?? 0,
				accuracy: gps?.accuracy ?? null,
				name: null,
				imagePath,
				targetPath
			});
			for (const s of strokes) {
				await placeCaulk({
					spotId: spot.id,
					lat: spot.lat,
					lon: spot.lon,
					accuracy: gps?.accuracy ?? null,
					points: s.points,
					radius: s.r,
					depth: s.z
				});
			}
			stopEverything();
			await goto(`/spots/${spot.id}`, { replaceState: true });
		} catch (e) {
			hideMesh();
			phase = 'drawing';
			errorMsg = e instanceof Error ? e.message : String(e);
			setTimeout(() => (errorMsg = ''), 4000);
		}
	}

	function holdStart() {
		if (phase !== 'drawing' || strokeCount === 0) return;
		holding = true;
		holdTimer = setTimeout(() => {
			holding = false;
			void save();
		}, 700);
	}

	function holdEnd() {
		holding = false;
		clearTimeout(holdTimer);
	}

	function stopEverything() {
		clearTimeout(holdTimer);
		renderer?.setAnimationLoop(null);
		renderer?.dispose();
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
	}

	onDestroy(stopEverything);
</script>

<div class="spray-root">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video bind:this={video} playsinline muted></video>
	<canvas
		bind:this={overlay}
		onpointerdown={onDown}
		onpointermove={onMove}
		onpointerup={onUp}
		onpointercancel={onUp}
	></canvas>

	<div class="hud top">
		<button class="chip" onclick={() => goto('/')}>‹</button>
		<span class="chip status">
			{#if phase === 'boot'}Starting…{:else if phase === 'live'}NEW WALL — just draw
			{:else if phase === 'drawing'}EXTRUDING 3D · {costPct.toFixed(0)}%
			{:else if phase === 'saving'}{saveLabel === 'Anchoring' ? `BUILDING 3D MESH · ${progress.toFixed(0)}%` : `${saveLabel}…`}{/if}
		</span>
		{#if phase === 'drawing'}
			<button class="chip" onclick={undo}>undo</button>
			<button class="chip" onclick={discard}>✕</button>
		{/if}
	</div>

	{#if profile && (phase === 'live' || phase === 'drawing' || phase === 'saving')}
		<div class="meter" aria-hidden="true">
			<span class="meter-label">VOLUME</span>
			<div class="meter-bar"><div class="meter-fill" style="height: {meterPct}%"></div></div>
			<span class="meter-pct">{meterPct.toFixed(0)}%</span>
		</div>
	{/if}

	{#if phase === 'live' || phase === 'drawing'}
		<div class="hud bottom">
			{#if phase === 'drawing' || phase === 'live'}
				<label class="depth">
					<span class="panel-label">DEPTH</span>
					<input type="range" min="-5" max="15" step="1" bind:value={depthCm} />
					<span class="depth-val">{depthCm} cm</span>
				</label>
			{/if}
			<div class="thickness">
				{#each ['thin', 'medium', 'thick'] as const as t}
					<button class="thick-btn" class:active={thickness === t} onclick={() => (thickness = t)}>
						<span class="dot {t}"></span>
						{t}
					</button>
				{/each}
			</div>
			{#if phase === 'drawing' && strokeCount > 0}
				<div class="panel">
					<div class="panel-col">
						<span class="panel-label">VOLUME COST</span>
						<span class="panel-big">{costPct.toFixed(0)}%</span>
						<span class="panel-sub">−{fmtVolume(pendingCost)}</span>
					</div>
					<div class="panel-col">
						<span class="panel-label">BALANCE</span>
						<span class="panel-big">{fmtVolume(remaining)}</span>
						<span class="panel-sub">{strokeCount} stroke{strokeCount === 1 ? '' : 's'}</span>
					</div>
					<button
						class="hold-btn"
						class:holding
						onpointerdown={holdStart}
						onpointerup={holdEnd}
						onpointerleave={holdEnd}
					>
						<span class="hold-fill"></span>
						<span class="hold-text">Place 3D tag<small>HOLD TO CONFIRM</small></span>
					</button>
				</div>
			{/if}
			{#if errorMsg}<p class="err">{errorMsg}</p>{/if}
		</div>
	{/if}

	{#if phase === 'error'}
		<div class="center">
			<p>{errorMsg}</p>
			<button class="cta" onclick={() => location.reload()}>Retry</button>
		</div>
	{/if}
</div>

<style>
	.spray-root {
		position: fixed;
		inset: 0;
		background: #000;
		overflow: hidden;
	}
	video,
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	video {
		object-fit: cover;
	}
	canvas {
		touch-action: none;
		z-index: 2;
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
	.cta {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #0b0b0f;
		font-weight: 800;
		font-size: 1.15rem;
		border: none;
		border-radius: 1rem;
		padding: 1.1rem;
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
	.panel {
		display: flex;
		align-items: stretch;
		gap: 0.9rem;
		background: rgba(11, 11, 15, 0.8);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 1.1rem;
		padding: 0.8rem 1rem;
		backdrop-filter: blur(10px);
	}
	.panel-col {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		justify-content: center;
	}
	.panel-label {
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		color: var(--muted);
	}
	.panel-big {
		font-size: 1.25rem;
		font-weight: 800;
	}
	.panel-sub {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.hold-btn {
		position: relative;
		flex: 1;
		border: none;
		border-radius: 0.9rem;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #fff;
		overflow: hidden;
		padding: 0.7rem 1rem;
	}
	.hold-fill {
		position: absolute;
		inset: 0;
		background: rgba(255, 255, 255, 0.35);
		transform: scaleX(0);
		transform-origin: left;
	}
	.hold-btn.holding .hold-fill {
		transition: transform 0.7s linear;
		transform: scaleX(1);
	}
	.hold-text {
		position: relative;
		display: flex;
		flex-direction: column;
		font-weight: 800;
		font-size: 1rem;
	}
	.hold-text small {
		font-weight: 500;
		font-size: 0.6rem;
		letter-spacing: 0.12em;
		opacity: 0.85;
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
	.err {
		color: #fca5a5;
		text-align: center;
		margin: 0;
		font-size: 0.9rem;
	}
</style>
