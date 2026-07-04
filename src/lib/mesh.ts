/**
 * Real feature detection + meshing for the map-building visualization.
 * Shi-Tomasi corners on the captured wall frame, Delaunay-triangulated —
 * the same class of features MindAR's compiler tracks, so what the user
 * sees during "BUILDING 3D MAP" is the wall's actual structure.
 */

export interface Feature {
	x: number;
	y: number;
	score: number;
}

/**
 * Shi-Tomasi (min-eigenvalue) corner detection with grid-spread
 * non-max suppression. Returns up to maxPoints features in image pixel
 * coordinates, strongest first.
 */
export function detectFeatures(img: ImageData, maxPoints = 300): Feature[] {
	const w = img.width;
	const h = img.height;
	const d = img.data;

	const gray = new Float32Array(w * h);
	for (let i = 0, p = 0; i < w * h; i++, p += 4) {
		gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
	}

	// Sobel gradients + structure tensor products
	const gxx = new Float32Array(w * h);
	const gyy = new Float32Array(w * h);
	const gxy = new Float32Array(w * h);
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const ix =
				gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] -
				gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
			const iy =
				gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] -
				gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
			gxx[i] = ix * ix;
			gyy[i] = iy * iy;
			gxy[i] = ix * iy;
		}
	}

	// Min eigenvalue of the 3x3-windowed structure tensor
	const resp = new Float32Array(w * h);
	let maxResp = 0;
	for (let y = 2; y < h - 2; y++) {
		for (let x = 2; x < w - 2; x++) {
			const i = y * w + x;
			let sxx = 0,
				syy = 0,
				sxy = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const j = i + dy * w;
				sxx += gxx[j - 1] + gxx[j] + gxx[j + 1];
				syy += gyy[j - 1] + gyy[j] + gyy[j + 1];
				sxy += gxy[j - 1] + gxy[j] + gxy[j + 1];
			}
			const tr = sxx + syy;
			const det = Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy);
			const lambda = (tr - det) / 2;
			resp[i] = lambda;
			if (lambda > maxResp) maxResp = lambda;
		}
	}
	if (maxResp <= 0) return [];

	// One winner per grid cell keeps the mesh spread across the frame
	const cell = Math.max(8, Math.ceil(Math.sqrt((w * h) / maxPoints)));
	const thresh = maxResp * 0.005;
	const feats: Feature[] = [];
	for (let cy = 0; cy < h; cy += cell) {
		for (let cx = 0; cx < w; cx += cell) {
			let best = -1;
			let bx = 0,
				by = 0;
			const yEnd = Math.min(cy + cell, h - 2);
			const xEnd = Math.min(cx + cell, w - 2);
			for (let y = Math.max(cy, 2); y < yEnd; y++) {
				for (let x = Math.max(cx, 2); x < xEnd; x++) {
					const r = resp[y * w + x];
					if (r > best) {
						best = r;
						bx = x;
						by = y;
					}
				}
			}
			if (best > thresh) feats.push({ x: bx, y: by, score: best });
		}
	}
	feats.sort((a, b) => b.score - a.score);
	return feats.slice(0, maxPoints);
}

/**
 * Bowyer-Watson Delaunay triangulation. Returns unique edges as index
 * pairs into pts. Fine for a few hundred points.
 */
export function triangulate(pts: Array<{ x: number; y: number }>): Array<[number, number]> {
	const n = pts.length;
	if (n < 3) return n === 2 ? [[0, 1]] : [];

	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of pts) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	const span = Math.max(maxX - minX, maxY - minY, 1);
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;

	// Super-triangle vertices appended after the real points
	const vs = pts.map((p) => ({ x: p.x, y: p.y }));
	vs.push(
		{ x: cx - 20 * span, y: cy - span },
		{ x: cx + 20 * span, y: cy - span },
		{ x: cx, y: cy + 20 * span }
	);

	interface Tri {
		a: number;
		b: number;
		c: number;
		x: number; // circumcenter
		y: number;
		r2: number; // squared circumradius
	}

	const circum = (a: number, b: number, c: number): Tri | null => {
		const A = vs[a],
			B = vs[b],
			C = vs[c];
		const dd = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
		if (Math.abs(dd) < 1e-12) return null;
		const a2 = A.x * A.x + A.y * A.y;
		const b2 = B.x * B.x + B.y * B.y;
		const c2 = C.x * C.x + C.y * C.y;
		const ux = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / dd;
		const uy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / dd;
		const dx = A.x - ux;
		const dy = A.y - uy;
		return { a, b, c, x: ux, y: uy, r2: dx * dx + dy * dy };
	};

	let tris: Tri[] = [];
	const root = circum(n, n + 1, n + 2);
	if (!root) return [];
	tris.push(root);

	for (let i = 0; i < n; i++) {
		const p = vs[i];
		const bad: Tri[] = [];
		const keep: Tri[] = [];
		for (const t of tris) {
			const dx = p.x - t.x;
			const dy = p.y - t.y;
			(dx * dx + dy * dy <= t.r2 ? bad : keep).push(t);
		}
		// Boundary of the star-shaped hole = edges not shared by two bad tris
		const edgeCount = new Map<string, [number, number]>();
		const push = (u: number, v: number) => {
			const k = u < v ? `${u}_${v}` : `${v}_${u}`;
			if (edgeCount.has(k)) edgeCount.delete(k);
			else edgeCount.set(k, [u, v]);
		};
		for (const t of bad) {
			push(t.a, t.b);
			push(t.b, t.c);
			push(t.c, t.a);
		}
		tris = keep;
		for (const [u, v] of edgeCount.values()) {
			const t = circum(u, v, i);
			if (t) tris.push(t);
		}
	}

	const edges = new Set<string>();
	for (const t of tris) {
		for (const [u, v] of [
			[t.a, t.b],
			[t.b, t.c],
			[t.c, t.a]
		]) {
			if (u >= n || v >= n) continue; // drop super-triangle edges
			edges.add(u < v ? `${u}_${v}` : `${v}_${u}`);
		}
	}
	return Array.from(edges, (k) => k.split('_').map(Number) as [number, number]);
}

/** Mean luminance of a frame, 0..1 — match virtual paint to the room light. */
export function avgLuminance(img: ImageData): number {
	const d = img.data;
	const n = img.width * img.height;
	let sum = 0;
	for (let i = 0, p = 0; i < n; i++, p += 4) {
		sum += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
	}
	return sum / n / 255;
}

/** Sample the live camera feed's luminance (0..1); 0.45 if unavailable. */
export function videoLuminance(video: HTMLVideoElement | null): number {
	if (!video || !video.videoWidth) return 0.45;
	const c = document.createElement('canvas');
	c.width = 48;
	c.height = 48;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	if (!ctx) return 0.45;
	try {
		ctx.drawImage(video, 0, 0, 48, 48);
		return avgLuminance(ctx.getImageData(0, 0, 48, 48));
	} catch {
		return 0.45;
	}
}
