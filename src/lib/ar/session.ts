import * as THREE from 'three';
import * as LocAR from 'locar';
import { buildBuiltin } from '$lib/library';
import type { NearbyTag, PlacementPose } from '$lib/types';

export interface GpsFix {
	lat: number;
	lon: number;
	alt: number | null;
	accuracy: number;
}

/**
 * Sensor-AR session: camera feed + GPS + compass via LocAR.js.
 * Owns the three.js scene; the Svelte layer only sees fixes and tag taps.
 */
export class ArSession {
	private app: InstanceType<typeof LocAR.App> | null = null;
	private locar: any = null;
	private clickHandler: any = null;
	private tagObjects = new Map<string, THREE.Object3D>();
	private disposed = false;

	lastFix: GpsFix | null = null;
	onGps: (fix: GpsFix, distMoved: number) => void = () => {};
	onTagTapped: (tagId: string) => void = () => {};

	constructor(private canvas: HTMLCanvasElement) {}

	async start(): Promise<void> {
		this.app = new LocAR.App({
			canvas: this.canvas,
			gpsOptions: { gpsMinDistance: 2 },
			deviceOrientationOptions: {
				enabled: true,
				// LocAR shows its own tap-to-allow dialog on iOS: DeviceOrientation
				// permission must be requested from a user gesture.
				enablePermissionDialog: true,
				smoothingFactor: 0.2
			}
		});

		const app = this.app!;
		app.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));

		this.locar = await app.start();
		this.clickHandler = new LocAR.ClickHandler(app.renderer);

		this.locar.on('gpsupdate', (e: { position: GeolocationPosition; distMoved: number }) => {
			const c = e.position.coords;
			this.lastFix = {
				lat: c.latitude,
				lon: c.longitude,
				alt: c.altitude,
				accuracy: c.accuracy
			};
			this.onGps(this.lastFix, e.distMoved);
		});
		await this.locar.startGps();

		// Take over the render loop: billboard stickers + poll tap raycasts.
		app.renderer.setAnimationLoop(() => {
			if (this.disposed) return;
			app.deviceOrientationControls?.update();
			for (const obj of this.tagObjects.values()) {
				if (obj.userData.billboard) obj.quaternion.copy(app.camera.quaternion);
			}
			const hits: THREE.Intersection[] = this.clickHandler.raycast(app.camera, app.scene);
			for (const hit of hits) {
				const tagId = this.findTagId(hit.object);
				if (tagId) {
					this.onTagTapped(tagId);
					break;
				}
			}
			app.renderer.render(app.scene, app.camera);
		});
	}

	private findTagId(obj: THREE.Object3D): string | null {
		let cur: THREE.Object3D | null = obj;
		while (cur) {
			if (cur.userData.tagId) return cur.userData.tagId as string;
			cur = cur.parent;
		}
		return null;
	}

	/** Current pose for placement + v2-migration logging. */
	pose(): PlacementPose | null {
		if (!this.lastFix) return null;
		return {
			lat: this.lastFix.lat,
			lon: this.lastFix.lon,
			alt: this.lastFix.alt,
			heading: this.heading(),
			accuracy: this.lastFix.accuracy
		};
	}

	heading(): number | null {
		const h = this.app?.deviceOrientationControls?.getCorrectedHeading();
		return typeof h === 'number' && !Number.isNaN(h) ? ((h % 360) + 360) % 360 : null;
	}

	/** Reconcile the scene with the latest nearby_tags result. */
	syncTags(tags: NearbyTag[]): void {
		if (!this.locar || !this.lastFix) return;
		const keep = new Set(tags.map((t) => t.id));
		for (const [id, obj] of this.tagObjects) {
			if (!keep.has(id)) {
				obj.parent?.remove(obj);
				this.tagObjects.delete(id);
			}
		}
		for (const tag of tags) {
			if (!this.tagObjects.has(tag.id)) this.addTag(tag);
		}
	}

	addTag(tag: NearbyTag): void {
		if (!this.locar || this.tagObjects.has(tag.id)) return;
		const builtinId = tag.model_url.startsWith('builtin:') ? tag.model_url.slice(8) : null;
		const obj = builtinId ? buildBuiltin(builtinId, tag.size_class) : null;
		if (!obj) {
			// GLB URLs (post-MVP user uploads) would be GLTF-loaded here.
			return;
		}
		obj.userData.tagId = tag.id;
		obj.traverse((c) => (c.userData.tagId = tag.id));
		// MVP renders everything at eye level: GPS altitude is too noisy to use
		// for display, but it IS logged for the v2 VPS migration.
		this.locar.add(obj, tag.lon, tag.lat, 0);
		this.tagObjects.set(tag.id, obj);
	}

	dispose(): void {
		this.disposed = true;
		try {
			this.locar?.stopGps();
			this.app?.deviceOrientationControls?.dispose();
			this.app?.renderer.setAnimationLoop(null);
			this.app?.renderer.dispose();
		} catch {
			/* teardown must never throw */
		}
		// LocAR's Webcam appends its own <video> to <body>; stop tracks + remove.
		for (const video of Array.from(document.body.querySelectorAll('video'))) {
			const stream = video.srcObject as MediaStream | null;
			stream?.getTracks().forEach((t) => t.stop());
			video.remove();
		}
	}
}

/** Move a lat/lon point `distM` metres along `headingDeg` (small distances). */
export function offsetLatLon(
	lat: number,
	lon: number,
	headingDeg: number,
	distM: number
): { lat: number; lon: number } {
	const R = 6378137;
	const rad = (headingDeg * Math.PI) / 180;
	const dLat = (distM * Math.cos(rad)) / R;
	const dLon = (distM * Math.sin(rad)) / (R * Math.cos((lat * Math.PI) / 180));
	return { lat: lat + (dLat * 180) / Math.PI, lon: lon + (dLon * 180) / Math.PI };
}
