import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
  dialog,
} from 'electron';
import { createPalette, isLocal } from './palette.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
/** What both windows show until their page has painted. */
const BACKGROUND = '#f9f9f7';

/** Two copies would fight over the same database file. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/**
 * Data lives beside the app, not beside the source checkout, so it survives
 * updates and reinstalls:  ~/Library/Application Support/FocusDesk/data
 */
process.env.FOCUSDESK_DATA_DIR ??= path.join(app.getPath('userData'), 'data');
process.env.FOCUSDESK_WEB_DIST ??= path.join(here, 'web');
process.env.NODE_ENV ??= 'production';

let server = null;
let win = null;
let tray = null;
let isQuitting = false;
// Both come out of the server bundle, which is only imported once the data folder is set.
let normalizeAccelerator = null;
let palette = null;

/* --------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'FocusDesk',
    // Content runs right up to the top; the app's own top bar is the drag
    // handle, which is why the client is told it is running in the desktop app.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: BACKGROUND,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(here, 'preload.cjs'),
    },
  });

  win.loadURL(`${server.url}/?desktop=1`);
  win.once('ready-to-show', () => win.show());

  // Closing the window parks the app in the menu bar; the timer keeps running.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
    if (isMac) app.dock?.hide();
  });

  // Anything not served by the local app opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocal(url, server.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function showWindow() {
  // A second launch during startup can ask for the window before the server
  // is up. The first copy opens it itself once the server is ready.
  if (!server) return;
  if (!win) createWindow();
  if (isMac) void app.dock?.show();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ api */

