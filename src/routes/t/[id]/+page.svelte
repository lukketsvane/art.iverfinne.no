<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ensureSession } from '$lib/supabase';
	import { getTag } from '$lib/api';
	import { itemById } from '$lib/library';
	import { distanceM } from '$lib/ar/session';
	import type { NearbyTag } from '$lib/types';

	let tag = $state<NearbyTag | null>(null);
	let distance = $state<number | null>(null);
	let status = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');

	const item = $derived(
		tag?.model_url.startsWith('builtin:') ? itemById(tag.model_url.slice(8)) : undefined
	);

	onMount(async () => {
		try {
			await ensureSession();
			tag = await getTag(page.params.id!);
			if (!tag) {
				status = 'missing';
				return;
			}
			status = 'ready';
			navigator.geolocation?.getCurrentPosition(
				(pos) => {
					if (tag) distance = distanceM(pos.coords.latitude, pos.coords.longitude, tag.lat, tag.lon);
				},
				() => {},
				{ enableHighAccuracy: true, timeout: 10_000 }
			);
		} catch {
			status = 'error';
		}
	});
</script>

<main>
	<h1>ART</h1>
	{#if status === 'loading'}
		<p class="muted">Loading tag…</p>
	{:else if status === 'missing'}
		<p class="muted">This tag no longer exists.</p>
		<button class="cta" onclick={() => goto('/')}>Open ART</button>
	{:else if status === 'error'}
		<p class="muted">Couldn't load the tag — check your connection and reload.</p>
	{:else if tag}
		<div class="card">
			<div class="preview">{item?.preview ?? '🎨'}</div>
			<div>
				<h2>{item?.name ?? tag.model_url.replace('builtin:', '')}</h2>
				<p class="muted">
					{tag.appraisals} appraisal{tag.appraisals === 1 ? '' : 's'}
					{#if distance !== null}
						· {distance < 1000 ? `${distance.toFixed(0)} m` : `${(distance / 1000).toFixed(1)} km`} away
					{/if}
				</p>
			</div>
		</div>
		<button class="cta" onclick={() => goto(`/ar?t=${tag!.id}`)}>Find it in AR</button>
		<p class="muted small">
			The camera view shows an arrow and distance until you're close enough to see the tag.
		</p>
	{/if}
</main>

<style>
	main {
		max-width: 28rem;
		margin: 0 auto;
		padding: 2rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-height: 100dvh;
		box-sizing: border-box;
	}
	h1 {
		font-size: 2.2rem;
		margin: 0;
		letter-spacing: 0.08em;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.card {
		background: var(--panel);
		border-radius: 1rem;
		padding: 1.25rem;
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.preview {
		font-size: 3rem;
	}
	h2 {
		margin: 0 0 0.25rem;
		text-transform: capitalize;
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}
	.small {
		font-size: 0.85rem;
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
</style>
