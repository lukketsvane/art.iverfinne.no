<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as THREE from 'three';
	import { ensureSession } from '$lib/supabase';
	import { getSpot, spotTags, placeTag, placeCaulk, appraiseTag, spotFileUrl, getProfile } from '$lib/api';
	import { buildBuiltin, buildCaulk, caulkMaterial, LIBRARY } from '$lib/library';
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
	let userId = $state<string | null>(null);
	let profile = $state<Profile | null>(null);
	let tags = $state<SpotTag[]>([]);
	let selectedTag = $state<SpotTag | null>(null);

	let selectedItem = $state(LIBRARY[0]);
	let selectedSize = $state<SizeClass>('m');

	// Caulk tool — the mockups' "tag with caulk" flow.
	type Thickness = 'thin' | 'medium' | 'thick';
	const CAULK_RADIUS: Record<Thickness, number> = { thin: 0.015, medium: 0.03, thick: 0.05 };
	let tool = $state<'caulk' | 'sticker'>('caulk');
	let thickness = $state<Thickness>('medium');
	let strokeCost = $state(0);
	let stroke: Array<[number, number]> = [];
	let strokePreview: THREE.Group | null = null;
	let drawing = false;

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
		let obj: THREE.Object3D | null = null;
		const xy = tag.spot_xy as { x?: number; y?: number; s?: number; points?: Array<[number, number]>; r?: number };
		if (tag.model_url === 'caulk' && xy.points && xy.r) {
			obj = buildCaulk(xy.points, xy.r);
		} else {
			const builtinId = tag.model_url.startsWith('builtin:') ? tag.model_url.slice(8) : null;
			obj = builtinId ? buildBuiltin(builtinId, tag.size_class) : null;
			if (obj) {
				// buildBuiltin scales in metres (sensor-AR world); rescale to image units.
				obj.scale.setScalar(SPOT_SIZE_SCALE[tag.size_class] * (xy.s || 1));
				obj.position.set(xy.x ?? 0, xy.y ?? 0, 0.04);
			}
		}
		if (!obj) return;
		obj.userData.tagId = tag.id;
		obj.traverse((c) => (c.userData.tagId = tag.id));
		anchorGroup.add(obj);
		tagObjects.set(tag.id, obj);
	}

	/** Raycast a pointer event onto the wall plane; returns local coords. */
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

	function strokeLength(points: Array<[number, number]>): number {
		let len = 0;
		for (let i = 1; i < points.length; i++)
			len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
		return len;
	}

	function estimateCost(points: Array<[number, number]>, r: number): number {
		return Math.max(10, Math.round(Math.PI * r * r * strokeLength(points) * 1e5));
	}

	function onPointerDown(ev: PointerEvent) {
		if (tool !== 'caulk' || phase !== 'locked' || placing) return;
		const p = wallPoint(ev);
		if (!p || !anchorGroup) return;
		drawing = true;
		(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
		stroke = [[p.x, p.y]];
		strokePreview = new THREE.Group();
		anchorGroup.add(strokePreview);
		addBlob(p.x, p.y);
		strokeCost = 0;
	}

	function onPointerMove(ev: PointerEvent) {
		if (!drawing || !strokePreview) return;
		const p = wallPoint(ev);
		if (!p) return;
		const last = stroke[stroke.length - 1];
		const r = CAULK_RADIUS[thickness];
		if (Math.hypot(p.x - last[0], p.y - last[1]) < r * 0.6) return;
		if (stroke.length >= 200) return;
		stroke.push([p.x, p.y]);
		addBlob(p.x, p.y);
		strokeCost = estimateCost(stroke, r);
	}

	function addBlob(x: number, y: number) {
		if (!strokePreview) return;
		const r = CAULK_RADIUS[thickness];
		const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), caulkMaterial());
		blob.position.set(x, y, r * 0.6);
		strokePreview.add(blob);
	}

	async function onPointerUp() {
		if (!drawing) return;
		drawing = false;
		const points = stroke;
		const preview = strokePreview;
		stroke = [];
		strokePreview = null;
		strokeCost = 0;
		if (!spot || points.length < 2) {
			preview?.parent?.remove(preview);
			return;
		}
		placing = true;
		try {
			const r = CAULK_RADIUS[thickness];
			const placed = await placeCaulk({
				spotId: spot.id,
				lat: spot.lat,
				lon: spot.lon,
				accuracy: spot.accuracy_m ?? null,
				points,
				radius: r
			});
			const spotTag: SpotTag = {
				id: placed.id,
				creator_id: placed.creator_id,
				model_url: 'caulk',
				size_class: thickness === 'thin' ? 's' : thickness === 'thick' ? 'l' : 'm',
				spot_xy: { points, r } as never,
				appraisals: 0,
				appraised: false,
				created_at: placed.created_at
			};
			// The live preview already looks right — adopt it as the tag mesh.
			if (preview) {
				preview.userData.tagId = placed.id;
				preview.traverse((c) => (c.userData.tagId = placed.id));
				tagObjects.set(placed.id, preview);
			}
			tags = [...tags, spotTag];
			await refreshProfile();
			showToast(`Sprayed! −${placed.volume_cm3.toFixed(0)} cm³`);
		} catch (e) {
			preview?.parent?.remove(preview);
			const msg = e instanceof Error ? e.message : String(e);
			showToast(msg.includes('insufficient') ? 'Spray can is empty!' : msg);
		} finally {
			placing = false;
		}
	}

	/** Find an existing tag under the pointer; select it. Returns true if hit. */
	function trySelect(ev: PointerEvent): boolean {
		if (!mindar || !anchorGroup) return false;
		const el = mindar.renderer.domElement as HTMLCanvasElement;
		const r = el.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((ev.clientX - r.left) / r.width) * 2 - 1,
			-(((ev.clientY - r.top) / r.height) * 2 - 1)
		);
		raycaster.setFromCamera(ndc, mindar.camera);
		for (const hit of raycaster.intersectObjects(anchorGroup.children, true)) {
			let cur: THREE.Object3D | null = hit.object;
			while (cur) {
				if (cur.userData.tagId) {
					selectedTag = tags.find((t) => t.id === cur!.userData.tagId) ?? null;
					return true;
				}
				cur = cur.parent;
			}
		}
		return false;
	}

	/** Sticker mode: tap an existing tag to select it, tap empty wall to place. */
	async function onStickerTap(ev: PointerEvent) {
		if (phase !== 'locked') return;
		if (trySelect(ev)) return;
		const p = wallPoint(ev);
		if (p) await placeOnWall(p.x, p.y);
	}

	function handlePointerDown(ev: PointerEvent) {
		if (tool === 'caulk') onPointerDown(ev);
		else void onStickerTap(ev);
	}

	function handlePointerUp(ev: PointerEvent) {
		if (tool !== 'caulk') return;
		const wasStroke = stroke.length >= 2;
		void onPointerUp();
		if (!wasStroke) trySelect(ev); // a mere tap in caulk mode = select
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
			const el = mindar.renderer.domElement as HTMLCanvasElement;
			el.style.touchAction = 'none';
			el.addEventListener('pointerdown', handlePointerDown);
			el.addEventListener('pointermove', onPointerMove);
			el.addEventListener('pointerup', handlePointerUp);
		} catch (e) {
			phase = 'error';
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		clearTimeout(toastTimer);
		try {
			mindar?.renderer?.setAnimationLoop(null);
			const el = mindar?.renderer?.domElement;
			el?.removeEventListener('pointerdown', handlePointerDown);
			el?.removeEventListener('pointermove', onPointerMove);
			el?.removeEventListener('pointerup', handlePointerUp);
			mindar?.stop();
		} catch {
			/* teardown must never throw */
		}
	});
