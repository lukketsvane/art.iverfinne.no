import * as THREE from 'three';
import { caulkMaterial, caulkJitter } from '$lib/library';

export type VoxelCell = [number, number, number]; // grid i, j, k (k = off-wall)

/** Server-enforced ceiling per placement (place_voxels rejects above this). */
const MAX_CELLS = 4000;

/**
 * Caulk cells render as overlapping, jittered blobs (not grid-aligned
 * cubes): neighbours fuse into a continuous bead, and slight per-instance
 * shade variation gives the surface some material depth.
 */
function blobGeometry(vox: number): THREE.SphereGeometry {
	return new THREE.SphereGeometry(vox * 0.72, 12, 10);
}

function placeBlob(dummy: THREE.Object3D, vox: number, z0: number, cell: VoxelCell, n: number) {
	const [i, j, k] = cell;
	const jx = (caulkJitter(n * 3 + 1) - 1) * vox * 0.35;
	const jy = (caulkJitter(n * 3 + 2) - 1) * vox * 0.35;
	dummy.position.set(i * vox + jx, j * vox + jy, z0 + (k + 0.5) * vox);
	const s = 0.9 + (caulkJitter(n * 3 + 3) - 0.88) * 0.9; // ~[0.9, 1.13]
	dummy.scale.setScalar(s);
	dummy.updateMatrix();
}

const shade = new THREE.Color();
function blobShade(n: number): THREE.Color {
	// Subtle per-blob luminance variation — flat uniform color reads as fake.
	return shade.setScalar(0.9 + (caulkJitter(n * 7 + 5) - 0.88) * 0.4);
}

