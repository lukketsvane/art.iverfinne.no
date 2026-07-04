<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { getSpot, spotTags, placeTag, appraiseTag, spotFileUrl, getProfile } from '$lib/api';
	import { buildBuiltin, LIBRARY } from '$lib/library';
	import {
		SIZE_COST,
		SPOT_SIZE_SCALE,
		type Profile,
		type SizeClass,
		type Spot,
		type SpotTag
	} from '$lib/types';

	let container: HTMLDivElement;
	let spot = $state<Spot | null>(null);
	let phase = $state<'loading' | 'scanning' | 'locked' | 'error'>('loading');
	let errorMsg = $state('');
	let toast = $state('');
	let placing = $state(false);
	let placeMode = $state(false);
	let userId = $state<string | null>(null);
	let profile = $state<Profile | null>(null);
	let tags = $state<SpotTag[]>([]);
	let selectedTag = $state<SpotTag | null>(null);

	let selectedItem = $state(LIBRARY[0]);
	let selectedSize = $state<SizeClass>('m');

	let mindar: any = null;
	let anchorGroup: THREE.Group | null = null;
	let tapPlane: THREE.Mesh | null = null;
	let raycaster = new THREE.Raycaster();
	const tagObjects = new Map<string, THREE.Object3D>();
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const remaining = $derived(profile ? profile.total_volume - profile.used_volume : 0);

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 3000);
	}

	function addTagMesh(tag: SpotTag) {
		if (!anchorGroup || tagObjects.has(tag.id) || !tag.spot_xy) return;
		const builtinId = tag.model_url.startsWith('builtin:') ? tag.model_url.slice(8) : null;
		const obj = builtinId ? buildBuiltin(builtinId, tag.size_class) : null;
		if (!obj) return;
		// buildBuiltin scales in metres (sensor-AR world); rescale to image units.
		obj.scale.setScalar(SPOT_SIZE_SCALE[tag.size_class] * (tag.spot_xy.s || 1));
		obj.position.set(tag.spot_xy.x, tag.spot_xy.y, 0.04);
		obj.userData.tagId = tag.id;
		obj.traverse((c) => (c.userData.tagId = tag.id));
		anchorGroup.add(obj);
		tagObjects.set(tag.id, obj);
	}

	async function onTap(ev: PointerEvent) {
		if (!mindar || !anchorGroup || phase !== 'locked') return;
		const el = mindar.renderer.domElement as HTMLCanvasElement;
		const r = el.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((ev.clientX - r.left) / r.width) * 2 - 1,
			-(((ev.clientY - r.top) / r.height) * 2 - 1)
		);
		raycaster.setFromCamera(ndc, mindar.camera);
		const hits = raycaster.intersectObjects(anchorGroup.children, true);
		if (!hits.length) return;

		if (placeMode) {
			const local = anchorGroup.worldToLocal(hits[0].point.clone());
			await placeOnWall(local.x, local.y);
		} else {
			for (const hit of hits) {
				let cur: THREE.Object3D | null = hit.object;
				while (cur) {
					if (cur.userData.tagId) {
						selectedTag = tags.find((t) => t.id === cur!.userData.tagId) ?? null;
						return;
					}
					cur = cur.parent;
				}
			}
		}
	}

	async function placeOnWall(x: number, y: number) {
		if (!spot || placing) return;
		const cost = SIZE_COST[selectedSize];
		if (remaining < cost) {
			showToast(`Not enough volume (${cost} cm³ needed)`);
			return;
		}
		placing = true;
		try {
			const xy = { x, y, s: 1 };
			const placed = await placeTag(
				// The tag inherits the SPOT's surveyed position — better than the
				// placer's momentary GPS.
				{ lat: spot.lat, lon: spot.lon, alt: null, heading: null, accuracy: spot.accuracy_m ?? null },
				`builtin:${selectedItem.id}`,
				selectedSize,
				{ id: spot.id, xy }
			);
			const spotTag: SpotTag = {
				id: placed.id,
				creator_id: placed.creator_id,
				model_url: placed.model_url,
				size_class: placed.size_class,
				spot_xy: xy,
				appraisals: 0,
				appraised: false,
				created_at: placed.created_at
			};
			tags = [...tags, spotTag];
			addTagMesh(spotTag);
			placeMode = false;
			await refreshProfile();
			showToast('Tagged the wall!');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			showToast(msg.includes('insufficient') ? 'Spray can is empty!' : msg);
		} finally {
			placing = false;
		}
	}

	async function appraise(tag: SpotTag) {
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

	async function share() {
		if (!spot) return;
		const url = `${location.origin}/spots/${spot.id}`;
		try {
			if (navigator.share) await navigator.share({ title: spot.name ?? 'ART spot', url });
			else {
				await navigator.clipboard.writeText(url);
				showToast('Link copied');
			}
		} catch {
			/* cancelled */
		}
	}

	async function refreshProfile() {
		if (userId) profile = await getProfile(userId);
	}

	onMount(async () => {
		try {
			userId = await ensureSession();
			await refreshProfile();
			spot = await getSpot(page.params.id!);
			if (!spot) {
				phase = 'error';
				errorMsg = 'Spot not found.';
				return;
			}
			tags = await spotTags(spot.id);

			const { MindARThree } = await import('$lib/vendor/mindar/mindar-image-three.prod.js');
			mindar = new MindARThree({
				container,
				imageTargetSrc: spotFileUrl(spot.target_path),
				uiLoading: 'no',
				uiScanning: 'no',
				uiError: 'no',
				filterMinCF: 0.0001,
				filterBeta: 0.001
			});
			mindar.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));
			const anchor = mindar.addAnchor(0);
			anchorGroup = anchor.group;

			// Invisible tap surface covering the wall around the target image.
			tapPlane = new THREE.Mesh(
				new THREE.PlaneGeometry(4, 4),
				new THREE.MeshBasicMaterial({ visible: false })
			);
			anchorGroup!.add(tapPlane);

			for (const t of tags) addTagMesh(t);

			anchor.onTargetFound = () => (phase = 'locked');
			anchor.onTargetLost = () => (phase = 'scanning');

			await mindar.start();
			phase = 'scanning';
			mindar.renderer.setAnimationLoop(() => {
				mindar.renderer.render(mindar.scene, mindar.camera);
			});
			mindar.renderer.domElement.addEventListener('pointerdown', onTap);
		} catch (e) {
			phase = 'error';
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		clearTimeout(toastTimer);
		try {
			mindar?.renderer?.setAnimationLoop(null);
			mindar?.renderer?.domElement?.removeEventListener('pointerdown', onTap);
			mindar?.stop();
		} catch {
			/* teardown must never throw */
		}
	});