</script>

<div class="spot-root" bind:this={container}>
	<div class="hud top">
		<button class="chip" onclick={() => goto('/ar')}>‹ AR</button>
		{#if profile}<span class="chip">{remaining.toFixed(0)} cm³</span>{/if}
		<span class="chip" class:locked={phase === 'locked'}>
			{#if phase === 'loading'}loading…{:else if phase === 'scanning'}Point at the wall
			{:else if phase === 'locked'}LOCKED · {tags.length} tags{:else}error{/if}
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
			<div class="tools">
				<button class="chip" class:sel={tool === 'caulk'} onclick={() => (tool = 'caulk')}>
					Caulk
				</button>
				<button class="chip" class:sel={tool === 'sticker'} onclick={() => (tool = 'sticker')}>
					Stickers
				</button>
				{#if strokeCost > 0}<span class="chip cost">−{strokeCost} cm³</span>{/if}
			</div>

			{#if tool === 'caulk'}
				<div class="thickness">
					{#each ['thin', 'medium', 'thick'] as const as t}
						<button class="thick-btn" class:active={thickness === t} onclick={() => (thickness = t)}>
							<span class="dot {t}"></span>
							{t}
						</button>
					{/each}
				</div>
				<p class="tip">
					{phase === 'locked' ? 'Hold & drag on the wall to spray' : 'Lock onto the wall first'}
				</p>
			{:else}
				<div class="picker">
					{#each LIBRARY as item (item.id)}
						<button
							class="swatch"
							class:active={selectedItem.id === item.id}
							onclick={() => (selectedItem = item)}>{item.label}</button
						>
					{/each}
				</div>
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
				<p class="tip">Tap the wall to place{placing ? '…' : ''}</p>
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
						Appraise (+25 cm³)
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
	.sizes {
		display: flex;
		gap: 0.4rem;
	}
	.tools {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.chip.sel {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}
	.chip.cost {
		color: #fbbf24;
		margin-left: auto;
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
		background: #7b61ff;
	}
	.dot.thick {
		width: 2.4rem;
		height: 0.6rem;
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
