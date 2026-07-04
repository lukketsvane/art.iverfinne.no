// Generates static/icons/icon-{192,512}.png without any image dependency:
// raw RGBA → zlib → hand-assembled PNG chunks. Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function crc32(buf) {
	let c,
		crc = 0xffffffff;
	for (let n = 0; n < buf.length; n++) {
		c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function png(size, pixelAt) {
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0; // filter: none
		for (let x = 0; x < size; x++) {
			const [r, g, b, a] = pixelAt(x, y);
			const o = y * (size * 4 + 1) + 1 + x * 4;
			raw[o] = r;
			raw[o + 1] = g;
			raw[o + 2] = b;
			raw[o + 3] = a;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// Icon: dark rounded tile, magenta→cyan diagonal spray dot cluster ("A" hint).
function makeIcon(size) {
	const R = size * 0.2; // corner radius
	const cx = size / 2;
	return png(size, (x, y) => {
		// rounded-rect mask
		const dx = Math.max(0, Math.max(R - x, x - (size - 1 - R)));
		const dy = Math.max(0, Math.max(R - y, y - (size - 1 - R)));
		if (dx * dx + dy * dy > R * R) return [0, 0, 0, 0];

		// background
		let [r, g, b] = [11, 11, 15];

		// spray "A": two legs + crossbar drawn as thick lines of dots
		const t = size * 0.075; // stroke half-width
		const topY = size * 0.22,
			botY = size * 0.8;
		const spread = size * 0.21;
		const legL = Math.abs(x - (cx - (spread * (y - topY)) / (botY - topY)));
		const legR = Math.abs(x - (cx + (spread * (y - topY)) / (botY - topY)));
		const inV = y > topY && y < botY;
		const barY = size * 0.62;
		const inBar =
			Math.abs(y - barY) < t * 0.8 && Math.abs(x - cx) < (spread * (barY - topY)) / (botY - topY);
		if ((inV && (legL < t || legR < t)) || inBar) {
			const k = y / size; // gradient magenta → cyan
			r = Math.round(225 * (1 - k) + 34 * k);
			g = Math.round(29 * (1 - k) + 211 * k);
			b = Math.round(255 * (1 - k) + 238 * k);
		}
		return [r, g, b, 255];
	});
}

mkdirSync('static/icons', { recursive: true });
for (const size of [192, 512]) {
	writeFileSync(`static/icons/icon-${size}.png`, makeIcon(size));
	console.log(`wrote static/icons/icon-${size}.png`);
}
