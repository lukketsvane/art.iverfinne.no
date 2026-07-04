import * as THREE from 'three';
import { caulkMaterial, caulkJitter } from '$lib/library';

export type VoxelCell = [number, number, number]; // grid i, j, k (k = off-wall)

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

/**
 * Live voxel brush in anchor (wall) space. Each pen sample stamps a small
 * footprint of cells at the current top of each column; re-passing over a
 * column later stacks another layer — volumetric building, not painting.
 */
export class VoxelBrush {
	readonly cells: VoxelCell[] = [];
	private heights = new Map<string, number>();
	private lastStamp = new Map<string, number>();
	private sample = 0;
	private mesh: THREE.InstancedMesh;
	private dummy = new THREE.Object3D();
	readonly group = new THREE.Group();

	constructor(
		private vox: number,
		private z0: number,
		private maxLayers = 8,
		capacity = 4000
	) {
		this.mesh = new THREE.InstancedMesh(blobGeometry(vox), caulkMaterial(), capacity);
		this.mesh.count = 0;
		this.group.add(this.mesh);
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
		return added;
	}

	private addInstance(i: number, j: number, k: number) {
		if (this.mesh.count >= 4000) return;
		const n = this.mesh.count;
		placeBlob(this.dummy, this.vox, this.z0, [i, j, k], n);
		this.mesh.setMatrixAt(n, this.dummy.matrix);
		this.mesh.setColorAt(n, blobShade(n));
		this.mesh.count++;
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
	}

	/** Exact volume so far, in cm³ (image units ≈ metres). */
	volumeCm3(): number {
		return Math.max(10, Math.round(this.cells.length * Math.pow(this.vox, 3) * 1e6));
	}

	dispose() {
		this.group.parent?.remove(this.group);
		this.mesh.geometry.dispose();
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
