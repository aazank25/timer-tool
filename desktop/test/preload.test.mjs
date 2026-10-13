import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

/**
 * The bridge a page is given (preload.cjs) is the whole of what it can ask of the shell, so it is
 * read here as Electron would run it: with a contextBridge that takes what is exposed and an
 * ipcRenderer that records what is sent. A page's side of the contract is these names and the
 * channels behind them, and main.mjs's side is a handler on each of the channels.
 */
const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const preload = read('preload.cjs');
const main = read('main.mjs');

/** Run the preload script against a fake Electron, and hand back what it exposed and what it did. */
function load() {
  const exposed = {};
  const sent = [];
  const listeners = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      send: (...args) => sent.push(['send', ...args]),
      invoke: (...args) => {
        sent.push(['invoke', ...args]);
        return Promise.resolve({ answered: args[0] });
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  };
  const run = vm.runInNewContext(`(function (require) {\n${preload}\n})`, {});
  run((name) => {
    assert.equal(name, 'electron', 'the preload asks for nothing but Electron');
    return electron;
  });
  return { api: exposed.focusdesk, exposed, sent, listeners };
}

describe('what the pages are given', () => {
  it('is one object, window.focusdesk, and nothing else on the window', () => {
    const { exposed } = load();
    assert.deepEqual(Object.keys(exposed), ['focusdesk']);
  });

  it('is these five calls: the box, the box being shown, the shortcuts read and let go of, and a sample notification', () => {
    const { api } = load();
    assert.deepEqual(Object.keys(api).sort(), [
      'closePalette',
      'onPaletteShow',
      'reloadHotkeys',
      'suspendHotkeys',
      'testNotification',
    ]);
    for (const name of Object.keys(api)) assert.equal(typeof api[name], 'function', name);
  });

  it('has no reloadHotkey any more: there are three shortcuts, and it is reloadHotkeys', () => {
    const { api } = load();
    assert.equal('reloadHotkey' in api, false);
    assert.doesNotMatch(preload, /reloadHotkey\b/);
    assert.doesNotMatch(preload, /'hotkey:reload'/);
    assert.doesNotMatch(main, /'hotkey:reload'/);
  });

  it('asks for the three shortcuts to be read again through hotkeys:reload, with nothing sent', async () => {
    const { api, sent } = load();

    const answer = await api.reloadHotkeys('anything', 'is not passed on');

    assert.deepEqual(sent, [['invoke', 'hotkeys:reload']]);
    assert.deepEqual(answer, { answered: 'hotkeys:reload' });
  });

  it('asks for the shortcuts to be let go of through hotkeys:suspend, sending true, and to be taken again sending false', async () => {
    const { api, sent } = load();

    await api.suspendHotkeys(true);
    await api.suspendHotkeys(false);

    assert.deepEqual(sent, [
      ['invoke', 'hotkeys:suspend', true],
      ['invoke', 'hotkeys:suspend', false],
    ]);
  });

  it('lets the shortcuts go only for exactly true: anything else, or nothing, is a request to take them again', async () => {
    const { api, sent } = load();

    // A string that says "false" is truthy, and a page that gets this wrong must not take the keys away.
    for (const not of [undefined, null, 'true', 'false', 1, 0, {}, [], () => true]) {
      await api.suspendHotkeys(not);
    }
    await api.suspendHotkeys();
    await api.suspendHotkeys(true, 'nothing else is passed on');

    assert.deepEqual(
      sent.map(([, channel, on]) => [channel, on]),
      [...Array(10).fill(['hotkeys:suspend', false]), ['hotkeys:suspend', true]],
    );
    // And the call itself sends nothing but the flag.
    assert.ok(sent.every((call) => call.length === 3));
  });

  it('asks for a sample notification through notification:test, with nothing sent', async () => {
    const { api, sent } = load();

    const answer = await api.testNotification('anything', 'is not passed on');

    assert.deepEqual(sent, [['invoke', 'notification:test']]);
    assert.deepEqual(answer, { answered: 'notification:test' });
  });

  it('still closes the box and hears of it being shown, as it did', () => {
    const { api, sent, listeners } = load();

    api.closePalette();
    assert.deepEqual(sent, [['send', 'palette:close']]);

    let shown = 0;
    const stop = api.onPaletteShow(() => shown++);
    listeners.get('palette:show')({ sender: 'not for the page' });
    assert.equal(shown, 1);
    stop();
    assert.equal(listeners.has('palette:show'), false);
    // Nothing to run, so nothing is listened for.
    assert.equal(typeof api.onPaletteShow('not a function'), 'function');
  });

  it('has a handler in the main process behind every channel it invokes, and sends to the one it sends to', () => {
    const channels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(channels.sort(), ['hotkeys:reload', 'hotkeys:suspend', 'notification:test']);
    for (const channel of channels) {
      assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`), channel);
    }
    // The box is closed by a message, and palette.mjs listens for it.
    assert.match(read('palette.mjs'), /ipcMain\.on\('palette:close'/);
  });

  it('has its handlers in place before either window is made, so no page calls one that is not there', () => {
    const firstWindow = main.search(/createWindow\(\);\s*createTray\(\);/);
    for (const channel of ['hotkeys:reload', 'hotkeys:suspend', 'notification:test']) {
      const at = main.indexOf(`ipcMain.handle('${channel}'`);
      assert.ok(at > 0 && at < firstWindow, channel);
    }
  });
});
