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
  const shortcuts = read('shortcuts.mjs');

  it('are not written in main.mjs: no shortcut is hard-coded, to register or to label a menu with', () => {
    // A key combination as text: a modifier, a plus, and something after it.
    const combination =
      /['"`](?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\+[^'"`]*['"`]/i;
    assert.doesNotMatch(main, combination);
    // Nothing is registered but through the plan: main.mjs does not call globalShortcut.register at all.
    assert.doesNotMatch(main, /globalShortcut\.register\(/);
    // And the tray menu's accelerator is the one that is registered, never a string of its own.
    assert.doesNotMatch(main, /\baccelerator:\s*['"`]/);
  });

  it('are registered through the settings plan: one manager, handed globalShortcut and what each does', () => {
    assert.match(main, /import \{[^}]*\bcreateHotkeys\b[^}]*\} from '\.\/shortcuts\.mjs';/);
    const made = main.match(/const hotkeys = createHotkeys\(\{([\s\S]*?)\n\}\);/);
    assert.ok(made, 'main.mjs makes no hotkeys');
    assert.match(made[1], /\bglobalShortcut,/);
    // Each is handed to Electron the way the system spells it (Command as Super off a Mac).
    assert.match(made[1], /toSystem: forElectron,/);
    assert.match(made[1], /normalize: \(text\) => normalizeAccelerator\(text\)/);
    for (const action of ['show', 'pause', 'quickSwitch']) {
      assert.match(made[1], new RegExp(`\\b${action}:`), `${action} has nothing to do`);
    }
  });

  it('are read from the settings each time they are applied, and applied through the manager', () => {
    const body = functionBody(main, 'applyHotkeys');
    assert.match(body, /settings = await api\('\/settings'\)/);
    assert.match(body, /hotkeys\.apply\(settings\)/);
    // The tray's label follows what was registered.
    assert.match(body, /renderMenu\(\)/);
  });

  it('are applied when the app starts, once the server is up and the tray is there, and when asked', () => {
    // At the start, and not before there is a server to ask for the settings.
    const start = main.indexOf('await syncHotkeys()');
    assert.ok(start > main.indexOf('server = await startServer('), 'applied before the server is up');
    assert.ok(start > firstWindow, 'applied before the first window and the tray');
    // And again whenever Settings asks, one at a time (see syncHotkeys).
    assert.match(main, /ipcMain\.handle\('hotkeys:reload', \(\) => syncHotkeys\(\)\)/);
    assert.match(functionBody(main, 'syncHotkeys'), /hotkeyQueue\.then\(applyHotkeys\)/);
  });

  it('go through Electron only as the system spells them, in the one place that registers them', () => {
    // Every call into globalShortcut is given the shortcut as forElectron spells it (toSystem here).
    const calls = [...shortcuts.matchAll(/globalShortcut\.(register|unregister|isRegistered)\(\s*([^,)]+)/g)];
    assert.ok(calls.length >= 4, 'shortcuts.mjs makes no calls into globalShortcut');
    for (const [, method, given] of calls) {
      assert.match(given, /^(system|toSystem\()/, `${method} is handed ${given}`);
    }
  });

  it('are shown by the tray as the one registered: its label has no key of its own, and the menu is rebuilt when it changes', () => {
    const body = functionBody(main, 'renderMenu');
    assert.match(body, /const showHotkey = hotkeys\.active\(\)\.show;/);
    // In the signature, or the menu would be left saying the shortcut it had before.
    const signature = body.match(/const signature = JSON\.stringify\(\[([\s\S]*?)\]\);/);
    assert.ok(signature, 'the menu has no signature');
    assert.match(signature[1], /\bshowHotkey,/);
    // A key on the label when there is one, and none when it is off.
    assert.match(
      body,
      /label: 'Open FocusDesk',[\s\S]*?\.\.\.\(showHotkey \? \{ accelerator: forElectron\(showHotkey\) \} : \{\}\),/,
    );
  });
});

describe('the quick-switch box from inside the window', () => {
  it('opens on ⌘K in the main window, whose key is not given to the page, and in no other window', () => {
    const body = functionBody(main, 'createWindow');
    const handler = body.match(
      /win\.webContents\.on\('before-input-event', \(event, input\) => \{([\s\S]*?)\n {2}\}\);/,
    );
    assert.ok(handler, 'the main window does not listen to its keys');
    assert.match(handler[1], /if \(!opensQuickSwitch\(input, process\.platform\)\) return;/);
    assert.match(handler[1], /event\.preventDefault\(\);/);
    assert.match(handler[1], /openQuickSwitch\(\);/);
    // The quick-switch box is the other window, and it has nothing to open.
    assert.doesNotMatch(read('palette.mjs'), /before-input-event/);
  });

  it('opens it the way the shortcut does, and never throws into Electron', () => {
    const body = functionBody(main, 'openQuickSwitch');
    assert.match(body, /palette\.showPalette\(\);/);
    assert.match(body, /catch \(err\)/);
    assert.match(main, /quickSwitch: openQuickSwitch/);
  });
});

describe('the notifications', () => {
  it('are held back by the settings: what the app hands the notifications is the rule, as the settings were last read', () => {
    const made = main.match(/attention = createAttention\(\{([\s\S]*?)\n {2}\}\);/);
    assert.ok(made, 'main.mjs makes no attention');
    assert.match(made[1], /notifyAllowed: \(kind\) => notificationAllowed\(kind, settings\),/);
  });

  it('show a sample when asked, with the real Notification, whatever the settings say', () => {
    assert.match(
      main,
      /ipcMain\.handle\('notification:test', \(\) => showTestNotification\(\{ Notification \}\)\)/,
    );
  });
});
