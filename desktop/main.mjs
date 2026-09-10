import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  shell,
  dialog,
} from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

/** Two copies would fight over the same database file. */
if (!app.requestSingleInstanceLock()) app.quit();

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
    backgroundColor: '#f9f9f7',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
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
    if (!url.startsWith(server.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function showWindow() {
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
 * The menu-bar countdown. The server owns the clock, so this polls it every
 * few seconds and interpolates in between rather than keeping its own count.
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
 * The countdown text changes every second; the menu only changes when the
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

  const remaining = s.plannedSeconds - elapsedNow();
  const label = remaining >= 0 ? formatClock(remaining) : `+${formatClock(-remaining)}`;
  if (isMac) tray.setTitle(s.status === 'paused' ? `|| ${label}` : ` ${label}`);
  tray.setToolTip(`${s.title}\n${s.projectName ?? 'No project'} - ${label}`);
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

/* ----------------------------------------------------------------- boot */

app.whenReady().then(async () => {
  try {
    // Imported only now, so the env vars above are already in place when the
    // database file is opened at module load.
    const { startServer } = await import('./dist/server.mjs');
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