</script>

<div class="spot-root" bind:this={container}>
	<div class="hud top">
		<button class="chip" onclick={() => goto('/ar')}>‹ AR</button>
		{#if profile}<span class="chip">🧯 {remaining.toFixed(0)} cm³</span>{/if}
		<span class="chip" class:locked={phase === 'locked'}>
			{#if phase === 'loading'}loading…{:else if phase === 'scanning'}🔍 point at the wall
			{:else if phase === 'locked'}🧱 locked · {tags.length} tags{:else}error{/if}
		</span>
		<button class="chip" onclick={share}>share</button>
	</div>

	{#if phase === 'error'}
		<div class="center-note">
			<p>{errorMsg}</p>
			<button class="chip" onclick={() => location.reload()}>Retry</button>
		</div>
	{/if}

	{#if spot && phase === 'scanning'}
		<div class="hint">
			<img src={spotFileUrl(spot.image_path)} alt="find this wall" />
			<p>Find this surface and point your camera at it</p>
		</div>
	{/if}

	{#if phase === 'locked' || phase === 'scanning'}
		<div class="hud bottom">
			{#if placeMode}
				<div class="picker">
					{#each LIBRARY as item (item.id)}
						<button
							class="swatch"
							class:active={selectedItem.id === item.id}
							onclick={() => (selectedItem = item)}>{item.preview}</button
						>
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
					<button class="place ghost" onclick={() => (placeMode = false)}>cancel</button>
				</div>
				<p class="tip">Tap the wall to place{placing ? '…' : ''}</p>
			{:else}
				<button class="place" onclick={() => (placeMode = true)} disabled={phase !== 'locked'}>
					🎨 TAG THIS WALL
				</button>
			{/if}
		</div>
	{/if}

	{#if selectedTag}
		<div class="sheet">
			<div class="sheet-head">
				<strong>{selectedTag.model_url.replace('builtin:', '')}</strong>
				<button class="chip" onclick={() => (selectedTag = null)}>✕</button>
			</div>
			<p class="meta">
				{selectedTag.appraisals} appraisal{selectedTag.appraisals === 1 ? '' : 's'}
			</p>
			<div class="sheet-actions">
				{#if selectedTag.creator_id === userId}
					<span class="meta">your tag</span>
				{:else if selectedTag.appraised}
					<span class="meta">appraised ✓</span>
				{:else}
					<button class="appraise" onclick={() => selectedTag && appraise(selectedTag)}>
						👍 Appraise (+25 cm³)
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if toast}<div class="toast">{toast}</div>{/if}
</div>

<style>
	.spot-root {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: #000;
	}
	/* MindAR injects its own video + canvas into the container */
	.spot-root :global(video),
	.spot-root :global(canvas) {
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
		flex-wrap: wrap;
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
	.chip.locked {
		color: #4ade80;
	}
	.center-note {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: center;
		justify-content: center;
		color: #fca5a5;
		z-index: 5;
		padding: 2rem;
		text-align: center;
	}
	.hint {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		z-index: 5;
		pointer-events: none;
	}
	.hint img {
		width: 9rem;
		border-radius: 0.8rem;
		border: 2px solid rgba(255, 255, 255, 0.4);
		opacity: 0.85;
	}
	.hint p {
		color: var(--text);
		background: rgba(11, 11, 15, 0.7);
		border-radius: 999px;
		padding: 0.4rem 1rem;
		font-size: 0.9rem;
		margin: 0;
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
		font-size: 1.4rem;
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
		font-size: 1.05rem;
		padding: 0.9rem;
	}
	.place:disabled {
		opacity: 0.5;
	}
	.place.ghost {
		background: rgba(11, 11, 15, 0.75);
		color: var(--muted);
		border: 1px solid rgba(255, 255, 255, 0.2);
		flex: 0 0 auto;
		padding: 0.9rem 1.2rem;
	}
	.tip {
		color: var(--text);
		background: rgba(11, 11, 15, 0.7);
		border-radius: 999px;
		padding: 0.35rem 1rem;
		font-size: 0.85rem;
		margin: 0 auto;
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
