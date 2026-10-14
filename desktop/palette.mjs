import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

const WIDTH = 640;
const HEIGHT = 420;
/** How far down the screen the box starts, as a share of its height. */
const TOP = 0.25;

/**
 * Whether `url` is a page of the local app: the same origin as `serverUrl`, which is scheme, host
 * and port together. Compared as parsed addresses and never as text, because text that begins with
 * the app's address need not be on it: 'http://127.0.0.1:5000@elsewhere.example/' is the host
 * elsewhere.example, logged in as a user named 127.0.0.1:5000, and 'http://127.0.0.1:50001/' is
 * another port. Anything that does not parse is not local.
 */
export function isLocal(url, serverUrl) {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The quick-switch box: a small frameless window that is raised over whatever app you are in by a
 * shortcut, takes a few letters, and goes away again. It is made the first time it is wanted and
 * then only hidden and shown, so it appears at once the second time and keeps no state of its own:
 * the page starts itself over whenever it is told the window is being shown.
 *
 * On a Mac it is a panel, which is the kind of window that can take the keyboard without making
 * FocusDesk the active app. That is the point of it: when it goes, the app you were in still has
 * focus, and nothing has to be handed back. (Do not reach for app.hide() to do that. Hiding the
 * dock icon, as closing the main window does, leaves the app unable to hide its windows.)
 *
 * `onClose` runs after the page has asked for the box to go, which is when the clock may have
 * changed behind the menu bar's back.
 */
export function createPalette({ serverUrl, backgroundColor, onClose = () => {} }) {
  let win = null;
  // Whether the page has painted once. A window shown before then flashes empty.
  let ready = false;
  // Asked to show while it was still loading: it shows itself the moment it can.
  let pending = false;

  function create() {
    ready = false;
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      backgroundColor,
      title: 'FocusDesk quick switch',
      ...(isMac ? { type: 'panel' } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // What Electron does anyway with no Node in the page, said here so that it stays so.
        sandbox: true,
        preload: path.join(here, 'preload.cjs'),
      },
    });
    // WebRTC may use UDP only through a proxy here too (see createWindow in main.mjs): that stops
    // a STUN lookup and not a connection over TCP to a TURN relay, and either takes a script
    // running in the page, which the server's Content Security Policy keeps out.
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    // Above ordinary windows, and above full-screen ones, on whichever Space is showing.
    // skipTransformProcessType, so that doing so does not make the Dock icon flicker.
    win.setAlwaysOnTop(true, 'floating');
    if (isMac) {
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    win.loadURL(`${serverUrl}/palette?desktop=1`).catch((err) => {
      // Quitting while it was still loading aborts the load. Nothing is lost by that.
      console.error('[focusdesk] quick switch window did not load:', err.message);
    });
    win.once('ready-to-show', () => {
      ready = true;
      if (pending) reveal();
    });

    // Clicking anywhere else, or switching apps, is a way of saying never mind.
    win.on('blur', hidePalette);

    // It only ever shows the local page. Nothing it opens or follows leaves for somewhere else
    // with the bridge to this app still attached.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!isLocal(url, serverUrl)) event.preventDefault();
    });
    win.on('closed', () => {
      win = null;
    });
  }

  /** On the display the pointer is on, centred across it and a quarter of the way down. */
  function place() {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds({
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + workArea.height * TOP),
      width: WIDTH,
      height: HEIGHT,
    });
  }

  function reveal() {
    pending = false;
    // The page starts over on this before it is on screen, so it never shows the last time's.
    win.webContents.send('palette:show');
    // Shown inactive and then focused, not show(): on a Mac, show() activates the app to put
    // the window in front, which is exactly what a panel exists not to do. The panel can take
    // the keyboard without it.
    win.showInactive();
    win.focus();
    win.webContents.focus();
  }

  function showPalette() {
    if (!win) create();
    place();
    if (ready) reveal();
    else pending = true;
  }

  function hidePalette() {
    pending = false;
    if (win && win.isVisible()) win.hide();
  }

  ipcMain.on('palette:close', () => {
    hidePalette();
    onClose();
  });

  return {
    showPalette,
    hidePalette,
    /** The window, or null until it has first been wanted. */
    get window() {
      return win;
    },
  };
}
