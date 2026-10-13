import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

/**
 * What main.mjs does with Electron cannot be run without Electron, so these read it, the way the
 * packaging tests read the scripts: they hold the calls that keep the app private and keep it from
 * showing a Mac's habits on Windows in place, and in the order that matters. (Running the app is
 * what shows that they work; this is what shows they have not been taken out.)
 */
const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const main = read('main.mjs');
const palette = read('palette.mjs');

/** The source of `function name(...) { ... }`: from its first line to the closing brace at the margin. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.mjs has no function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

/** Where the app makes its first window, once the server is up: nothing may be made before this is done. */
const firstWindow = main.search(/createWindow\(\);\s*createTray\(\);/);

describe('the spell checker', () => {
  const body = functionBody(main, 'keepSpellCheckerOffline');

  it('is switched off, and its languages emptied, which is what stops the dictionary download', () => {
    assert.match(body, /electronSession\.defaultSession\.setSpellCheckerEnabled\(false\)/);
    assert.match(body, /electronSession\.defaultSession\.setSpellCheckerLanguages\(\[\]\)/);
  });

  it('is left alone on a Mac, which checks with its own and downloads nothing', () => {
    assert.match(body, /if \(isMac\) return;/);
  });

  it('is done before the first window is made, and before anything is loaded', () => {
    const call = main.search(/^ +keepSpellCheckerOffline\(\);$/m);
    assert.ok(call > 0, 'keepSpellCheckerOffline is never called');
    assert.ok(firstWindow > 0 && call < firstWindow, 'it is called after the first window');
    assert.ok(
      call < main.indexOf('startServer, normalizeAccelerator'),
      'it is called after the server',
    );
  });

  it('is on the session both windows use: neither names a session or a partition of its own', () => {
    for (const [name, source] of [
      ['main.mjs', main],
      ['palette.mjs', palette],
    ]) {
      assert.doesNotMatch(source, /\bpartition\s*:|fromPartition\s*\(/, name);
      // A webPreferences { session } would be another session.
      assert.doesNotMatch(source, /webPreferences:\s*\{[^}]*\bsession\s*:/s, name);
    }
  });
});

describe('the application menu', () => {
  it('is taken away off a Mac, and left as it is on one', () => {
    const body = functionBody(main, 'dropApplicationMenu');
    assert.match(body, /if \(!isMac\) Menu\.setApplicationMenu\(null\);/);
    assert.doesNotMatch(main, /setApplicationMenu\((?!null\))/, "a Mac's menu is not replaced");
  });

  it('is taken away before the first window is made', () => {
    const call = main.search(/^ +dropApplicationMenu\(\);$/m);
    assert.ok(call > 0 && call < firstWindow);
  });
});

describe('the shortcuts FocusDesk registers for itself', () => {
  it('are written with CommandOrControl, which is Command on a Mac and Control on Windows and Linux', () => {
    const literals = [
      ...main.matchAll(/(?:globalShortcut\.register|accelerator:)\(?\s*'([^']+)'/g),
    ].map((match) => match[1]);
    assert.ok(literals.includes('CommandOrControl+Shift+F'), 'show the window');
    assert.ok(literals.includes('CommandOrControl+Shift+Space'), 'pause or resume');
    for (const accelerator of literals) {
      assert.match(accelerator, /^CommandOrControl\+/, accelerator);
    }
  });
});
