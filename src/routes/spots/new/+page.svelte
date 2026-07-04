<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { ensureSession } from '$lib/supabase';
	import { createSpot } from '$lib/api';
	import { compileWallTarget, normalizePhoto, uploadSpotAssets, collectAveragedFix } from '$lib/spots';

	let file = $state<File | null>(null);
	let previewUrl = $state<string | null>(null);
	let name = $state('');
	let busy = $state<'idle' | 'compiling' | 'uploading' | 'saving'>('idle');
	let progress = $state(0);
	let error = $state<string | null>(null);
	let gps = $state<{ lat: number; lon: number; accuracy: number } | null>(null);
	let gpsCollecting = $state(false);

	onMount(async () => {
		try {
			await ensureSession();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	function onPick(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		file = f;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = URL.createObjectURL(f);
		// Start averaging GPS while the user types a name: free precision.
		gpsCollecting = true;
		void collectAveragedFix(6).then((fix) => {
			gps = fix;
			gpsCollecting = false;
		});
	}

	async function create() {
		if (!file || busy !== 'idle') return;
		error = null;
		try {
			if (!gps) {
				gpsCollecting = true;
				gps = await collectAveragedFix(4);
				gpsCollecting = false;
			}
			if (!gps) throw new Error('No GPS fix — allow location access and try again.');

			busy = 'compiling';
			progress = 0;
			const photo = await normalizePhoto(file);
			const target = await compileWallTarget(photo, (p) => (progress = p));

			busy = 'uploading';
			const { imagePath, targetPath } = await uploadSpotAssets(photo, target);

			busy = 'saving';
			const spot = await createSpot({
				lat: gps.lat,
				lon: gps.lon,
				accuracy: gps.accuracy,
				name: name.trim() || null,
				imagePath,
				targetPath
			});
			await goto(`/spots/${spot.id}`);
		} catch (e) {
			busy = 'idle';
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<main>
	<h1>New spot</h1>
	<p class="muted">
		Photograph a wall or surface with lots of texture and detail (posters, brick, graffiti —
		not blank walls). It becomes a precision anchor: tags stick to it, centimetre-accurate,
		for everyone who points their camera at it.
	</p>

	<label class="photo" class:has-image={previewUrl}>
		{#if previewUrl}
			<img src={previewUrl} alt="wall preview" />
		{:else}
			<span>Take wall photo</span>
		{/if}
		<input type="file" accept="image/*" capture="environment" onchange={onPick} hidden />
	</label>

	<input class="name" type="text" placeholder="Name (optional)" bind:value={name} maxlength="60" />

	<p class="muted small">
		{#if gpsCollecting}Averaging GPS…{:else if gps}Position locked (±{gps.accuracy.toFixed(0)} m)
		{:else}GPS starts when you take the photo{/if}
	</p>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<button class="cta" onclick={create} disabled={!file || busy !== 'idle'}>
		{#if busy === 'compiling'}Analyzing wall… {(progress).toFixed(0)}%
		{:else if busy === 'uploading'}Uploading…
		{:else if busy === 'saving'}Saving…
		{:else}Create spot{/if}
	</button>

	<button class="chip" onclick={() => goto('/')}>‹ back</button>
</main>

<style>
	main {
		max-width: 28rem;
		margin: 0 auto;
		padding: 2rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		box-sizing: border-box;
	}
	h1 {
		margin: 0;
		font-size: 2rem;
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}
	.small {
		font-size: 0.85rem;
	}
	.photo {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--panel);
		border: 2px dashed rgba(255, 255, 255, 0.2);
		border-radius: 1rem;
		min-height: 14rem;
		cursor: pointer;
		overflow: hidden;
		font-size: 1.1rem;
	}
	.photo.has-image {
		border-style: solid;
	}
	.photo img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.name {
		background: var(--panel);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.8rem;
		color: var(--text);
		padding: 0.8rem 1rem;
		font-size: 1rem;
	}
	.error {
		color: #fca5a5;
		margin: 0;
	}
	.cta {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #0b0b0f;
		font-weight: 700;
		font-size: 1.1rem;
		border: none;
		border-radius: 1rem;
		padding: 1rem;
		cursor: pointer;
	}
	.cta:disabled {
		opacity: 0.5;
	}
	.chip {
		background: none;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		color: var(--muted);
		padding: 0.5rem 1rem;
		align-self: flex-start;
	}
</style>