async function api(pathname, method = 'GET') {
  const res = await fetch(`${server.url}/api${pathname}`, { method });
  if (!res.ok) throw new Error(`${method} ${pathname} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/* ----------------------------------------------------------------- tray */

/**
 * The menu-bar clock: a countdown for a pomodoro, a count-up for a stopwatch.
 * The server owns the clock, so this polls it every few seconds and
 * interpolates in between rather than keeping its own count.
 */
const live = { session: null, elapsedAtPoll: 0, polledAt: 0 };

async function poll() {
  try {
    const { session } = await api('/sessions/active');
    live.session = session;
    live.elapsedAtPoll = session?.elapsedSeconds ?? 0;
    live.polledAt = Date.now();
  } catch {
    live.session = null;
  }
  renderTitle();
  renderMenu();
}

function elapsedNow() {
  if (!live.session) return 0;
  if (live.session.status !== 'running') return live.elapsedAtPoll;
  return live.elapsedAtPoll + Math.max(0, (Date.now() - live.polledAt) / 1000);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * The clock text changes every second; the menu only changes when the
 * block does. Rebuilding the menu on every tick is wasted work — and on some
 * platforms the toolkit complains about it.
 */
let menuSignature = null;

function renderTitle() {
  if (!tray) return;
  const s = live.session;

  if (!s) {
    if (isMac) tray.setTitle('');
    tray.setToolTip('FocusDesk - nothing running');
    return;
  }

  // A stopwatch has no planned time, so there is nothing to count down to and
  // nothing to run over: the menu bar just counts up, unsigned.
  const stopwatch = s.plannedSeconds == null;
  let label;
  if (stopwatch) {
    label = formatClock(elapsedNow());
  } else {
    const remaining = s.plannedSeconds - elapsedNow();
    label = remaining >= 0 ? formatClock(remaining) : `+${formatClock(-remaining)}`;
  }
  if (isMac) tray.setTitle(s.status === 'paused' ? `|| ${label}` : ` ${label}`);
  const project = s.projectName ?? 'No project';
  tray.setToolTip(
    stopwatch ? `${s.title}\n${project} · stopwatch ${label}` : `${s.title}\n${project} - ${label}`,
  );
}

function renderMenu() {
  if (!tray) return;
  const s = live.session;
  // Everything the menu's shape depends on, and nothing that ticks.
  const signature = JSON.stringify([
    s?.id ?? null,
    s?.status ?? null,
    s?.title ?? null,
    s?.projectName ?? null,
    app.getLoginItemSettings().openAtLogin,
  ]);
  if (signature === menuSignature) return;
  menuSignature = signature;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(s
        ? [
            { label: s.title.slice(0, 60), enabled: false },
            {
              label: s.projectName ? `Project: ${s.projectName}` : 'No project',
              enabled: false,
            },
            { type: 'separator' },
            s.status === 'paused'
              ? { label: 'Resume', click: () => void act(`/sessions/${s.id}/resume`) }
              : { label: 'Pause', click: () => void act(`/sessions/${s.id}/pause`) },
            {
              label: 'Got interrupted',
              click: () => void act(`/sessions/${s.id}/interruption`),
            },
            { label: 'Finish block...', click: showWindow },
            { type: 'separator' },
          ]
        : [{ label: 'Nothing running', enabled: false }, { type: 'separator' }]),
      { label: 'Open FocusDesk', accelerator: 'CommandOrControl+Shift+F', click: showWindow },
      { type: 'separator' },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          renderMenu();
        },
      },
      {
        label: 'Reveal data folder',
        click: () => void shell.openPath(process.env.FOCUSDESK_DATA_DIR),
      },
      { type: 'separator' },
      { label: 'Quit FocusDesk', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]),
  );
}

async function act(pathname) {
  try {
    await api(pathname, 'POST');
  } catch (err) {
    console.error('[focusdesk]', err);
  }
  await poll();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png'));
  // A template image is recoloured by macOS for light and dark menu bars.
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', showWindow);
  renderTitle();
  renderMenu();
}

/* ---------------------------------------------------------- quick switch */

/**
 * The shortcut registered for the quick-switch box right now, or null. Kept so that a change can
 * let go of the old one, and so that a new one that cannot be taken leaves it as it was.
 */
let activeHotkey = null;

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/** Null when `accelerator` is now registered, otherwise why it is not. */
function tryRegister(accelerator) {
  try {
    const open = () => {
      try {
        palette.showPalette();
      } catch (err) {
        console.error('[focusdesk] quick switch', err);
      }
    };
    if (globalShortcut.register(accelerator, open)) return null;
    // Refused, yet registered by this app: the combination is one of FocusDesk's own.
    return globalShortcut.isRegistered(accelerator)
      ? `${accelerator} is already used by another FocusDesk shortcut.`
      : `${accelerator} could not be registered. Another app may be using it.`;
  } catch (err) {
    return `${accelerator} could not be registered: ${messageOf(err)}`;
  }
}

/**
 * Read the shortcut setting and make it the registered one. Answers { ok, accelerator, error }:
 * the shortcut that is registered afterwards, null for none, and when the setting asked for one
 * that could not be taken, why. That one never costs the shortcut that was working.
 *
 * Electron cannot be trusted to say no. It drops a name it does not know and registers what is
 * left, and on a Mac it can answer true for a combination another app owns. The first is stopped
 * by reading the setting through the same rule the server saved it by; the second cannot be
 * detected from here, which is why Settings shows what is active, and not just what was typed.
 */
async function applyHotkey() {
  let wanted;
  try {
    wanted = (await api('/settings')).quick_switch_hotkey ?? '';
  } catch (err) {
    return {
      ok: false,
      accelerator: activeHotkey,
      error: `Could not read the setting: ${messageOf(err)}`,
    };
  }

  if (wanted === '') {
    if (activeHotkey) globalShortcut.unregister(activeHotkey);
    activeHotkey = null;
    return { ok: true, accelerator: null };
  }

  const accelerator = normalizeAccelerator(wanted);
  if (accelerator === null) {
    return {
      ok: false,
      accelerator: activeHotkey,
      error: `"${wanted}" is not a shortcut FocusDesk can register.`,
    };
  }
  if (accelerator === activeHotkey && globalShortcut.isRegistered(accelerator)) {
    return { ok: true, accelerator };
  }

  // The old one goes first, so the same keys under another spelling can be taken again, and
  // comes back if the new one cannot be had.
  const previous = activeHotkey;
  if (previous) globalShortcut.unregister(previous);
  const failure = tryRegister(accelerator);
  if (!failure) {
    activeHotkey = accelerator;
    return { ok: true, accelerator };
  }
  activeHotkey = previous && !tryRegister(previous) ? previous : null;
  return { ok: false, accelerator: activeHotkey, error: failure };
}

// One at a time, so that two reloads cannot leave the shortcut at whichever answered last.
let hotkeyQueue = Promise.resolve();
function syncHotkey() {
  const run = hotkeyQueue.then(applyHotkey);
  hotkeyQueue = run.catch(() => {});
  return run;
}

/* ----------------------------------------------------------------- boot */

app.whenReady().then(async () => {
  // The copy that lost the lock is already quitting; starting a server here
  // would open the same database the running copy has.
  if (!gotLock) return;
  try {
    // Imported only now, so the env vars above are already in place when the
    // database file is opened at module load.
    let startServer;
    ({ startServer, normalizeAccelerator } = await import('./dist/server.mjs'));
    server = await startServer({ port: 0, host: '127.0.0.1' });
    console.log(`[focusdesk] serving ${server.url} · data ${server.dataDir}`);
  } catch (err) {
    dialog.showErrorBox(
      'FocusDesk could not start',
      `The local server failed to start.\n\n${err instanceof Error ? err.stack : String(err)}`,
    );
    app.exit(1);
    return;
  }

  // The windows call these, so they are in place before either page loads.
  ipcMain.handle('hotkey:reload', () => syncHotkey());
  palette = createPalette({
    serverUrl: server.url,
    backgroundColor: BACKGROUND,
    // The box may have changed what is on the clock: show it in the menu bar now, not in 5s.
    onClose: () => void poll(),
  });
  if (process.env.FOCUSDESK_TEST === '1') {
    // What the end-to-end tests reach into the running app by, and nothing else does.
    globalThis.__focusdesk = {
      serverUrl: server.url,
      showPalette: palette.showPalette,
      hidePalette: palette.hidePalette,
      get paletteWindow() {
        return palette.window;
      },
      get activeHotkey() {
        return activeHotkey;
      },
    };
  }

  createWindow();
  createTray();

  await poll();
  setInterval(() => void poll(), 5_000);
  setInterval(renderTitle, 1_000);

  globalShortcut.register('CommandOrControl+Shift+F', showWindow);
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    const s = live.session;
    if (!s) {
      showWindow();
      return;
    }
    void act(`/sessions/${s.id}/${s.status === 'paused' ? 'resume' : 'pause'}`);
  });
  // After those two, so a combination they already hold is reported as taken, not taken over.
  const quickSwitch = await syncHotkey();
  console.log(
    `[focusdesk] quick switch: ${quickSwitch.ok ? (quickSwitch.accelerator ?? 'off') : quickSwitch.error}`,
  );

  app.on('activate', showWindow);
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  isQuitting = true;
});
// The menu-bar item is the app; a closed window is not a reason to exit.
app.on('window-all-closed', () => {});
app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await server?.close().catch(() => {});
});
