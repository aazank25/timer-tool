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
  Notification,
  powerMonitor,
  session as electronSession,
} from 'electron';
import { createAttention, interruptedItem } from './attention.mjs';
import { createAwayTracker } from './away.mjs';
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

/**
 * The address of a page of the app, with the flag that tells the page it is inside this
 * shell (see IS_DESKTOP in web/src/App.tsx). A route that does not stay on the local server
 * is not one of the app's, and goes to the front page instead.
 */
function routeUrl(route) {
  const base = new URL(server.url);
  const url = new URL(route, base);
  if (url.origin !== base.origin) return routeUrl('/');
  url.searchParams.set('desktop', '1');
  return url.toString();
}

/**
 * Show the main window. With a route ('/wrap-up', '/wrap-up/week?week=2026-10-05') it is taken
 * there first and shown once the page is up, so it never opens on the page it was last left
 * on. Electron hands an event to the handlers that call this as they are (the tray, the
 * hotkey, the dock icon), so only a string is a route.
 */
function showWindow(route) {
  // A second launch during startup can ask for the window before the server
  // is up. The first copy opens it itself once the server is ready.
  if (!server) return;
  if (!win) createWindow();
  const reveal = () => {
    if (isMac) void app.dock?.show();
    win.show();
    win.focus();
  };
  if (typeof route !== 'string') {
    reveal();
    return;
  }
  win
    .loadURL(routeUrl(route))
    // A page that is replaced by another before it has loaded is not a failure to show it.
    .catch((err) => console.error('[focusdesk] could not open', route, err.message))
    .finally(reveal);
}

/* ------------------------------------------------------------------ api */

async function api(pathname, method = 'GET') {
  const res = await fetch(`${server.url}/api${pathname}`, { method });
  if (!res.ok) throw new Error(`${method} ${pathname} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/**
 * The same with a JSON body, and with the server's own words for what went wrong, which is
 * what a person is shown when an answer is refused ("That prompt is no longer current").
 */
async function apiJson(pathname, method, body) {
  const res = await fetch(`${server.url}/api${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status says enough.
  }
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error ?? `${method} ${pathname} failed: ${res.status}`), {
      status: res.status,
    });
  }
  return payload;
}

/* ----------------------------------------------------------------- tray */

/**
 * The menu-bar clock: a countdown for a pomodoro, a count-up for a stopwatch.
 * The server owns the clock, so this polls it every few seconds and
 * interpolates in between rather than keeping its own count.
 */
const live = { session: null, elapsedAtPoll: 0, polledAt: 0 };

// Made once the server is up, and left null (so the menu is as it always was) until then.
/** What needs your attention: the notifications, and the top of the menu. */
let attention = null;
/** Whether you left the machine while a block was running. */
let away = null;
/** What "Got interrupted" offers. It comes from the server, so the two cannot drift apart. */
let interruptionReasons = [];

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

/** What the menu-bar item says, as last set: the tests read it, since only a Mac has a title to see. */
let trayText = { title: '', toolTip: '' };

function setTrayText(title, toolTip) {
  trayText = { title, toolTip };
  if (isMac) tray.setTitle(title);
  tray.setToolTip(toolTip);
}

