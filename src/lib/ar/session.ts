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
	private fixBuffer: Array<GpsFix & { t: number }> = [];

	lastFix: GpsFix | null = null;
	onGps: (fix: GpsFix, distMoved: number) => void = () => {};
	onTagTapped: (tagId: string) => void = () => {};

	constructor(private canvas: HTMLCanvasElement) {}

	async start(): Promise<void> {
		this.app = new LocAR.App({
			canvas: this.canvas,
			// gpsMinDistance 0: receive EVERY fix so standing still keeps feeding
			// the averaging buffer instead of starving it.
			gpsOptions: { gpsMinDistance: 0 },
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
			const now = Date.now();
			this.fixBuffer.push({ ...this.lastFix, t: now });
			this.fixBuffer = this.fixBuffer.filter((f) => now - f.t < 10_000).slice(-20);
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

	/**
	 * Inverse-variance weighted average of the last ~8 s of fixes. Standing
	 * still for a few seconds beats any single noisy fix; the combined
	 * accuracy is optimistic (GPS errors correlate), so floor it at 3 m.
	 */
	averagedFix(): GpsFix | null {
		const now = Date.now();
		const recent = this.fixBuffer.filter((f) => now - f.t < 8_000 && f.accuracy > 0);
		if (recent.length < 2) return this.lastFix;
		let sw = 0,
			lat = 0,
			lon = 0,
			alt = 0,
			altw = 0;
		for (const f of recent) {
			const w = 1 / (f.accuracy * f.accuracy);
			sw += w;
			lat += f.lat * w;
			lon += f.lon * w;
			if (f.alt !== null) {
				alt += f.alt * w;
				altw += w;
			}
		}
		return {
			lat: lat / sw,
			lon: lon / sw,
			alt: altw > 0 ? alt / altw : null,
			accuracy: Math.max(3, Math.sqrt(1 / sw))
		};
	}

	/** Current pose for placement + v2-migration logging (GPS-averaged). */
	pose(): PlacementPose | null {
		const fix = this.averagedFix();
		if (!fix) return null;
		return {
			lat: fix.lat,
			lon: fix.lon,
			alt: fix.alt,
			heading: this.heading(),
			accuracy: fix.accuracy
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

/** Haversine distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const p1 = (lat1 * Math.PI) / 180;
	const p2 = (lat2 * Math.PI) / 180;
	const dp = ((lat2 - lat1) * Math.PI) / 180;
	const dl = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing in degrees (0 = north, clockwise) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const p1 = (lat1 * Math.PI) / 180;
	const p2 = (lat2 * Math.PI) / 180;
	const dl = ((lon2 - lon1) * Math.PI) / 180;
	const y = Math.sin(dl) * Math.cos(p2);
	const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
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
