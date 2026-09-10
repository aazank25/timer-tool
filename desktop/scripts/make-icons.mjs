/**
 * Generates the app and tray icons as PNGs, so no binary assets live in git
 * and no image library is needed at build time. Plain PNG encoder: IHDR, one
 * deflated IDAT, IEND.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {(x:number,y:number)=>[number,number,number,number]} pixel */
function writePng(file, size, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  return file;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
/**
 * Antialiased coverage from a signed distance in pixels: 1 inside, 0 outside.
 * The feather is a constant ~1.5px at every size — scaling it with the icon
 * turns a 1024px render into a blur.
 */
const FEATHER = 1.5;
const edge = (distance) => clamp01(0.5 - distance / FEATHER);

/** Distance from a point to a segment, for capsule-shaped clock hands. */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * A clock: ring plus two hands. Returns coverage 0..1, so the monochrome tray
 * icon and the colour app icon share one shape.
 */
function clockCoverage(x, y, size) {
  const c = (size - 1) / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy);
  const outer = size * 0.42;
  const stroke = size * 0.075;

  // Ring: inside the outer edge and outside the inner edge.
  let coverage = Math.min(edge(r - outer), edge(outer - stroke - r));

  // Hands as capsules from the centre: 12 o'clock and 4 o'clock.
  const halfWidth = size * 0.037;
  for (const [angle, length] of [
    [0, 0.25],
    [(2 * Math.PI * 4) / 12, 0.19],
  ]) {
    const tipX = c + Math.sin(angle) * size * length;
    const tipY = c - Math.cos(angle) * size * length;
    coverage = Math.max(coverage, edge(distToSegment(x, y, c, c, tipX, tipY) - halfWidth));
  }
  return coverage;
}

const targets = [];

// Tray icons. macOS template images must be black plus alpha only; the system
// recolours them for light and dark menu bars.
for (const [size, name] of [
  [16, 'trayTemplate.png'],
  [32, 'trayTemplate@2x.png'],
  [48, 'trayTemplate@3x.png'],
]) {
  targets.push(
    writePng(path.join(root, 'assets', name), size, (x, y) => {
      const a = Math.round(clockCoverage(x, y, size) * 255);
      return [0, 0, 0, a];
    }),
  );
}

// App icon: white clock on the accent blue, rounded square. electron-builder
// turns this into .icns and .ico.
const ACCENT = [42, 120, 214];
for (const [size, name] of [
  [1024, 'icon.png'],
  [512, 'icon-512.png'],
]) {
  targets.push(
    writePng(path.join(root, 'build', name), size, (x, y) => {
      const radius = size * 0.22;
      const inset = size * 0.02;
      // Rounded-square mask.
      const px = Math.min(Math.max(x, inset + radius), size - 1 - inset - radius);
      const py = Math.min(Math.max(y, inset + radius), size - 1 - inset - radius);
      const d = Math.hypot(x - px, y - py);
      const bgAlpha = Math.round(edge(d - radius) * 255);
      const glyph = clockCoverage(x, y, size);
      const r = Math.round(ACCENT[0] * (1 - glyph) + 255 * glyph);
      const g = Math.round(ACCENT[1] * (1 - glyph) + 255 * glyph);
      const b = Math.round(ACCENT[2] * (1 - glyph) + 255 * glyph);
      return [r, g, b, bgAlpha];
    }),
  );
}

console.log(`[icons] wrote:\n${targets.map((t) => `  ${path.relative(root, t)}`).join('\n')}`);