function renderTitle() {
  if (!tray) return;
  const s = live.session;
  // A dot before the clock while something is waiting for an answer: it is seen without being
  // read, and the clock beside it is as it was. Without a clock it stands alone.
  const waiting = attention?.pending() ?? 0;
  const mark = waiting > 0 ? '•' : '';
  const needs =
    waiting > 0 ? `\n${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} your attention` : '';

  if (!s) {
    setTrayText(mark, `FocusDesk - nothing running${needs}`);
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
  const project = s.projectName ?? 'No project';
  setTrayText(
    s.status === 'paused' ? `${mark ? `${mark} ` : ''}|| ${label}` : `${mark} ${label}`,
    (stopwatch
      ? `${s.title}\n${project} · stopwatch ${label}`
      : `${s.title}\n${project} - ${label}`) + needs,
  );
}

/** The menu as it was last built, as data that still has its click handlers: what the tests press. */
let builtMenu = null;

function renderMenu() {
  if (!tray) return;
  const s = live.session;
  // Everything the menu's shape depends on, and nothing that ticks.
  const signature = JSON.stringify([
    s?.id ?? null,
    s?.status ?? null,
    s?.kind ?? null,
    s?.title ?? null,
    s?.projectName ?? null,
    app.getLoginItemSettings().openAtLogin,
    attention?.signature() ?? null,
    interruptionReasons.length,
  ]);
  if (signature === menuSignature) return;
  menuSignature = signature;

  builtMenu = [
    // What is waiting for an answer goes first: it is why the menu-bar item has a dot.
    ...(attention?.menuItems() ?? []),
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
          interruptedItem(s, interruptionReasons, (id, reason) =>
            act(`/sessions/${id}/interruption`, reason ? { reason } : {}),
          ),
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
  ];
  tray.setContextMenu(Menu.buildFromTemplate(builtMenu));
}

/**
 * POST to the server for something chosen in the menu, then read the clock and what is pending
 * again: pausing a block can answer a question about a meeting, and an answer can move the clock.
 * Resolves when that is done, and never rejects.
 */
async function act(pathname, body) {
  try {
    if (body === undefined) await api(pathname, 'POST');
    else await apiJson(pathname, 'POST', body);
  } catch (err) {
    console.error('[focusdesk]', err);
  }
  await poll();
  void attention?.refresh();
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

/* ------------------------------------------------ away, and needs attention */

/** How often the machine is asked how long it has been without input. */
const IDLE_POLL_MS = 15_000;
/** How often the server is asked what needs attention. */
const PROMPT_POLL_MS = 15_000;
/** How often the settings are read again, which away detection goes by, besides when one is saved. */
const SETTINGS_POLL_MS = 60_000;

/** What the tests put in place of the clock and the idle time, to stand in for hours of waiting. */
const stubbed = { now: null, idleSeconds: null };

function systemIdleSeconds() {
  if (stubbed.idleSeconds != null) return stubbed.idleSeconds;
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    // Not every platform can say. Never idle is the safe answer: nothing is reported or held back for it.
    return 0;
  }
}

/** The settings as last read. Away detection goes by them, and is off until they have been. */
let settings = null;

async function readSettings() {
  try {
    settings = await api('/settings');
  } catch (err) {
    console.error('[focusdesk] could not read the settings', err);
  }
}

/** Find an item of the menu by the labels leading to it: ['Needs attention', ...] is not one, a prompt's title is. */
function menuItemAt(path) {
  let items = builtMenu ?? [];
  let found = null;
  for (const label of path) {
    found = items.find((item) => item.label === label) ?? null;
    if (!found) return null;
    items = found.submenu ?? [];
  }
  return found;
}

/**
 * Look for what needs your attention and for time you were away, and put each where you will
 * see it. Needs the server (it is what they ask) but not the window, so it runs in the menu bar
 * with the window closed, which is when it is wanted.
 */
async function startAttention() {
  ({ INTERRUPTION_REASONS: interruptionReasons } = await import('./dist/server.mjs'));
  /** What was reported to the server and how it went: for the tests, which cannot see the request. */
  const reports = [];

  attention = createAttention({
    fetchPrompts: () => api('/prompts'),
    actOnPrompt: (id, action) => apiJson('/prompts/act', 'POST', { id, action }),
    Notification,
    getIdleSeconds: systemIdleSeconds,
    // Locked, or another user has the Mac: nobody is there to be told.
    isLocked: () => {
      const state = away?.state();
      return !!state && (state.locked || state.suspended || state.switched);
    },
    openWindow: showWindow,
    openPalette: () => palette.showPalette(),
    showError: (message) => {
      void dialog
        .showMessageBox({ type: 'error', title: 'FocusDesk', message: 'That did not work', detail: message })
        .catch((err) => console.error('[focusdesk]', err));
    },
    onChange: () => {
      renderTitle();
      renderMenu();
    },
    afterAction: poll,
    log: (...args) => console.error('[focusdesk]', ...args),
  });

  away = createAwayTracker({
    now: () => stubbed.now ?? Date.now(),
    getIdleSeconds: systemIdleSeconds,
    getLive: () => live.session,
    getSettings: () => settings,
    report: async ({ sessionId, startedAt, endedAt }) => {
      const entry = { sessionId, startedAt, endedAt, ok: false, error: null };
      reports.push(entry);
      try {
        await apiJson(`/sessions/${sessionId}/away`, 'POST', { startedAt, endedAt });
        entry.ok = true;
      } catch (err) {
        entry.error = messageOf(err);
        throw err;
      }
      // The server now has a question about it: ask what it is, rather than in a quarter of a minute.
      void attention.refresh();
    },
    // A block that is gone, or a stretch the server will not take, is no news: it is only logged.
    log: (...args) => console.warn('[focusdesk]', ...args),
  });

  // Each of these is the system telling us something; none of them may throw into Electron.
  const onPower = (event, handler) =>
    powerMonitor.on(event, () => {
      Promise.resolve()
        .then(handler)
        .catch((err) => console.error('[focusdesk]', event, err));
    });
  onPower('lock-screen', () => away.onLock());
  onPower('suspend', () => away.onSuspend());
  onPower('user-did-resign-active', () => away.onResignActive());
  // Coming back is when what was asked in the meantime is read, and said if you are there to hear it.
  const comeBack = async (end) => {
    await end();
    void readSettings();
    await attention.refresh();
  };
  onPower('unlock-screen', () => comeBack(() => away.onUnlock()));
  onPower('resume', () => comeBack(() => away.onResume()));
  onPower('user-did-become-active', () => comeBack(() => away.onBecomeActive()));

  // Saving the settings in either window: the thresholds may be different now.
  electronSession.defaultSession.webRequest.onCompleted((details) => {
    if (
      details.method === 'PATCH' &&
      details.statusCode < 400 &&
      details.url.startsWith(`${server.url}/api/settings`)
    ) {
      void readSettings();
    }
  });

  await readSettings();
  await attention.refresh();
  setInterval(() => void away.tick(), IDLE_POLL_MS);
  setInterval(() => void attention.refresh(), PROMPT_POLL_MS);
  setInterval(() => void readSettings(), SETTINGS_POLL_MS);

  if (process.env.FOCUSDESK_TEST === '1' && globalThis.__focusdesk) {
    const events = {
      lock: 'onLock',
      unlock: 'onUnlock',
      suspend: 'onSuspend',
      resume: 'onResume',
      'resign-active': 'onResignActive',
      'become-active': 'onBecomeActive',
    };
    Object.assign(globalThis.__focusdesk, {
      away: {
        state: () => away.state(),
        reports: () => reports.map((r) => ({ ...r })),
        settings: () => settings && { ...settings },
        readSettings,
        tick: () => away.tick(),
        /** One of lock, unlock, suspend, resume, resign-active, become-active, as if it had been seen at `at`. */
        event: (name, at) => away[events[name]](at),
        /** Pretend it is this time, as epoch milliseconds, or the real one again with null. */
        setClock: (ms) => {
          stubbed.now = ms;
        },
        /** Pretend the machine has been idle this many seconds, or let it say for itself with null. */
        setIdle: (seconds) => {
          stubbed.idleSeconds = seconds;
        },
      },
      attention: {
        prompts: () => attention.prompts(),
        notified: () => attention.notified(),
        refresh: () => attention.refresh(),
      },
      /** The menu-bar menu as plain data, without its click handlers. */
      menuTemplate: () => JSON.parse(JSON.stringify(builtMenu ?? [])),
      /** What the menu-bar item says: { title, toolTip }. */
      trayText: () => ({ ...trayText }),
      /** Choose an item of the menu by the labels leading to it, as a click on it would. */
      clickMenu: (path) => {
        const item = menuItemAt(path);
        if (!item?.click) throw new Error(`There is no menu item ${path.join(' > ')}`);
        return item.click(item, win, {});
      },
      showWindow: (route) => showWindow(route),
      windowUrl: () => win?.webContents.getURL() ?? null,
      windowVisible: () => !!win?.isVisible(),
    });
  }
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

  // Last, and on its own: the menu bar clock and the shortcuts above work without it.
  try {
    await startAttention();
  } catch (err) {
    console.error('[focusdesk] away detection and notifications could not start', err);
  }
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
