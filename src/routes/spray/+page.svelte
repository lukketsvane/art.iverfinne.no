<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot, placeCaulk } from '$lib/api';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix } from '$lib/spots';
	import { caulkMaterial } from '$lib/library';

	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };

	let video: HTMLVideoElement;
	let overlay: HTMLCanvasElement;
	let stream: MediaStream | null = null;

	let phase = $state<'boot' | 'live' | 'drawing' | 'saving' | 'error'>('boot');
	let thickness = $state<Thickness>('medium');
	let errorMsg = $state('');
	let saveLabel = $state('');
	let progress = $state(0);
	let strokeCount = $state(0);
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);

	// Frozen-frame drawing state
	let frame: Blob | null = null;
	let frameW = 0;
	let frameH = 0;
	let strokes: Array<{ points: Array<[number, number]>; r: number }> = [];
	let current: Array<[number, number]> | null = null;

	// three.js screen-space overlay (glossy caulk look without tracking)
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.OrthographicCamera | null = null;
	let strokeGroups: THREE.Group[] = [];
	let currentGroup: THREE.Group | null = null;

	onMount(async () => {
		try {
			await ensureSession();
			const [mediaStream, fix] = await Promise.all([
				navigator.mediaDevices.getUserMedia({
					video: { facingMode: 'environment', width: { ideal: 1920 } }
				}),
				collectAveragedFix(3)
			]);
			gps = fix;

			// Auto-access: if a tracked wall is nearby, use it — invisible redirect.
			if (fix) {
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
		camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 100);
		camera.position.z = 10;
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

	function onUp() {
		if (!current) return;
		if (current.length >= 2 && currentGroup) {
			strokes.push({ points: current, r: CAULK_RADIUS[thickness] });
			strokeGroups.push(currentGroup);
			strokeCount = strokes.length;
		} else {
			currentGroup?.parent?.remove(currentGroup);
		}
		current = null;
		currentGroup = null;
	}

	function undo() {
		const g = strokeGroups.pop();
		g?.parent?.remove(g);
		strokes.pop();
		strokeCount = strokes.length;
		if (strokes.length === 0) resumeLive();
	}

	function discard() {
		for (const g of strokeGroups) g.parent?.remove(g);
		strokeGroups = [];
		strokes = [];
		strokeCount = 0;
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
			const target = await compileWallTarget(frame, (p) => (progress = p));

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
					radius: s.r
				});
			}
			stopEverything();
			await goto(`/spots/${spot.id}`, { replaceState: true });
		} catch (e) {
			phase = 'drawing';
			errorMsg = e instanceof Error ? e.message : String(e);
			setTimeout(() => (errorMsg = ''), 4000);
		}
	}

	function stopEverything() {
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
			{:else if phase === 'drawing'}{strokeCount} stroke{strokeCount === 1 ? '' : 's'}
			{:else if phase === 'saving'}{saveLabel} {saveLabel === 'Anchoring' ? `${progress.toFixed(0)}%` : '…'}{/if}
		</span>
		{#if phase === 'drawing'}
			<button class="chip" onclick={undo}>undo</button>
			<button class="chip" onclick={discard}>✕</button>
		{/if}
	</div>

	{#if phase === 'live' || phase === 'drawing'}
		<div class="hud bottom">
			<div class="thickness">
				{#each ['thin', 'medium', 'thick'] as const as t}
					<button class="thick-btn" class:active={thickness === t} onclick={() => (thickness = t)}>
						<span class="dot {t}"></span>
						{t}
					</button>
				{/each}
			</div>
			{#if phase === 'drawing' && strokeCount > 0}
				<button class="cta" onclick={save}>SET IT</button>
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
