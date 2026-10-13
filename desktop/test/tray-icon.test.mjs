import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { trayIconFiles } from '../menu-bar.mjs';

const script = fileURLToPath(new URL('../scripts/make-icons.mjs', import.meta.url));

/** Where the icons are made: not beside the app, so that running the tests changes nothing in it. */
let out;

before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-icons-'));
  execFileSync(process.execPath, [script, out], { stdio: 'pipe' });
});

after(() => {
  fs.rmSync(out, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- reading the files back */

/** A PNG as { width, height, pixels }, pixels being RGBA bytes row by row. Eight bits, with alpha. */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = 0;
  let height = 0;
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, 'eight bits a channel');
      assert.equal(body[9], 6, 'colour with alpha');
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const byte = raw[y * (stride + 1) + 1 + i];
      const left = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4] : 0;
      const guess = left + up - upLeft;
      const paeth = [left, up, upLeft].sort((a, b) => Math.abs(guess - a) - Math.abs(guess - b))[0];
      const prior = [0, left, up, (left + up) >> 1, paeth][filter];
      pixels[y * stride + i] = (byte + prior) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** An .ico as its pictures, each { width, height, planes, bits, png }, in the order they are listed. */
function readIco(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0, 'reserved');
  assert.equal(bytes.readUInt16LE(2), 1, 'an icon, not a cursor');
  const count = bytes.readUInt16LE(4);
  const pictures = [];
  let expected = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    // The pictures follow the list one after another, and the file ends with the last.
    assert.equal(offset, expected, `picture ${i} starts where the one before it ends`);
    expected += length;
    pictures.push({
      width: bytes[at] || 256,
      height: bytes[at + 1] || 256,
      planes: bytes.readUInt16LE(at + 4),
      bits: bytes.readUInt16LE(at + 6),
      png: bytes.subarray(offset, offset + length),
    });
  }
  assert.equal(bytes.length, expected, 'nothing is left over at the end of the file');
  return pictures;
}

const asset = (name) => fs.readFileSync(path.join(out, 'assets', name));

/* --------------------------------------------------------------------- how it is seen */

/** WCAG's relative luminance of an sRGB colour: how light it looks, 0 for black and 1 for white. */
function luminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG's contrast ratio of two colours: 1 for the same, 21 for black on white. 3 is its floor for a picture. */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The colours a taskbar is: dark and light as Windows draws them, and the extremes either could be. */
const TASKBARS = {
  black: [0, 0, 0],
  dark: [32, 32, 32],
  light: [243, 243, 243],
  white: [255, 255, 255],
};

/** The colour most of an icon's solid pixels are, and the lightest one: its square and its clock. */
function squareAndClock({ pixels }) {
  const counts = new Map();
  let clock = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 255) continue;
    const colour = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const key = colour.join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (luminance(colour) > luminance(clock)) clock = colour;
  }
  const [square] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { square: square.split(',').map(Number), clock };
}

/** How much of the icon's area is its square (alpha half or more), 0 to 1. */
function filled({ pixels }) {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] >= 128) count++;
  return count / (pixels.length / 4);
}

describe('the icon files that are made', () => {
  it('are all there for every platform to find its own tray icon in', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const file of trayIconFiles(platform)) {
        assert.ok(fs.existsSync(path.join(out, 'assets', file)), `${platform}: assets/${file}`);
      }
    }
  });

  it('are a tray icon of 16, 32 and 48 pixels for Windows and Linux, as there are for the Mac', () => {
    for (const [name, size] of [
      ['tray.png', 16],
      ['tray@2x.png', 32],
      ['tray@3x.png', 48],
      ['trayTemplate.png', 16],
      ['trayTemplate@2x.png', 32],
      ['trayTemplate@3x.png', 48],
    ]) {
      const { width, height } = decodePng(asset(name));
      assert.deepEqual([width, height], [size, size], name);
    }
  });
});

