import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/**
 * main.mjs, started for real against stand-ins for Electron and for the server, and read off
 * what it handed them and in what order: the key it starts the server with and sends, the rules
 * it puts on the session before there is a window, what a page's links reach, how its windows
 * are made, and the environment it settles. main-wiring.test.mjs reads the source; this runs it.
 *
 * Electron is not there outside the app, and ./dist/server.mjs only after a build, so Node is
 * told to load a stand-in for each (a resolve hook, see `start`). main.mjs starts the app as it
 * is imported and leaves timers running, so each start is a process of its own, which prints
 * what it saw as one line of JSON and exits.
 */

const desktop = fileURLToPath(new URL('..', import.meta.url));
const MAIN = pathToFileURL(path.join(desktop, 'main.mjs')).href;
const SERVER_URL = 'http://127.0.0.1:41234';
const KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * What runs in the process of its own. It is sent there as source, so it uses nothing from out
 * here but its arguments.
 */
async function start(MAIN, SERVER_URL, packaged) {
  const { register } = await import('node:module');
  const { format } = await import('node:util');
  const seen = { events: [], fetches: [], opened: [], logs: [], windows: [], handlers: {} };
  globalThis.__standIn = seen;
  const record = (event) => seen.events.push(event);
  // What main.mjs prints is kept, not shown: the one line printed is what was seen.
  for (const level of ['log', 'info', 'warn', 'error']) {
    console[level] = (...args) => seen.logs.push(format(...args));
  }

  /* Electron, as far as main.mjs and palette.mjs use it. */
  let boot = null;
  const app = {
    isPackaged: packaged,
    whenReady: () => ({ then: (callback) => void (boot = callback) }),
    requestSingleInstanceLock: () => true,
    getPath: (name) => `/stand-in/${name}`,
    on: () => {},
    quit: () => record('app.quit'),
    exit: (code) => record(`app.exit ${code}`),
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    setAppUserModelId: () => {},
    dock: { hide: () => {}, show: () => {} },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.url = '';
      this.visible = false;
      const listeners = {};
      this.webContents = {
        listeners,
        on: (event, listener) => void (listeners[event] ??= []).push(listener),
        setWindowOpenHandler: (handler) => void (this.openHandler = handler),
        // What the page was told it may do over WebRTC, and whether that was said before it was
        // asked to load anything.
        setWebRTCIPHandlingPolicy: (policy) =>
          void (this.webRTC = { policy, beforeLoad: this.url === '' }),
        getURL: () => this.url,
        isLoading: () => false,
        executeJavaScript: async () => {},
        send: () => {},
        focus: () => {},
      };
      seen.windows.push(this);
      record(`new BrowserWindow ${options.title}`);
    }
    loadURL(url) {
      record(`loadURL ${url}`);
      this.url = url;
      return Promise.resolve();
    }
    on(event, listener) {
      (this.listeners[event] ??= []).push(listener);
      return this;
    }
    once(event, listener) {
      return this.on(event, listener);
    }
    emit(event, ...args) {
      for (const listener of this.listeners[event] ?? []) listener(...args);
    }
    show() {
      this.visible = true;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    isVisible() {
      return this.visible;
    }
    focus() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
  }
  class Tray {
    constructor() {
      record('new Tray');
    }
    on() {}
    setTitle() {}
    setToolTip() {}
    setContextMenu() {}
  }
  class Notification {
    static isSupported() {
      return false;
    }
  }
  const keep = (name) => (handler) => {
    record(name);
    seen.handlers[name] = handler;
  };
  seen.electron = {
    app,
    BrowserWindow,
    Tray,
    Notification,
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
    globalShortcut: {
      register: () => true,
      unregister: () => {},
      isRegistered: () => false,
      unregisterAll: () => {},
    },
    ipcMain: { handle: () => {}, on: () => {} },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, setTemplateImage: () => {} }),
      createEmpty: () => ({}),
    },
    shell: {
      openExternal: (url) => {
        seen.opened.push(url);
        return Promise.resolve();
      },
      openPath: async () => '',
    },
    dialog: {
      showErrorBox: (title) => record(`dialog.showErrorBox ${title}`),
      // The close button's question, answered "keep running", and not to be asked again.
      showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
    },
    powerMonitor: { on: () => {}, getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    session: {
      defaultSession: {
        setSpellCheckerEnabled: () => {},
        setSpellCheckerLanguages: () => {},
        webRequest: {
          onBeforeRequest: keep('webRequest.onBeforeRequest'),
          onBeforeSendHeaders: keep('webRequest.onBeforeSendHeaders'),
          onCompleted: keep('webRequest.onCompleted'),
        },
        setPermissionRequestHandler: keep('setPermissionRequestHandler'),
        setPermissionCheckHandler: keep('setPermissionCheckHandler'),
        setDevicePermissionHandler: keep('setDevicePermissionHandler'),
      },
    },
  };

  /* The server, as far as main.mjs uses it, and the API it answers. */
  seen.startServer = async (options) => {
    record('startServer');
    seen.started = options;
    return { url: SERVER_URL, port: 41234, dataDir: '/stand-in/data', close: async () => {} };
  };
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    seen.fetches.push({
      url: String(url),
      method: init.method ?? 'GET',
      key: headers.get('x-focusdesk-token'),
      type: headers.get('content-type'),
    });
    const { pathname } = new URL(url);
    const body =
      pathname === '/api/sessions/active' ? { session: null } : pathname === '/api/prompts' ? [] : {};
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };

  const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
  const electron = moduleUrl(`
    const { electron } = globalThis.__standIn;
    export const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell,
      dialog, Notification, powerMonitor, session, screen } = electron;
    export default electron;
  `);
  const server = moduleUrl(`
    export const startServer = (options) => globalThis.__standIn.startServer(options);
    export const normalizeAccelerator = (text) => (typeof text === 'string' && text.trim()) || null;
    export const INTERRUPTION_REASONS = [];
  `);
  register(
    moduleUrl(`
      export async function resolve(specifier, context, next) {
        if (specifier === 'electron') return { url: ${JSON.stringify(electron)}, shortCircuit: true };
        if (specifier === './dist/server.mjs' && context.parentURL === ${JSON.stringify(MAIN)}) {
          return { url: ${JSON.stringify(server)}, shortCircuit: true };
        }
        return next(specifier, context);
      }
    `),
  );

  await import(MAIN);
  const env = {
    NODE_ENV: process.env.NODE_ENV,
    FOCUSDESK_WEB_DIST: process.env.FOCUSDESK_WEB_DIST,
    FOCUSDESK_DATA_DIR: process.env.FOCUSDESK_DATA_DIR,
  };
  await boot();
  const [win] = seen.windows;

  // A page's ways out of the main window: a new window, and a move away from the app.
  const opens = ['smb://203.0.113.5/share', 'https://example.com/opened'].map((url) =>
    win.openHandler({ url }),
  );
  const moved = ['smb://203.0.113.5/moved', 'https://example.com/moved', `${SERVER_URL}/review`].map(
    (url) => {
      let prevented = false;
      const event = { preventDefault: () => void (prevented = true) };
      for (const listener of win.webContents.listeners['will-navigate'] ?? []) listener(event, url);
      return prevented;
    },
  );

  // The close button, which asks, and saves the answer through apiJson.
  win.emit('close', { preventDefault: () => {} });
  for (let i = 0; i < 500 && !seen.fetches.some((f) => f.method === 'PATCH'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // The quick-switch box, through the end-to-end tests' hooks when they are there.
  const hooks = globalThis.__focusdesk ?? null;
  hooks?.showPalette();
  const box = seen.windows[1];
  const boxOpens = box ? [box.openHandler({ url: 'https://example.com/from-the-box' })] : [];

  // The session's rules, asked as a window's requests and pages would ask them: 'none' where
  // there is no rule to ask.
  const ask = (handler, ...args) => (typeof handler === 'function' ? handler(...args) : 'none');
  const answered = (handler, ...args) => {
    let answer = 'none';
    ask(handler, ...args, (given) => void (answer = given));
    return answer;
  };
  const allowed = (permission, url) => {
    let answer = 'none';
    ask(seen.handlers.setPermissionRequestHandler, null, permission, (given) => void (answer = given), {
      requestingUrl: url,
    });
    return answer;
  };
  const rules = {
    sent: answered(seen.handlers['webRequest.onBeforeSendHeaders'], {
      url: `${SERVER_URL}/api/settings`,
      requestHeaders: {},
    }),
    toServer: answered(seen.handlers['webRequest.onBeforeRequest'], { url: `${SERVER_URL}/api/x` }),
    elsewhere: answered(seen.handlers['webRequest.onBeforeRequest'], { url: 'https://example.com/' }),
    notifications: allowed('notifications', `${SERVER_URL}/`),
    notificationsElsewhere: allowed('notifications', 'http://127.0.0.1:41235/'),
    media: allowed('media', `${SERVER_URL}/`),
    checked: ask(seen.handlers.setPermissionCheckHandler, null, 'notifications', `${SERVER_URL}/`, {}),
    device: ask(seen.handlers.setDevicePermissionHandler, { deviceType: 'usb', origin: SERVER_URL }),
  };

  const report = {
    env,
    events: seen.events,
    started: seen.started,
    fetches: seen.fetches,
    opened: seen.opened,
    opens,
    moved,
    boxOpens,
    windows: seen.windows.map((w) => ({
      title: w.options.title,
      webPreferences: w.options.webPreferences,
      webRTC: w.webRTC ?? null,
    })),
    hooks: hooks && { serverUrl: hooks.serverUrl, token: hooks.token },
    rules,
    logs: seen.logs,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
}

let folder;
/** What each start saw, by name. */
const runs = {};

/** Start main.mjs in a process of its own, packaged or not, with these settings in its environment. */
async function run(name, { packaged, env }) {
  const file = path.join(folder, `${name}.mjs`);
  const args = [MAIN, SERVER_URL, packaged].map((arg) => JSON.stringify(arg)).join(', ');
  fs.writeFileSync(
    file,
    `(${start.toString()})(${args}).catch((err) => {\n` +
      '  process.stderr.write(String(err?.stack ?? err));\n' +
      '  process.exit(1);\n' +
      '});\n',
  );
  // Nothing of the environment these tests run in decides what is being tested.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(NODE_ENV|NODE_TEST_CONTEXT|FOCUSDESK_)/.test(key)),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [file], {
    env: { ...inherited, ...env },
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  runs[name] = JSON.parse(stdout.trim().split('\n').at(-1));
}

before(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-main-'));
  const told = { NODE_ENV: 'development', FOCUSDESK_WEB_DIST: path.join(os.tmpdir(), 'other-pages') };
  await Promise.all([
    // Run from a checkout, with an environment of its own, as npm run desktop is.
    run('checkout', { packaged: false, env: { ...told, FOCUSDESK_DATA_DIR: '/chosen/data' } }),
    // Run from a checkout with nothing said.
    run('plain', { packaged: false, env: {} }),
    // Packaged, started from an environment that says otherwise, by the end-to-end tests.
    run('packaged', {
      packaged: true,
      env: { ...told, FOCUSDESK_DATA_DIR: '/chosen/data', FOCUSDESK_TEST: '1' },
    }),
  ]);
});

after(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const each = () => Object.entries(runs);

describe('main.mjs as it starts', () => {
  it('starts without an error to show, and with one window and the menu-bar item', () => {
    for (const [name, { events }] of each()) {
      assert.ok(!events.some((e) => /^(dialog\.showErrorBox|app\.exit)/.test(e)), name);
      assert.equal(events.filter((e) => e === 'new Tray').length, 1, name);
      assert.ok(events.includes('new BrowserWindow FocusDesk'), name);
    }
  });

  it('starts the server on a free loopback port with a key of its own, made afresh at each launch', () => {
    const keys = new Set();
    for (const [name, { started }] of each()) {
      assert.deepEqual(Object.keys(started).sort(), ['host', 'port', 'token'], name);
      assert.equal(started.port, 0, name);
      assert.equal(started.host, '127.0.0.1', name);
      assert.match(started.token, KEY, name);
      keys.add(started.token);
    }
    assert.equal(keys.size, Object.keys(runs).length, 'two launches had the same key');
  });

  it('holds the session to the server after it is up and before any window is made or loads anything', () => {
    for (const [name, { events }] of each()) {
      const server = events.indexOf('startServer');
      const window = events.findIndex((e) => e.startsWith('new BrowserWindow'));
      const load = events.findIndex((e) => e.startsWith('loadURL'));
      assert.ok(server >= 0 && window > server && load > window, name);
      for (const rule of [
        'webRequest.onBeforeRequest',
        'webRequest.onBeforeSendHeaders',
        'setPermissionRequestHandler',
        'setPermissionCheckHandler',
        'setDevicePermissionHandler',
      ]) {
        const at = events.indexOf(rule);
        assert.ok(
          at > server && at < window,
          `${name}: ${rule} at ${at}, the server at ${server}, the window at ${window}`,
        );
        assert.equal(events.filter((e) => e === rule).length, 1, `${name}: ${rule} more than once`);
      }
      // The menu bar's own listener is another event, put in later, and replaces none of these.
      assert.equal(events.filter((e) => e === 'webRequest.onCompleted').length, 1, name);
    }
  });

  it('holds it to this server and this launch’s key', () => {
    for (const [name, { rules, started }] of each()) {
      assert.deepEqual(rules.sent, { requestHeaders: { 'x-focusdesk-token': started.token } }, name);
      assert.deepEqual(rules.toServer, { cancel: false }, name);
      assert.deepEqual(rules.elsewhere, { cancel: true }, name);
      assert.equal(rules.notifications, true, name);
      assert.equal(rules.notificationsElsewhere, false, name);
      assert.equal(rules.media, false, name);
      assert.equal(rules.checked, true, name);
      assert.equal(rules.device, false, name);
    }
  });

  it('sends the key with every request it makes to the API, and says JSON where it sends a body', () => {
    for (const [name, { fetches, started }] of each()) {
      const paths = fetches.map((f) => `${f.method} ${new URL(f.url).pathname}`);
      const expected = [
        'GET /api/sessions/active',
        'GET /api/settings',
        'GET /api/prompts',
        'PATCH /api/settings',
      ];
      for (const asked of expected) {
        assert.ok(paths.includes(asked), `${name}: ${asked} was not asked (${paths.join(', ')})`);
      }
      for (const f of fetches) {
        assert.ok(f.url.startsWith(`${SERVER_URL}/api/`), `${name}: ${f.url}`);
        assert.equal(f.key, started.token, `${name}: ${f.method} ${f.url}`);
      }
      assert.equal(fetches.find((f) => f.method === 'PATCH').type, 'application/json', name);
    }
  });

  it('never prints the key', () => {
    for (const [name, { logs, started }] of each()) {
      assert.ok(logs.length > 0, `${name} printed nothing at all, which is not this app`);
      assert.ok(!logs.join('\n').includes(started.token), name);
    }
  });

  it('hands the end-to-end tests the key beside the server’s address, and nobody the key when they are not running', () => {
    assert.deepEqual(runs.packaged.hooks, { serverUrl: SERVER_URL, token: runs.packaged.started.token });
    assert.equal(runs.checkout.hooks, null);
    assert.equal(runs.plain.hooks, null);
  });
});

describe('links out of the windows, as main.mjs starts them', () => {
  it('reach the system from the main window only for a web page or an email address, and every new window is refused', () => {
    for (const [name, { opened, opens, moved, logs }] of each()) {
      assert.deepEqual(opens, [{ action: 'deny' }, { action: 'deny' }], name);
      // smb: and https: are both kept from moving the window off the app; the app's own page is not.
      assert.deepEqual(moved, [true, true, false], name);
      assert.deepEqual(opened, ['https://example.com/opened', 'https://example.com/moved'], name);
      assert.equal(logs.filter((line) => line.includes('did not open a smb: link')).length, 2, name);
      assert.ok(!logs.join('\n').includes('203.0.113.5'), `${name} logged a refused address`);
    }
  });

  it('never leave the quick-switch box', () => {
    const { boxOpens, opened } = runs.packaged;
    assert.deepEqual(boxOpens, [{ action: 'deny' }]);
    assert.ok(!opened.includes('https://example.com/from-the-box'));
  });
});

describe('the windows main.mjs makes', () => {
  it('both run their pages sandboxed, isolated from the bridge, and without Node', () => {
    const { windows } = runs.packaged;
    assert.equal(windows.length, 2, 'the main window and the quick-switch box');
    for (const { title, webPreferences } of windows) {
      assert.equal(webPreferences.sandbox, true, title);
      assert.equal(webPreferences.contextIsolation, true, title);
      assert.equal(webPreferences.nodeIntegration, false, title);
      assert.equal(path.basename(webPreferences.preload), 'preload.cjs', title);
    }
  });

  it('both let WebRTC use UDP only through a proxy, said before either loads its page', () => {
    for (const [name, { windows }] of each()) {
      assert.ok(windows.length >= 1, `${name} made no window`);
      for (const { title, webRTC } of windows) {
        assert.deepEqual(
          webRTC,
          { policy: 'disable_non_proxied_udp', beforeLoad: true },
          `${name}: ${title}`,
        );
      }
    }
    // The quick-switch box is only made where the end-to-end hooks can open it, so this is the
    // run that has both.
    assert.deepEqual(
      runs.packaged.windows.map((w) => w.title),
      ['FocusDesk', 'FocusDesk quick switch'],
    );
  });
});

describe('the environment the server is started in', () => {
  const ownPages = path.join(desktop, 'web');

  it('is production with the packed pages, for a packaged app, whatever it was started with', () => {
    assert.deepEqual(runs.packaged.env, {
      NODE_ENV: 'production',
      FOCUSDESK_WEB_DIST: ownPages,
      // Which data folder is still the environment's to say: the smoke test runs on an empty one.
      FOCUSDESK_DATA_DIR: '/chosen/data',
    });
  });

  it('is what the environment says, when run from a checkout', () => {
    assert.deepEqual(runs.checkout.env, {
      NODE_ENV: 'development',
      FOCUSDESK_WEB_DIST: path.join(os.tmpdir(), 'other-pages'),
      FOCUSDESK_DATA_DIR: '/chosen/data',
    });
  });

  it('is production with the app’s own pages and data folder, when nothing says otherwise', () => {
    assert.deepEqual(runs.plain.env, {
      NODE_ENV: 'production',
      FOCUSDESK_WEB_DIST: ownPages,
      FOCUSDESK_DATA_DIR: path.join('/stand-in/userData', 'data'),
    });
  });
});
