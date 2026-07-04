<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { ensureSession } from '$lib/supabase';
	import { nearbySpots } from '$lib/api';
	import { collectAveragedFix } from '$lib/spots';

	let status = $state<'locating' | 'none' | 'error'>('locating');
	let errorMsg = $state('');

	onMount(async () => {
		try {
			await ensureSession();
			const fix = await collectAveragedFix(3);
			if (!fix) {
				status = 'error';
				errorMsg = 'No GPS fix — allow location access and try again.';
				return;
			}
			const spots = await nearbySpots(fix.lat, fix.lon, 500);
			if (spots.length > 0) {
				// Sensors found the wall; the camera takes it from here.
				await goto(`/spots/${spots[0].id}`, { replaceState: true });
			} else {
				status = 'none';
			}
		} catch (e) {
			status = 'error';
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<main>
	{#if status === 'locating'}
		<div class="pulse"></div>
		<h2>Finding the nearest wall…</h2>
		<p class="muted">GPS + compass locate tagged spots around you</p>
	{:else if status === 'none'}
		<h2>No tagged walls near you</h2>
		<p class="muted">
			Be the first. Photograph a textured wall — it becomes a precision anchor everyone
			can spray on.
		</p>
		<button class="cta" onclick={() => goto('/spots/new')}>Start a spot here</button>
		<button class="chip" onclick={() => goto('/')}>‹ back</button>
	{:else}
		<h2>Can't locate you</h2>
		<p class="muted">{errorMsg}</p>
		<button class="cta" onclick={() => location.reload()}>Retry</button>
		<button class="chip" onclick={() => goto('/')}>‹ back</button>
	{/if}
</main>

<style>
	main {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 2rem 1.5rem;
		box-sizing: border-box;
		text-align: center;
	}
	.pulse {
		width: 4rem;
		height: 4rem;
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
	h2 {
		margin: 0;
	}
	.muted {
		color: var(--muted);
		margin: 0;
		max-width: 24rem;
	}
	.cta {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #0b0b0f;
		font-weight: 700;
		font-size: 1.1rem;
		border: none;
		border-radius: 1rem;
		padding: 1rem 2.5rem;
		cursor: pointer;
	}
	.chip {
		background: none;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		color: var(--muted);
		padding: 0.5rem 1.2rem;
	}
</style>
