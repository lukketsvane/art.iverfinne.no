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
	preview: string; // emoji shown in the picker UI
}

export const LIBRARY: LibraryItem[] = [
	{ id: 'fire', name: 'Fire', kind: 'sticker', preview: '🔥' },
	{ id: 'star', name: 'Star', kind: 'sticker', preview: '⭐' },
	{ id: 'eyes', name: 'Eyes', kind: 'sticker', preview: '👀' },
	{ id: 'heart', name: 'Heart', kind: 'sticker', preview: '💜' },
	{ id: 'arttag', name: 'ART tag', kind: 'sticker', preview: '🅰️' },
	{ id: 'cube', name: 'Cube', kind: 'model', preview: '🟪' },
	{ id: 'orb', name: 'Orb', kind: 'model', preview: '🔮' },
	{ id: 'knot', name: 'Knot', kind: 'model', preview: '🌀' }
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

/**
 * Build the Object3D for a builtin id. Returns null for unknown ids
 * (e.g. a GLB URL — handled by the caller).
 * Stickers set `userData.billboard = true`.
 */
export function buildBuiltin(builtinId: string, sizeClass: SizeClass): THREE.Object3D | null {
	const s = SIZE_SCALE[sizeClass];
	let obj: THREE.Object3D | null = null;

	if (builtinId in EMOJI || builtinId === 'arttag') {
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
