<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ensureSession } from '$lib/supabase';
	import { getProfile, getTag, nearbyTags, nearbySpots, placeTag, appraiseTag, reportTag } from '$lib/api';
	import type { Spot } from '$lib/types';
	import { ArSession, offsetLatLon, distanceM, bearingDeg } from '$lib/ar/session';
	import { LIBRARY } from '$lib/library';
	import { SIZE_COST, fmtVolume, type NearbyTag, type Profile, type SizeClass } from '$lib/types';

	const FETCH_RADIUS_M = 150;
	const REFETCH_DISTANCE_M = 20;
	const REFETCH_INTERVAL_MS = 30_000;
	const PLACE_AHEAD_M = 4; // tags land a few metres in front of you

	let canvas: HTMLCanvasElement;
	let session: ArSession | null = null;
	let userId = $state<string | null>(null);
	let profile = $state<Profile | null>(null);
	let phase = $state<'starting' | 'ready' | 'error'>('starting');
	let errorMsg = $state('');
	let accuracy = $state<number | null>(null);
	let hasFix = $state(false);
	let toast = $state('');
	let placing = $state(false);

	let selectedItem = $state(LIBRARY[0]);
	let selectedSize = $state<SizeClass>('m');

	let tags = $state<NearbyTag[]>([]);
	let selectedTag = $state<NearbyTag | null>(null);

	// Focus mode: /ar?t=<id> guides the user to one specific tag.
	let focusTag = $state<NearbyTag | null>(null);
	let focusDistance = $state<number | null>(null);
	let arrowRotation = $state(0);

	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let arrowTimer: ReturnType<typeof setInterval> | undefined;
	let lastFetchAt: { lat: number; lon: number } | null = null;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const remaining = $derived(profile ? profile.total_volume - profile.used_volume : 0);

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 3000);
	}

	async function refreshProfile() {
		if (userId) profile = await getProfile(userId);
	}

	let nearestSpot = $state<Spot | null>(null);

	async function fetchNearby(lat: number, lon: number) {
		try {
			lastFetchAt = { lat, lon };
			tags = await nearbyTags(lat, lon, FETCH_RADIUS_M);
			session?.syncTags(tags);
		} catch (e) {
			console.error('nearby fetch failed', e);
		}
		try {
			const spots = await nearbySpots(lat, lon, 300);
			nearestSpot = spots[0] ?? null;
		} catch {
			nearestSpot = null; // migration 0003 not applied yet — fine
		}
	}

	async function place() {
		if (!session || placing) return;
		const pose = session.pose();
		if (!pose) {
			showToast('Waiting for GPS fix…');
			return;
		}
		const cost = SIZE_COST[selectedSize];
		if (remaining < cost) {
			showToast(`Not enough volume (${cost} cm³ needed)`);
			return;
		}
		if (pose.accuracy !== null && pose.accuracy > 25) {
			showToast(`GPS too imprecise (±${pose.accuracy.toFixed(0)} m) — hold still, open sky helps`);
			return;
		}
		placing = true;
		try {
			// Drop the tag a few metres ahead, in the direction you're facing.
			const ahead =
				pose.heading !== null
					? offsetLatLon(pose.lat, pose.lon, pose.heading, PLACE_AHEAD_M)
					: { lat: pose.lat, lon: pose.lon };
			const placed = await placeTag(
				{ ...pose, lat: ahead.lat, lon: ahead.lon },
				`builtin:${selectedItem.id}`,
				selectedSize
			);
			tags = [...tags, placed];
			session.addTag(placed);
			await refreshProfile();
			showToast('Placed!');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			showToast(msg.includes('insufficient') ? 'Spray can is empty!' : msg);
		} finally {
			placing = false;
		}
	}

	async function appraise(tag: NearbyTag) {
		try {
			await appraiseTag(tag.id);
			tag.appraised = true;
			tag.appraisals += 1;
			selectedTag = { ...tag };
			showToast('Appraised — creator gets +25 cm³');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			showToast(msg.includes('own tag') ? "Can't appraise your own tag" : msg);
		}
	}

	async function share(tag: NearbyTag) {
		const url = `${location.origin}/t/${tag.id}`;
		try {
			if (navigator.share) {
				await navigator.share({ title: 'ART tag', url });
			} else {
				await navigator.clipboard.writeText(url);
				showToast('Link copied');
			}
		} catch {
			/* user cancelled the share sheet */
		}
	}

	async function report(tag: NearbyTag) {
		try {
			await reportTag(tag.id);
			selectedTag = null;
			showToast('Reported');
		} catch {
			showToast('Report failed');
		}
	}

	onMount(async () => {
		try {
			userId = await ensureSession();
			await refreshProfile();
		} catch (e) {
			phase = 'error';
			errorMsg = e instanceof Error ? e.message : String(e);
			return;
		}

		session = new ArSession(canvas);
		session.onGps = (fix) => {
			accuracy = session?.averagedFix()?.accuracy ?? fix.accuracy;
			if (!hasFix) {
				hasFix = true;
				void fetchNearby(fix.lat, fix.lon);
				void loadFocusTag(fix.lat, fix.lon);
			} else if (
				lastFetchAt &&
				distanceM(fix.lat, fix.lon, lastFetchAt.lat, lastFetchAt.lon) > REFETCH_DISTANCE_M
			) {
				void fetchNearby(fix.lat, fix.lon);
			}
		};
		session.onTagTapped = (tagId) => {
			selectedTag = tags.find((t) => t.id === tagId) ?? null;
		};

		try {
			await session.start();
			phase = 'ready';
		} catch (e) {
			phase = 'error';
			const err = e as { code?: string; message?: string };
			errorMsg =
				err?.code === 'NotAllowedError' || err?.code === 'LOCAR_DEVICE_ORIENTATION_DENIED'
					? 'Camera or motion access was denied. Allow both in Settings and reload.'
					: (err?.message ?? String(e));
			return;
		}

		pollTimer = setInterval(() => {
			const fix = session?.lastFix;
			if (fix) void fetchNearby(fix.lat, fix.lon);
		}, REFETCH_INTERVAL_MS);

		// Guidance arrow: bearing to the focused tag relative to camera heading.
		arrowTimer = setInterval(() => {
			const fix = session?.lastFix;
			if (!focusTag || !fix) return;
			focusDistance = distanceM(fix.lat, fix.lon, focusTag.lat, focusTag.lon);
			const heading = session?.heading();
			if (heading !== null && heading !== undefined) {
				arrowRotation = (bearingDeg(fix.lat, fix.lon, focusTag.lat, focusTag.lon) - heading + 360) % 360;
			}
		}, 250);
	});

	async function loadFocusTag(lat: number, lon: number) {
		const id = page.url.searchParams.get('t');
		if (!id) return;
		try {
			const tag = await getTag(id);
			if (!tag) {
				showToast('Tag not found (removed?)');
				return;
			}
			tag.distance_m = distanceM(lat, lon, tag.lat, tag.lon);
			focusTag = tag;
			if (!tags.some((t) => t.id === tag.id)) tags = [...tags, tag];
			session?.addTag(tag);
		} catch (e) {
			console.error('focus tag load failed', e);
		}
	}

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(arrowTimer);
		clearTimeout(toastTimer);
		session?.dispose();
		session = null;
	});
