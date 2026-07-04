<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots, createSpot } from '$lib/api';
	import { compileWallTarget, uploadSpotAssets, collectAveragedFix } from '$lib/spots';

	let video: HTMLVideoElement;
	let stream: MediaStream | null = null;
	let phase = $state<'starting' | 'newwall' | 'compiling' | 'error'>('starting');
	let progress = $state(0);
	let busyLabel = $state('');
	let errorMsg = $state('');
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);

	onMount(async () => {
		try {
			await ensureSession();
			// Camera + GPS in parallel: the camera IS the app.
			const [mediaStream, fix] = await Promise.all([
				navigator.mediaDevices.getUserMedia({
					video: { facingMode: 'environment', width: { ideal: 1920 } }
				}),
				collectAveragedFix(4)
			]);
			stream = mediaStream;
			video.srcObject = stream;
			await video.play();

			gps = fix;
			if (fix) {
				const spots = await nearbySpots(fix.lat, fix.lon, 500);
				if (spots.length > 0) {
					// Auto-access: a wall exists nearby — straight into it.
					stopCamera();
					await goto(`/spots/${spots[0].id}`, { replaceState: true });
					return;
				}
			}
			// No wall here yet: one tap creates it from whatever you're aiming at.
			phase = 'newwall';
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

	function stopCamera() {
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
	}

	/** One tap: frame → tracking target → spot → straight into precise mode. */
	async function sprayThisWall() {
		if (phase !== 'newwall') return;
		phase = 'compiling';
		try {
			busyLabel = 'Capturing wall';
			const frame = await captureFrame();

			busyLabel = 'Analyzing wall';
			progress = 0;
			const target = await compileWallTarget(frame, (p) => (progress = p));

			busyLabel = 'Locking position';
			gps = (await collectAveragedFix(2)) ?? gps;
			if (!gps) throw new Error('No GPS fix — allow location access.');

			busyLabel = 'Saving spot';
			const { imagePath, targetPath } = await uploadSpotAssets(frame, target);
			const spot = await createSpot({
				lat: gps.lat,
				lon: gps.lon,
				accuracy: gps.accuracy,
				name: null,
				imagePath,
				targetPath
			});
			stopCamera();
			await goto(`/spots/${spot.id}`, { replaceState: true });
		} catch (e) {
			phase = 'newwall';
			errorMsg = e instanceof Error ? e.message : String(e);
			setTimeout(() => (errorMsg = ''), 4000);
		}
	}

	async function captureFrame(): Promise<Blob> {
		const maxEdge = 1280;
		const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
		return await new Promise((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/jpeg', 0.85)
		);
	}

	onDestroy(stopCamera);
</script>

<div class="spray-root">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video bind:this={video} playsinline muted></video>

	<div class="hud top">
		<button class="chip" onclick={() => goto('/')}>‹ home</button>
		<span class="chip">
			{#if phase === 'starting'}Locating…{:else if gps}±{gps.accuracy.toFixed(0)} m{:else}No GPS{/if}
		</span>
	</div>

	{#if phase === 'starting'}
		<div class="center">
			<div class="pulse"></div>
			<p>Finding walls near you…</p>
		</div>
	{:else if phase === 'newwall'}
		<div class="frame-hint" aria-hidden="true"></div>
		<div class="hud bottom">
			<p class="tip">No tagged walls here yet. Aim at a textured surface.</p>
			<button class="cta" onclick={sprayThisWall}>SPRAY THIS WALL</button>
			{#if errorMsg}<p class="err">{errorMsg}</p>{/if}
		</div>
	{:else if phase === 'compiling'}
		<div class="center">
			<div class="pulse"></div>
			<p>{busyLabel}{busyLabel === 'Analyzing wall' ? ` ${progress.toFixed(0)}%` : '…'}</p>
			<p class="sub">This wall becomes a shared anchor — one time only</p>
		</div>
	{:else}
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
	video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
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
		padding: 0.4rem 0.8rem;
		font-size: 0.85rem;
		backdrop-filter: blur(8px);
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
	.center p {
		margin: 0;
		font-size: 1.05rem;
	}
	.sub {
		color: var(--muted);
		font-size: 0.85rem !important;
	}
	.pulse {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 999px;
		border: 3px solid var(--accent);
		animation: pulse 1.2s ease-out infinite;
	}
	@keyframes pulse {
		0% {
			transform: scale(0.7);
			opacity: 1;
		}
		100% {
			transform: scale(1.4);
			opacity: 0;
		}
	}
	.frame-hint {
		position: absolute;
		top: 28%;
		left: 14%;
		right: 14%;
		bottom: 38%;
		border: 2px dashed rgba(255, 255, 255, 0.45);
		border-radius: 1rem;
		z-index: 4;
		pointer-events: none;
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
		padding: 1.1rem;
	}
	.err {
		color: #fca5a5;
		text-align: center;
		margin: 0;
		font-size: 0.9rem;
	}
</style>
