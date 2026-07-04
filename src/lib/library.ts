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
	// Matte-ish foam: hard specular pings on a soft camera feed read as CG.
	return new THREE.MeshPhysicalMaterial({
		color: CAULK_COLOR,
		roughness: 0.34,
		metalness: 0.0,
		clearcoat: 0.35,
		clearcoatRoughness: 0.45
	});
}

/** Deterministic pseudo-random bead scale in [0.88, 1.14]. */
export function caulkJitter(i: number): number {
	const x = Math.sin(i * 12.9898) * 43758.5453;
	return 0.88 + (x - Math.floor(x)) * 0.26;
}

/**
 * Caulk stroke: one smooth glossy tube along a Catmull-Rom spline through the
 * points, with rounded start cap and a slightly swollen release blob at the
 * end — the mock look. `depth` = how far the bead stands off the wall.
 */
export function buildCaulk(
	points: Array<[number, number]>,
	radius: number,
	depth?: number
): THREE.Group {
	const group = new THREE.Group();
	if (points.length < 2) return group;
	const z = depth ?? radius * 0.6;
	const mat = caulkMaterial();
	const path = points.map(([x, y]) => new THREE.Vector3(x, y, z));
	const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal', 0.5);
	const segments = Math.min(320, points.length * 6);
	group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, 16, false), mat));
	const start = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), mat);
	start.position.copy(path[0]);
	const end = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.28, 16, 12), mat);
	end.position.copy(path[path.length - 1]);
	group.add(start, end);
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
