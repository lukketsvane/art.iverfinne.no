import { detectFeatures, sharpness, type Feature } from '$lib/mesh';

/**
 * Wall capture with quality scoring. Instead of grabbing one blind frame,
 * the scanner samples the live feed, scores each frame by trackable detail
 * (feature count) and focus (Laplacian sharpness), and the best frame wins.
 * A blurry or featureless capture is what makes tracking fail downstream —
 * this is where that gets prevented.
 */
export interface FrameSample {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
	detect: ImageData; // small copy the CV ran on
	features: Feature[];
	sharp: number;
	score: number;
}

const FULL_EDGE = 1280; // reference photo resolution
const DETECT_EDGE = 420; // CV resolution

/** Grab one scored frame from a live video. Null until the feed has size. */
export function sampleFrame(video: HTMLVideoElement): FrameSample | null {
	if (!video.videoWidth || !video.videoHeight) return null;
	const scale = Math.min(1, FULL_EDGE / Math.max(video.videoWidth, video.videoHeight));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(video.videoWidth * scale);
	canvas.height = Math.round(video.videoHeight * scale);
	canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);

	const dScale = DETECT_EDGE / Math.max(canvas.width, canvas.height);
	const dc = document.createElement('canvas');
	dc.width = Math.max(2, Math.round(canvas.width * dScale));
	dc.height = Math.max(2, Math.round(canvas.height * dScale));
	const dctx = dc.getContext('2d', { willReadFrequently: true })!;
	dctx.drawImage(canvas, 0, 0, dc.width, dc.height);
	const detect = dctx.getImageData(0, 0, dc.width, dc.height);

	const features = detectFeatures(detect, 300);
	const sharp = sharpness(detect);
	// Feature-rich beats sharp-but-blank; sharpness breaks ties between
	// similar views (motion blur tanks it).
	const score = features.length * (1 + Math.min(2, sharp / 150));
	return { canvas, width: canvas.width, height: canvas.height, detect, features, sharp, score };
}

/** Best of n frames sampled over a short burst. */
export async function burstSample(
	video: HTMLVideoElement,
	n = 3,
	intervalMs = 130
): Promise<FrameSample | null> {
	let best: FrameSample | null = null;
	for (let i = 0; i < n; i++) {
		const s = sampleFrame(video);
		if (s && (!best || s.score > best.score)) best = s;
		if (i < n - 1) await new Promise((r) => setTimeout(r, intervalMs));
	}
	return best;
}

/** JPEG-encode a sample's full-resolution frame. */
export function encodeSample(s: FrameSample, quality = 0.85): Promise<Blob> {
	return new Promise((resolve, reject) =>
		s.canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error('capture failed'))),
			'image/jpeg',
			quality
		)
	);
}
