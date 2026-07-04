import * as THREE from 'three';
import { caulkMaterial } from '$lib/library';

export type VoxelCell = [number, number, number]; // grid i, j, k (k = off-wall)

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
		this.mesh = new THREE.InstancedMesh(
			new THREE.BoxGeometry(vox * 0.94, vox * 0.94, vox * 0.94),
			caulkMaterial(),
			capacity
		);
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
		this.dummy.position.set(
			i * this.vox,
			j * this.vox,
			this.z0 + (k + 0.5) * this.vox
		);
		this.dummy.updateMatrix();
		this.mesh.setMatrixAt(this.mesh.count, this.dummy.matrix);
		this.mesh.count++;
		this.mesh.instanceMatrix.needsUpdate = true;
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
	const mesh = new THREE.InstancedMesh(
		new THREE.BoxGeometry(vox * 0.94, vox * 0.94, vox * 0.94),
		caulkMaterial(),
		cells.length
	);
	const dummy = new THREE.Object3D();
	cells.forEach(([i, j, k], n) => {
		dummy.position.set(i * vox, j * vox, z0 + (k + 0.5) * vox);
		dummy.updateMatrix();
		mesh.setMatrixAt(n, dummy.matrix);
	});
	const group = new THREE.Group();
	group.add(mesh);
	return group;
}