describe("the Mac's tray icon", () => {
  it('is black and see-through and nothing else, which is all macOS may recolour', () => {
    for (const name of ['trayTemplate.png', 'trayTemplate@2x.png', 'trayTemplate@3x.png']) {
      const { pixels } = decodePng(asset(name));
      let drawn = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2]], [0, 0, 0], name);
        if (pixels[i + 3] > 0) drawn++;
      }
      assert.ok(drawn > 20, `${name} is not empty`);
    }
  });

  it('is what Windows and Linux are not given: black on a dark taskbar cannot be told from it', () => {
    assert.ok(contrast([0, 0, 0], TASKBARS.dark) < 1.5);
  });
});

describe('the tray icon of Windows and Linux', () => {
  /** Every picture of it that there is: the three PNGs, and each size in the .ico. */
  const pictures = () => [
    ...['tray.png', 'tray@2x.png', 'tray@3x.png'].map((name) => ({
      name,
      ...decodePng(asset(name)),
    })),
    ...readIco(asset('tray.ico')).map((picture) => ({
      name: `tray.ico ${picture.width}px`,
      ...decodePng(picture.png),
    })),
  ];

  it('shows against a dark taskbar and a light one: its square is at least 3:1 to each, as a picture must be', () => {
    for (const picture of pictures()) {
      const { square } = squareAndClock(picture);
      for (const [taskbar, colour] of Object.entries(TASKBARS)) {
        const ratio = contrast(square, colour);
        assert.ok(ratio >= 3, `${picture.name} on ${taskbar}: ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('shows its clock against its square, which does not depend on the taskbar at all', () => {
    for (const picture of pictures()) {
      const { square, clock } = squareAndClock(picture);
      const ratio = contrast(clock, square);
      assert.ok(ratio >= 3, `${picture.name}: ${ratio.toFixed(2)}:1`);
    }
  });

  it('fills most of its picture, so that it is not a small thing in a corner', () => {
    for (const picture of pictures()) {
      assert.ok(filled(picture) > 0.6, `${picture.name}: ${filled(picture).toFixed(2)}`);
    }
  });

  it('has a clock in it, and not only a square: light pixels are a tenth to a half of it', () => {
    for (const picture of pictures()) {
      const { square, clock } = squareAndClock(picture);
      const middle = (luminance(square) + luminance(clock)) / 2;
      let light = 0;
      let solid = 0;
      for (let i = 0; i < picture.pixels.length; i += 4) {
        if (picture.pixels[i + 3] < 255) continue;
        solid++;
        const colour = [picture.pixels[i], picture.pixels[i + 1], picture.pixels[i + 2]];
        if (luminance(colour) > middle) light++;
      }
      const share = light / solid;
      assert.ok(share > 0.1 && share < 0.5, `${picture.name}: ${share.toFixed(2)}`);
    }
  });
});

describe('the .ico of the Windows tray icon', () => {
  const pictures = () => readIco(asset('tray.ico'));

  it('has a picture for each size Windows asks for as the screen is scaled: 100%, 125%, 150%, 200%, 300%, 400%', () => {
    assert.deepEqual(
      pictures().map((p) => p.width),
      [16, 20, 24, 32, 48, 64],
    );
  });

  it('is made of square, 32-bit pictures, each of the size it is listed as', () => {
    for (const picture of pictures()) {
      assert.equal(picture.width, picture.height);
      assert.equal(picture.planes, 1);
      assert.equal(picture.bits, 32);
      const decoded = decodePng(picture.png);
      assert.deepEqual([decoded.width, decoded.height], [picture.width, picture.height]);
    }
  });

  it('is the same picture as the PNGs at the sizes they share, so that nothing depends on which is read', () => {
    const bySize = new Map(pictures().map((picture) => [picture.width, decodePng(picture.png)]));
    for (const [name, size] of [
      ['tray.png', 16],
      ['tray@2x.png', 32],
      ['tray@3x.png', 48],
    ]) {
      assert.deepEqual(bySize.get(size).pixels, decodePng(asset(name)).pixels, name);
    }
  });
});
