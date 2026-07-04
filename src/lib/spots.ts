import { supabase } from '$lib/supabase';
import { uploadSpotFile } from '$lib/api';

/**
 * Compile a wall photo into a MindAR .mind tracking target, in the browser.
 * Heavy (tfjs feature extraction) — takes 5–30 s on a phone; report progress.
 */
export async function compileWallTarget(
	file: File | Blob,
	onProgress?: (pct: number) => void
): Promise<Blob> {
	const { Compiler } = await import('$lib/vendor/mindar/mindar-image.prod.js');
	const img = await loadImage(file);
	const compiler = new Compiler();
	await compiler.compileImageTargets([img], (p: number) => onProgress?.(p));
	const data: ArrayBuffer = await compiler.exportData();
	return new Blob([data], { type: 'application/octet-stream' });
}

/** Downscale a photo blob to a max long edge, re-encoded as JPEG. */
export async function downscaleJpeg(file: File | Blob, maxEdge: number): Promise<Blob> {
	const img = await loadImage(file);
	const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(img.width * scale);
	canvas.height = Math.round(img.height * scale);
	canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
	return await new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('jpeg encode failed'))), 'image/jpeg', 0.85)
	);
}

/** Legacy name: photo normalization for spot creation. */
export async function normalizePhoto(file: File): Promise<Blob> {
	return downscaleJpeg(file, 1280);
}

export async function uploadSpotAssets(
	image: Blob,
	target: Blob
): Promise<{ imagePath: string; targetPath: string }> {
	const { data } = await supabase().auth.getSession();
	const uid = data.session?.user.id ?? 'anon';
	const base = `${uid}/${crypto.randomUUID()}`;
	const imagePath = `${base}.jpg`;
	const targetPath = `${base}.mind`;
	await uploadSpotFile(imagePath, image, 'image/jpeg');
	await uploadSpotFile(targetPath, target, 'application/octet-stream');
	return { imagePath, targetPath };
}

function loadImage(src: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(src);
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('could not load image'));
		};
		img.src = url;
	});
}

/** Average a few seconds of geolocation fixes (inverse-variance weighted). */
export function collectAveragedFix(
	seconds = 6
): Promise<{ lat: number; lon: number; accuracy: number } | null> {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(null);
		const fixes: Array<{ lat: number; lon: number; acc: number }> = [];
		const watch = navigator.geolocation.watchPosition(
			(pos) =>
				fixes.push({
					lat: pos.coords.latitude,
					lon: pos.coords.longitude,
					acc: Math.max(pos.coords.accuracy, 1)
				}),
			() => {},
			{ enableHighAccuracy: true }
		);
		setTimeout(() => {
			navigator.geolocation.clearWatch(watch);
			if (!fixes.length) return resolve(null);
			let sw = 0,
				lat = 0,
				lon = 0;
			for (const f of fixes) {
				const w = 1 / (f.acc * f.acc);
				sw += w;
				lat += f.lat * w;
				lon += f.lon * w;
			}
			resolve({ lat: lat / sw, lon: lon / sw, accuracy: Math.max(3, Math.sqrt(1 / sw)) });
		}, seconds * 1000);
	});
}