/** Soft radial contact shadow, drawn on the wall under the bead. */
function shadowTexture(): THREE.CanvasTexture {
	const c = document.createElement('canvas');
	c.width = c.height = 128;
	const ctx = c.getContext('2d')!;
	const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
	g.addColorStop(0, 'rgba(0,0,0,0.42)');
	g.addColorStop(0.65, 'rgba(0,0,0,0.18)');
	g.addColorStop(1, 'rgba(0,0,0,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 128, 128);
	return new THREE.CanvasTexture(c);
}

/**
 * Live voxel brush in anchor (wall) space. Each pen sample stamps a small
 * footprint of cells at the current top of each column; re-passing over a
 * column later stacks another layer — volumetric building, not painting.
 * stampTo() interpolates between pointer samples so fast strokes stay a
 * continuous bead, and a soft contact shadow on the wall plane grounds the
 * bead visually in the scene.
 */
export class VoxelBrush {
	readonly cells: VoxelCell[] = [];
	private heights = new Map<string, number>();
	private lastStamp = new Map<string, number>();
	private sample = 0;
	private mesh: THREE.InstancedMesh;
	private dummy = new THREE.Object3D();
	private shadow: THREE.Mesh;
	private min = new THREE.Vector2(Infinity, Infinity);
	private max = new THREE.Vector2(-Infinity, -Infinity);
	private last: { x: number; y: number } | null = null;
	readonly group = new THREE.Group();

	constructor(
		private vox: number,
		private z0: number,
		private maxLayers = 12,
		capacity = MAX_CELLS
	) {
		this.mesh = new THREE.InstancedMesh(blobGeometry(vox), caulkMaterial(), capacity);
		this.mesh.count = 0;
		this.shadow = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({
				map: shadowTexture(),
				transparent: true,
				depthWrite: false
			})
		);
		this.shadow.visible = false;
		this.shadow.renderOrder = -1;
		this.group.add(this.shadow, this.mesh);
	}

	/** Interpolated stamp: walks the segment from the previous pointer sample. */
	stampTo(x: number, y: number, r: number): number {
		if (!this.last) {
			this.last = { x, y };
			return this.stampAt(x, y, r);
		}
		const step = this.vox * 0.7;
		const dx = x - this.last.x;
		const dy = y - this.last.y;
		const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
		let added = 0;
		for (let s = 1; s <= n; s++) {
			added += this.stampAt(this.last.x + (dx * s) / n, this.last.y + (dy * s) / n, r);
		}
		this.last = { x, y };
		return added;
	}

	/** Pointer lifted: the next stroke may layer on top of this one. */
	endStroke() {
		this.last = null;
	}

	/** Stamp the brush at wall coords (x, y); radius r decides the footprint. */
	stampAt(x: number, y: number, r: number): number {
		this.sample++;
		const span = Math.max(0, Math.round(r / this.vox) - 1);
		const ci = Math.round(x / this.vox);
		const cj = Math.round(y / this.vox);
		let added = 0;
		for (let di = -span; di <= span; di++) {
			for (let dj = -span; dj <= span; dj++) {
				if (di * di + dj * dj > (span + 0.4) * (span + 0.4)) continue;
				if (this.cells.length >= MAX_CELLS) return added;
				const i = ci + di;
				const j = cj + dj;
				const key = `${i},${j}`;
				// Same continuous pass never double-stacks a column; coming back
				// later (>=14 samples) builds the next layer outward.
				const last = this.lastStamp.get(key);
				if (last !== undefined && this.sample - last < 14) continue;
				const k = this.heights.get(key) ?? 0;
				if (k >= this.maxLayers) continue;
				this.lastStamp.set(key, this.sample);
				this.heights.set(key, k + 1);
				this.addInstance(i, j, k);
				this.cells.push([i, j, k]);
				added++;
			}
		}
		if (added) this.updateShadow();
		return added;
	}

	/** Raise every column one layer off the wall (EXTRUDE hold). */
	extrude(): boolean {
		let grew = false;
		for (const [key, h] of Array.from(this.heights)) {
			if (h >= this.maxLayers) continue;
			if (this.cells.length >= MAX_CELLS) break;
			const [i, j] = key.split(',').map(Number);
			this.heights.set(key, h + 1);
			this.addInstance(i, j, h);
			this.cells.push([i, j, h]);
			grew = true;
		}
		return grew;
	}

	/** Tallest column, in layers — drives the DEPTH meter. */
	maxHeight(): number {
		let m = 0;
		for (const h of this.heights.values()) if (h > m) m = h;
		return m;
	}

	get maxLayerCount(): number {
		return this.maxLayers;
	}

	private addInstance(i: number, j: number, k: number) {
		if (this.mesh.count >= MAX_CELLS) return;
		const n = this.mesh.count;
		placeBlob(this.dummy, this.vox, this.z0, [i, j, k], n);
		this.mesh.setMatrixAt(n, this.dummy.matrix);
		this.mesh.setColorAt(n, blobShade(n));
		this.mesh.count++;
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
		this.min.x = Math.min(this.min.x, i * this.vox);
		this.min.y = Math.min(this.min.y, j * this.vox);
		this.max.x = Math.max(this.max.x, i * this.vox);
		this.max.y = Math.max(this.max.y, j * this.vox);
	}

	private updateShadow() {
		const pad = this.vox * 3;
		const w = this.max.x - this.min.x + pad * 2;
		const h = this.max.y - this.min.y + pad * 2;
		this.shadow.position.set(
			(this.min.x + this.max.x) / 2,
			(this.min.y + this.max.y) / 2,
			this.z0 + 0.0015
		);
		this.shadow.scale.set(w, h, 1);
		this.shadow.visible = true;
	}

	/** Exact volume so far, in cm³ (image units ≈ metres). */
	volumeCm3(): number {
		return Math.max(10, Math.round(this.cells.length * Math.pow(this.vox, 3) * 1e6));
	}

	dispose() {
		this.group.parent?.remove(this.group);
		this.mesh.geometry.dispose();
		this.shadow.geometry.dispose();
		((this.shadow.material as THREE.MeshBasicMaterial).map as THREE.Texture)?.dispose();
		(this.shadow.material as THREE.Material).dispose();
	}
}

/** Static voxel render for stored tags ({cells, vox, z}). */
export function buildVoxels(cells: VoxelCell[], vox: number, z0: number): THREE.Object3D {
	const mesh = new THREE.InstancedMesh(blobGeometry(vox), caulkMaterial(), cells.length);
	const dummy = new THREE.Object3D();
	cells.forEach((cell, n) => {
		placeBlob(dummy, vox, z0, cell, n);
		mesh.setMatrixAt(n, dummy.matrix);
		mesh.setColorAt(n, blobShade(n));
	});
	const group = new THREE.Group();
	group.add(mesh);
	return group;
}