</script>

<div class="ar-root">
	<canvas bind:this={canvas}></canvas>

	<div class="hud top">
		<button class="chip" onclick={() => goto('/')}>‹ back</button>
		{#if profile}
			<span class="chip">{fmtVolume(remaining)}</span>
		{/if}
		<span class="chip" class:warn={!hasFix}>
			{#if !hasFix}locating…{:else}±{accuracy?.toFixed(0)} m · {tags.length} tags{/if}
		</span>
	</div>

	{#if phase === 'starting'}
		<div class="center-note">Starting camera &amp; sensors…</div>
	{:else if phase === 'error'}
		<div class="center-note error">
			<p>{errorMsg}</p>
			<button class="chip" onclick={() => location.reload()}>Retry</button>
		</div>
	{/if}

	{#if phase === 'ready' && focusTag && focusDistance !== null && focusDistance > 15}
		<div class="guide">
			<span class="guide-arrow" style="transform: rotate({arrowRotation - 90}deg)">➤</span>
			<span>{focusDistance < 1000 ? `${focusDistance.toFixed(0)} m` : `${(focusDistance / 1000).toFixed(1)} km`} to tag</span>
		</div>
	{/if}

	{#if phase === 'ready'}
		<div class="hud bottom">
			{#if nearestSpot}
				<button class="spot-banner" onclick={() => goto(`/spots/${nearestSpot!.id}`)}>
					PRECISE · {nearestSpot.name ?? 'Spot'} · {nearestSpot.distance_m?.toFixed(0)} m ·
					{nearestSpot.tag_count} tags — <strong>precise mode</strong>
				</button>
			{/if}
			<div class="picker">
				{#each LIBRARY as item (item.id)}
					<button
						class="swatch"
						class:active={selectedItem.id === item.id}
						onclick={() => (selectedItem = item)}
						title={item.name}
					>
						{item.label}
					</button>
				{/each}
			</div>
			<div class="place-row">
				<div class="sizes">
					{#each ['s', 'm', 'l'] as const as size}
						<button
							class="swatch size"
							class:active={selectedSize === size}
							onclick={() => (selectedSize = size)}
						>
							{size.toUpperCase()}<small>{SIZE_COST[size]}</small>
						</button>
					{/each}
				</div>
				<button class="place" onclick={place} disabled={placing || !hasFix}>
					{placing ? '…' : 'PLACE'}
				</button>
			</div>
		</div>
	{/if}

	{#if selectedTag}
		<div class="sheet">
			<div class="sheet-head">
				<strong>{selectedTag.model_url.replace('builtin:', '')}</strong>
				<button class="chip" onclick={() => (selectedTag = null)}>✕</button>
			</div>
			<p class="meta">
				{selectedTag.distance_m.toFixed(0)} m away · {selectedTag.appraisals}
				appraisal{selectedTag.appraisals === 1 ? '' : 's'}
			</p>
			<div class="sheet-actions">
				{#if selectedTag.creator_id === userId}
					<span class="meta">your tag</span>
				{:else if selectedTag.appraised}
					<span class="meta">appraised ✓</span>
				{:else}
					<button class="appraise" onclick={() => selectedTag && appraise(selectedTag)}>
						Appraise (+25 cm³ to creator)
					</button>
				{/if}
				<button class="chip" onclick={() => selectedTag && share(selectedTag)}>share</button>
				<button class="chip" onclick={() => selectedTag && report(selectedTag)}>report</button>
			</div>
		</div>
	{/if}

	{#if toast}
		<div class="toast">{toast}</div>
	{/if}
</div>

<style>
	.ar-root {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: #000;
	}
	canvas {
		position: absolute;
		inset: 0;
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
		bottom: env(safe-area-inset-bottom);
		flex-direction: column;
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
	.chip.warn {
		color: #fbbf24;
	}
	.center-note {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		z-index: 5;
		padding: 2rem;
		text-align: center;
	}
	.center-note.error {
		color: #fca5a5;
	}
	.picker {
		display: flex;
		gap: 0.4rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}
	.swatch {
		background: rgba(11, 11, 15, 0.75);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.8rem;
		min-width: 3rem;
		height: 3rem;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: var(--text);
	}
	.swatch.active {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.swatch.size {
		font-size: 0.95rem;
		font-weight: 700;
	}
	.swatch.size small {
		font-weight: 400;
		font-size: 0.6rem;
		color: var(--muted);
	}
	.spot-banner {
		background: rgba(11, 11, 15, 0.8);
		border: 1px solid var(--accent-2);
		border-radius: 999px;
		color: var(--text);
		padding: 0.55rem 1rem;
		font-size: 0.9rem;
		backdrop-filter: blur(8px);
	}
	.place-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.sizes {
		display: flex;
		gap: 0.4rem;
	}
	.place {
		flex: 1;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		border: none;
		border-radius: 1rem;
		color: #0b0b0f;
		font-weight: 800;
		font-size: 1.1rem;
		padding: 0.9rem;
	}
	.place:disabled {
		opacity: 0.5;
	}
	.sheet {
		position: absolute;
		left: 0.75rem;
		right: 0.75rem;
		bottom: calc(9.5rem + env(safe-area-inset-bottom));
		background: rgba(22, 22, 29, 0.95);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 1rem;
		padding: 0.9rem 1rem;
		z-index: 20;
		backdrop-filter: blur(12px);
	}
	.sheet-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0.3rem 0;
	}
	.sheet-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.5rem;
	}
	.appraise {
		flex: 1;
		background: var(--accent);
		border: none;
		border-radius: 0.8rem;
		color: white;
		font-weight: 700;
		padding: 0.7rem;
	}
	.guide {
		position: absolute;
		top: calc(env(safe-area-inset-top) + 4.5rem);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 0.6rem;
		align-items: center;
		background: rgba(11, 11, 15, 0.8);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		padding: 0.5rem 1rem;
		z-index: 15;
		backdrop-filter: blur(8px);
		font-size: 0.9rem;
	}
	.guide-arrow {
		display: inline-block;
		color: var(--accent-2);
		font-size: 1.2rem;
		transition: transform 0.25s linear;
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
