import * as THREE from 'three';
import { SIZE_SCALE, type SizeClass } from '$lib/types';

/**
 * Curated MVP content library — zero downloaded assets.
 * Stickers are billboarded quads with canvas textures; models are procedural
 * meshes. `model_url` is stored as `builtin:<id>` so real GLB URLs can join
 * the same column later without a schema change.
 */

export interface LibraryItem {
	id: string;
	name: string;
	kind: 'sticker' | 'model';
	label: string; // short text shown in the picker UI (no emojis)
}

// Legacy emoji stickers (fire/star/eyes/heart) still RENDER for old tags via
// buildBuiltin, but are no longer offered in the picker — caulk is the hero.
export const LIBRARY: LibraryItem[] = [
	{ id: 'arttag', name: 'ART tag', kind: 'sticker', label: 'ART' },
	{ id: 'cube', name: 'Cube', kind: 'model', label: 'CUBE' },
	{ id: 'orb', name: 'Orb', kind: 'model', label: 'ORB' },
	{ id: 'knot', name: 'Knot', kind: 'model', label: 'KNOT' }
];

export function itemById(id: string): LibraryItem | undefined {
	return LIBRARY.find((i) => i.id === id);
}

const EMOJI: Record<string, string> = { fire: '🔥', star: '⭐', eyes: '👀', heart: '💜' };

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.Texture {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	draw(canvas.getContext('2d')!, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function emojiTexture(emoji: string): THREE.Texture {
	return canvasTexture((ctx, size) => {
		ctx.font = `${size * 0.8}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);
	});
}

function sprayTagTexture(): THREE.Texture {
	return canvasTexture((ctx, size) => {
		ctx.translate(size / 2, size / 2);
		ctx.rotate(-0.12);
		ctx.font = `900 ${size * 0.42}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.shadowColor = '#e11dff';
		ctx.shadowBlur = size * 0.09;
		ctx.fillStyle = '#e11dff';
		ctx.fillText('ART', 0, 0);
		ctx.shadowBlur = 0;
		ctx.fillStyle = '#ffffff';
		ctx.fillText('ART', -size * 0.012, -size * 0.012);
	});
}

// Glossy white caulk — the mock look.
export const CAULK_COLOR = 0xf4f4f6;

export function caulkMaterial(): THREE.Material {
	return new THREE.MeshPhysicalMaterial({
		color: CAULK_COLOR,
		roughness: 0.18,
		metalness: 0.02,
		clearcoat: 0.7,
		clearcoatRoughness: 0.25
	});
}

/** Caulk stroke: chain of overlapping spheres along the path — the mockup look. */
export function buildCaulk(points: Array<[number, number]>, radius: number): THREE.Group {
	const group = new THREE.Group();
	const mat = caulkMaterial();
	const geo = new THREE.SphereGeometry(radius, 20, 14);
	const step = radius * 0.7;
	for (let i = 0; i < points.length - 1; i++) {
		const [x1, y1] = points[i];
		const [x2, y2] = points[i + 1];
		const segLen = Math.hypot(x2 - x1, y2 - y1);
		const n = Math.max(1, Math.ceil(segLen / step));
		for (let j = 0; j < n; j++) {
			const t = j / n;
			const blob = new THREE.Mesh(geo, mat);
			blob.position.set(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, radius * 0.6);
			group.add(blob);
		}
	}
	const last = points[points.length - 1];
	const cap = new THREE.Mesh(geo, mat);
	cap.position.set(last[0], last[1], radius * 0.6);
	// The nozzle-release blob is a touch bigger, like squeezed caulk.
	cap.scale.setScalar(1.25);
	group.add(cap);
	return group;
}

/**
 * Build the Object3D for a builtin id. Returns null for unknown ids
 * (e.g. a GLB URL — handled by the caller).
 * Stickers set `userData.billboard = true`.
 */
export function buildBuiltin(builtinId: string, sizeClass: SizeClass): THREE.Object3D | null {
	const s = SIZE_SCALE[sizeClass];
	let obj: THREE.Object3D | null = null;

	if (builtinId === 'caulk') {
		// Caulk stroke seen from the sensor-AR view (no wall lock): render a
		// single blob so it's at least visible from afar.
		obj = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 14), caulkMaterial());
	} else if (builtinId in EMOJI || builtinId === 'arttag') {
		const tex = builtinId === 'arttag' ? sprayTagTexture() : emojiTexture(EMOJI[builtinId]);
		const mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
		);
		mesh.userData.billboard = true;
		obj = mesh;
	} else if (builtinId === 'cube') {
		obj = new THREE.Mesh(
			new THREE.BoxGeometry(0.7, 0.7, 0.7),
			new THREE.MeshStandardMaterial({ color: 0x9333ea, roughness: 0.35 })
		);
	} else if (builtinId === 'orb') {
		obj = new THREE.Mesh(
			new THREE.SphereGeometry(0.45, 32, 16),
			new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.15, metalness: 0.6 })
		);
	} else if (builtinId === 'knot') {
		obj = new THREE.Mesh(
			new THREE.TorusKnotGeometry(0.32, 0.11, 96, 16),
			new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3, metalness: 0.4 })
		);
	}

	if (obj) obj.scale.setScalar(s);
	return obj;
}
