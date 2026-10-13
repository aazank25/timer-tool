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
    assert.match(functionBody(main, 'syncHotkeys'), /inHotkeyOrder\(applyHotkeys\)/);
    assert.match(functionBody(main, 'inHotkeyOrder'), /hotkeyQueue\.then\(task\)/);
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

describe('the shortcuts being let go of while Settings records a key', () => {
  it('are let go of when the page asks over hotkeys:suspend, and given back when it asks again, from the main window only', () => {
    const handler = main.match(
      /ipcMain\.handle\('hotkeys:suspend', async \(event, on\) => \{([\s\S]*?)\n {2}\}\);/,
    );
    assert.ok(handler, 'main.mjs has no handler for hotkeys:suspend');
    assert.match(handler[1], /if \(event\.sender !== win\?\.webContents\) return;/);
    assert.match(handler[1], /await \(on === true \? suspendHotkeys\(\) : resumeHotkeys\(\)\);/);
  });

  it('are let go of through the one line that the registrations are in, so that what is asked in one order is done in it', () => {
    const body = functionBody(main, 'suspendHotkeys');
    assert.match(body, /return inHotkeyOrder\(\(\) => hotkeys\.suspend\(\)\);/);
    assert.match(body, /suspendAsked = true;/);
  });

  it('are taken again at once as they were, and then from the settings as they are now', () => {
    const body = functionBody(main, 'resumeHotkeys');
    assert.match(body, /suspendAsked = false;/);
    assert.match(body, /clearTimeout\(suspendTimer\);/);
    // The first needs nothing from anywhere, so it cannot fail the way a read of the settings can.
    assert.ok(body.indexOf('hotkeys.resume();') > 0, 'it does not take them again at once');
    assert.ok(body.indexOf('hotkeys.resume();') < body.indexOf('return syncHotkeys();'));
  });

  it('are given back by themselves after a minute at most, whatever the page does', () => {
    assert.match(main, /const SUSPEND_MAX_MS = 60_000;/);
    const body = functionBody(main, 'suspendHotkeys');
    assert.match(body, /clearTimeout\(suspendTimer\);/);
    assert.match(body, /suspendTimer = setTimeout\(\(\) => \{[\s\S]*?resumeHotkeys\(\)\.catch\([\s\S]*?\}, SUSPEND_MAX_MS\);/);
  });

  it('are given back when the main window loses the focus, is hidden or closed, or its page is reloaded, moved or gone', () => {
    const body = functionBody(main, 'createWindow');
    assert.match(
      body,
      /const giveBackHotkeys = \(\) => \{\s*if \(!suspendAsked\) return;\s*resumeHotkeys\(\)\.catch\(/,
    );
    for (const event of ['blur', 'hide', 'close']) {
      assert.match(body, new RegExp(`win\\.on\\('${event}', giveBackHotkeys\\);`), event);
    }
    // A move to another document, which a reload is; not one inside the page, which the page's own
    // router makes and which does not end what the page is doing.
    assert.match(
      body,
      /win\.webContents\.on\('did-start-navigation', \(details\) => \{\s*if \(details\.isMainFrame && !details\.isSameDocument\) giveBackHotkeys\(\);\s*\}\);/,
    );
    assert.match(body, /win\.webContents\.on\('render-process-gone', giveBackHotkeys\);/);
  });

  it('are given back only while they are let go of, so that the window losing the focus costs nothing the rest of the time', () => {
    const body = functionBody(main, 'createWindow');
    assert.match(body, /if \(!suspendAsked\) return;/);
    assert.match(main, /^let suspendAsked = false;$/m);
    // A failure to take them again is logged, and is not an unhandled rejection in the main process.
    assert.doesNotMatch(body, /void resumeHotkeys\(\)/);
  });

  it('are let go of by the main window only: the quick-switch box is not a page that records a key', () => {
    assert.doesNotMatch(palette, /suspendHotkeys|hotkeys:suspend/);
  });

  it('are registered again by the reload that applies the settings, which ends a suspension too', () => {
    // main.mjs asks for nothing special: createHotkeys.apply takes them again first (shortcuts.test.mjs).
    assert.match(functionBody(main, 'applyHotkeys'), /hotkeyStatuses = hotkeys\.apply\(settings\);/);
  });
});

describe('the status each shortcut is given', () => {
  it('says "unreadable" when the settings could not be read, so that nobody has to read the words to know nothing was tried', () => {
    const body = functionBody(main, 'applyHotkeys');
    assert.match(body, /\{ ok: false, accelerator, code: 'unreadable', error: unread \}/);
  });

  it('is kept as the tray reads it, from the last registration: a failed read of the settings is not one', () => {
    const body = functionBody(main, 'applyHotkeys');
    const unreadable = body.indexOf("code: 'unreadable'");
    const kept = body.indexOf('hotkeyStatuses = hotkeys.apply(settings);');
    assert.ok(unreadable > 0 && kept > unreadable, 'the unread answer comes first and returns');
    assert.match(body.slice(0, kept), /if \(unread && settings\) \{\s*return /);
    // The answer for the page is the same object the tray reads.
    assert.match(body, /return hotkeyStatuses;/);
    assert.match(main, /^let hotkeyStatuses = null;$/m);
  });
});

describe('the tray when a shortcut is not working', () => {
  const body = functionBody(main, 'renderMenu');

  it('says so in an item under "Open FocusDesk" that opens Settings, and only when one is not', () => {
    assert.match(body, /\.\.\.hotkeyMenuItems\(hotkeyStatuses, \(\) => showWindow\('\/settings'\)\),/);
    const open = body.indexOf("label: 'Open FocusDesk'");
    const item = body.indexOf('...hotkeyMenuItems(');
    const next = body.indexOf("label: 'Launch at login'");
    assert.ok(open > 0 && item > open && item < next, 'the item is not in the group of Open FocusDesk');
  });

  it('is in the signature of the menu, or a menu built without it would never be built with it', () => {
    assert.match(body, /const hotkeyTrouble = hotkeysFailing\(hotkeyStatuses\);/);
    const signature = body.match(/const signature = JSON\.stringify\(\[([\s\S]*?)\]\);/);
    assert.ok(signature, 'the menu has no signature');
    assert.match(signature[1], /\bhotkeyTrouble,/);
    assert.match(signature[1], /\bshowHotkey,/, 'the key on Open FocusDesk is still in it');
  });

  it('is built again each time the shortcuts are applied, after what it reads has been set', () => {
    const apply = functionBody(main, 'applyHotkeys');
    assert.ok(apply.indexOf('hotkeyStatuses = hotkeys.apply(settings);') < apply.indexOf('renderMenu();'));
  });

  it('is told of by the real menu in the end-to-end tests, which can read and choose it', () => {
    assert.match(main, /hotkeyStatuses: \(\) => \(hotkeyStatuses \? JSON\.parse\(JSON\.stringify\(hotkeyStatuses\)\) : null\),/);
    assert.match(main, /hotkeysSuspended: \(\) => hotkeys\.suspended\(\),/);
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
