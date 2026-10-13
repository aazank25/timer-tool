/**
 * Generates the app and tray icons as PNGs (and the Windows tray icon as an .ico made of PNGs),
 * so no binary assets live in git and no image library is needed at build time. Plain PNG
 * encoder: IHDR, one deflated IDAT, IEND.
 *
 * Three sets come out:
 *   assets/trayTemplate*.png   the Mac's tray icon: black and see-through, which macOS recolours
 *   assets/tray*.png, tray.ico the tray icon of Windows and Linux: the app icon's look at tray
 *                              sizes, since nothing recolours an icon there, and a black one is
 *                              all but invisible on a dark taskbar. The .ico is for Windows, which
 *                              takes the size that suits the screen's scaling out of one file.
 *   build/icon*.png            the app icon, which electron-builder turns into .icns and .ico
 *
 * Run with a folder as its argument to write them there instead of beside the app (the tests do).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..');

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
function encodePng(size, pixel) {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

/** @param {(x:number,y:number)=>[number,number,number,number]} pixel */
function writePng(file, size, pixel) {
  return writeFile(file, encodePng(size, pixel));
}

/**
 * An .ico holding one PNG for each of `frames` (each { size, png }), which is how an icon file
 * carries a picture for every size: Windows picks the one that suits the screen's scaling, so a
 * tray icon is drawn at its own size and never stretched from another. A file is a header, a
 * 16-byte entry for each picture (its size and where it is), and then the pictures.
 */
function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 is an icon (2 would be a cursor)
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length + 16 * frames.length;
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width, with 0 for 256
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // colours in the palette: none, it is not paletted
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...frames.map(({ png }) => png)]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
/**
 * Antialiased coverage from a signed distance in pixels: 1 inside, 0 outside.
 * The feather is a constant ~1.5px at every size — scaling it with the icon
 * turns a 1024px render into a blur.
 */
const FEATHER = 1.5;
const edge = (distance, feather = FEATHER) => clamp01(0.5 - distance / feather);

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
 * icon and the colour app icon share one shape. The look is the app icon's unless
 * it says otherwise, and its proportions are right from 32px up; smaller than that
 * they are hairlines, so a look can thicken the ring and the hands (`weight`),
 * shorten the hands (`hands`) so they do not run into the ring, and sharpen the
 * edges (`feather`, in pixels).
 */
function clockCoverage(x, y, size, { weight = 1, hands = 1, feather = FEATHER } = {}) {
  const c = (size - 1) / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy);
  const outer = size * 0.42;
  const stroke = size * 0.075 * weight;

  // Ring: inside the outer edge and outside the inner edge.
  let coverage = Math.min(edge(r - outer, feather), edge(outer - stroke - r, feather));

  // Hands as capsules from the centre: 12 o'clock and 4 o'clock.
  const halfWidth = size * 0.037 * weight;
  for (const [angle, length] of [
    [0, 0.25],
    [(2 * Math.PI * 4) / 12, 0.19],
  ]) {
    const tipX = c + Math.sin(angle) * size * length * hands;
    const tipY = c - Math.cos(angle) * size * length * hands;
    coverage = Math.max(coverage, edge(distToSegment(x, y, c, c, tipX, tipY) - halfWidth, feather));
  }
  return coverage;
}

const ACCENT = [42, 120, 214];

/**
 * The app icon's picture at any size: a white clock on the accent blue, in a rounded square.
 * Returns the pixel [r, g, b, a] at (x, y), drawn in the given look (see clockCoverage), which
 * can also set the empty `margin` round the square, in whole pixels: on a pixel boundary its
 * straight edges are sharp, where 2% of the size would land them anywhere. Without one the
 * margin is 2% of the size.
 */
function tilePixel(x, y, size, look = {}) {
  const radius = size * 0.22;
  // Pixel x covers x - 0.5 to x + 0.5, so a margin of m pixels puts the edge at m - 0.5.
  const inset = look.margin === undefined ? size * 0.02 : look.margin - 0.5;
  // Rounded-square mask.
  const px = Math.min(Math.max(x, inset + radius), size - 1 - inset - radius);
  const py = Math.min(Math.max(y, inset + radius), size - 1 - inset - radius);
  const d = Math.hypot(x - px, y - py);
  const bgAlpha = Math.round(edge(d - radius, look.feather) * 255);
  const glyph = clockCoverage(x, y, size, look);
  const r = Math.round(ACCENT[0] * (1 - glyph) + 255 * glyph);
  const g = Math.round(ACCENT[1] * (1 - glyph) + 255 * glyph);
  const b = Math.round(ACCENT[2] * (1 - glyph) + 255 * glyph);
  return [r, g, b, bgAlpha];
}

/**
 * How the picture is drawn in a tray icon of this size. A tray icon is 16px on a screen at 100%
 * and is drawn at 20, 24 and 32 as the scaling goes up, and the clock has to be read at each: the
 * smaller the icon, the heavier the lines, and the edges are always sharp, since a tray icon is
 * shown pixel for pixel. The margin is about a sixteenth of the size.
 */
function trayLook(size) {
  const sharp = { feather: 1 };
  if (size <= 16) return { ...sharp, weight: 1.5, hands: 0.8, margin: 1 };
  if (size <= 20) return { ...sharp, weight: 1.35, hands: 0.85, margin: 1 };
  if (size <= 24) return { ...sharp, weight: 1.25, hands: 0.9, margin: 1 };
  if (size <= 32) return { ...sharp, weight: 1.1, hands: 1, margin: 2 };
  return { ...sharp, weight: 1, hands: 1, margin: Math.round(size / 16) };
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

// Tray icons for Windows and Linux. Nothing there recolours an icon, and the black template
// above is all but invisible on a dark taskbar, so these are the app icon's look: a light
// clock on its blue square, which shows against a dark taskbar and a light one alike.
// tray.png, @2x and @3x are what Linux takes (the sizes the Mac's are, 16, 32 and 48px) and
// what Windows falls back on; tray.ico is Windows', with a picture for each screen scaling
// (100% is 16px, then 20, 24 and 32 for 125%, 150% and 200%, and larger beyond that).
const trayPixel = (size) => (x, y) => tilePixel(x, y, size, trayLook(size));
for (const [size, name] of [
  [16, 'tray.png'],
  [32, 'tray@2x.png'],
  [48, 'tray@3x.png'],
]) {
  targets.push(writePng(path.join(root, 'assets', name), size, trayPixel(size)));
}
targets.push(
  writeFile(
    path.join(root, 'assets', 'tray.ico'),
    encodeIco(
      [16, 20, 24, 32, 48, 64].map((size) => ({ size, png: encodePng(size, trayPixel(size)) })),
    ),
  ),
);

// App icon: white clock on the accent blue, rounded square. electron-builder
// turns this into .icns and .ico.
for (const [size, name] of [
  [1024, 'icon.png'],
  [512, 'icon-512.png'],
]) {
  targets.push(writePng(path.join(root, 'build', name), size, (x, y) => tilePixel(x, y, size)));
}

console.log(`[icons] wrote:\n${targets.map((t) => `  ${path.relative(root, t)}`).join('\n')}`);
