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
import {
  APP_USER_MODEL_ID,
  createAttention,
  interruptedItem,
  notificationAllowed,
  showTestNotification,
  trimLabel,
} from './attention.mjs';
import { createAwayTracker } from './away.mjs';
import {
  afterAsking,
  askButtons,
  askDetail,
  askMessage,
  CANCEL,
  onClose,
} from './close-window.mjs';
import {
  elapsedSeconds,
  menuBarText,
  nativeAccelerator,
  trayIconFiles,
  trayMenuWording,
} from './menu-bar.mjs';
import { createPalette, isLocal } from './palette.mjs';
import { keepToServer, newToken, openOutside, TOKEN_HEADER } from './privacy.mjs';
import { rereadAfter } from './requests.mjs';
import {
  createHotkeys,
  describeHotkeys,
  hotkeyMenuItems,
  hotkeysFailing,
  opensQuickSwitch,
} from './shortcuts.mjs';
import { navigationScript, windowPlan } from './window-route.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
/** What both windows show until their page has painted. */
const BACKGROUND = '#f9f9f7';

// Windows shows a notification only for an app it can name, so the name is in place before the
// first Notification can be made (see APP_USER_MODEL_ID). Only Windows has the idea.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

/** Two copies would fight over the same database file. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/**
 * Data lives beside the app, not beside the source checkout, so it survives
 * updates and reinstalls:  ~/Library/Application Support/FocusDesk/data
 * (%APPDATA%\FocusDesk\data on Windows)
 */
process.env.FOCUSDESK_DATA_DIR ??= path.join(app.getPath('userData'), 'data');
// A packaged app serves the pages it was packaged with, in production, whatever the environment
// it was started in says. Pages from a folder of somebody else's choosing would be the app in its
// own window, with its key to the server, and anything but production has the server trust a dev
// server's origin. Run from a checkout (npm run desktop), the environment may still say.
if (app.isPackaged) {
  process.env.FOCUSDESK_WEB_DIST = path.join(here, 'web');
  process.env.NODE_ENV = 'production';
} else {
  process.env.FOCUSDESK_WEB_DIST ??= path.join(here, 'web');
  process.env.NODE_ENV ??= 'production';
}

let server = null;
/**
 * The key the server asks of every request to its API (see privacy.mjs), made afresh at each
 * launch and held only here: anything else on this computer can reach the port, and nothing else
 * has this.
 */
const token = newToken();
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
      // What Electron does anyway with no Node in the page, said here so that it stays so.
      sandbox: true,
      preload: path.join(here, 'preload.cjs'),
    },
  });
  // WebRTC sends what it does where the request filter (see keepToServer) cannot see it, and the
  // app has no use for it, so it may use UDP only through a proxy. That stops it asking a STUN
  // server for the computer's address, but not a connection over TCP to a TURN relay. Either takes
  // a script running in the page, which the server's Content Security Policy keeps out; this is
  // for the day one gets in all the same.
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  win.loadURL(`${server.url}/?desktop=1`);
  win.once('ready-to-show', () => win.show());

  // The close button keeps the app running in the menu bar (the system tray, off a Mac), quits
  // it, or asks which, as the setting says (see closeWindow). Quitting closes the window too, and
  // that is let through.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void closeWindow();
  });

  // ⌘K (Control+K off a Mac) in this window opens the quick-switch box, as the shortcut that works
  // in any app does. It is not a setting and not global: only this window answers to it, while it
  // has the keyboard, and the page is not given the key (see opensQuickSwitch).
  win.webContents.on('before-input-event', (event, input) => {
    if (!opensQuickSwitch(input, process.platform)) return;
    event.preventDefault();
    openQuickSwitch();
  });

  // Settings lets go of the shortcuts while it listens for a key to record (see suspendHotkeys),
  // and gives them back when it stops. If it never does (the page crashed, was reloaded or moved
  // on, or the window was put away or left) the shortcuts are given back here, so that nothing
  // that happens to the page can leave the person without them. A move inside the page (its
  // own router) is the page's business and is not one of these.
  const giveBackHotkeys = () => {
    if (!suspendAsked) return;
    resumeHotkeys().catch((err) => console.error('[focusdesk] could not take the shortcuts again', err));
  };
  win.on('blur', giveBackHotkeys);
  win.on('hide', giveBackHotkeys);
  win.on('close', giveBackHotkeys);
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) giveBackHotkeys();
  });
  win.webContents.on('render-process-gone', giveBackHotkeys);

  // Anything not served by the local app opens in the real browser, or the mail program, and only
  // if it is a web page or an email address (see openOutside).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url, { shell });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocal(url, server.url)) {
      event.preventDefault();
      openOutside(url, { shell });
    }
  });
}

/**
 * Hide the window and the Dock icon: the app goes on in the menu bar (the system tray, off a
 * Mac, where there is no Dock icon to hide), and the clock with it.
 */
function parkInMenuBar() {
  win?.hide();
  if (isMac) app.dock?.hide();
}

/** A question about closing is on screen: a second press of the button does not ask twice. */
let askingAboutClose = false;

/**
 * The close button was pressed. The setting says whether that keeps the app in the menu bar or
 * quits it; until it has been told, the app asks, and "Don't ask again" makes the answer the
 * setting (Settings can change it back). Asked, Cancel leaves the window as it was. The question
 * is worded for the system it is on (see close-window.mjs): a menu bar and ⌘Q are a Mac's.
 */
async function closeWindow() {
  const what = onClose(settings?.close_behavior);
  if (what === 'menu-bar') return parkInMenuBar();
  // Not from inside the window's close event, which has just been refused: a quit started there
  // finds that window still refusing and stops.
  if (what === 'quit') return void setImmediate(() => app.quit());
  if (askingAboutClose) return;
  askingAboutClose = true;
  try {
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: askButtons(process.platform),
      defaultId: 0,
      cancelId: CANCEL,
      message: askMessage(process.platform),
      detail: askDetail(process.platform),
      checkboxLabel: "Don't ask again",
    });
    const { action, remember } = afterAsking(answer);
    if (remember) {
      try {
        settings = await apiJson('/settings', 'PATCH', { close_behavior: remember });
      } catch (err) {
        console.error('[focusdesk] could not keep the answer about closing', err);
      }
    }
    if (action === 'menu-bar') parkInMenuBar();
    else if (action === 'quit') app.quit();
  } finally {
    askingAboutClose = false;
  }
}

/**
 * Show the main window. With a route ('/wrap-up', '/wrap-up/week?week=2026-10-05') it is taken
 * there first and shown once the page is up, so it never opens on the page it was last left
 * on. A page of the app that is loaded is moved to the route from inside, as a click on its own
 * sidebar would, because loading it again throws away whatever was typed and not yet saved;
 * it is only loaded when there is no page of the app to move (see window-route.mjs). Electron
 * hands an event to the handlers that call this as they are (the tray, the hotkey, the dock
 * icon), so only a string is a route.
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
  const plan = windowPlan({
    currentUrl: win.webContents.getURL(),
    loading: win.webContents.isLoading(),
    route,
    serverUrl: server.url,
  });
  if (plan.action === 'show') {
    reveal();
    return;
  }
  const load = () =>
    win
      .loadURL(plan.url)
      // A page that is replaced by another before it has loaded is not a failure to show it.
      .catch((err) => console.error('[focusdesk] could not open', route, err.message))
      .finally(reveal);
  if (plan.action === 'load') {
    load();
    return;
  }
  win.webContents.executeJavaScript(navigationScript(plan.path)).then(reveal, (err) => {
    // The page could not be moved (it is not the app's page after all): load it instead.
    console.error('[focusdesk] could not move to', route, err.message);
    load();
  });
}

/* ------------------------------------------------------------------ api */

/**
 * Ask the server's API. Every request to it carries the key: these are sent with it, and the
 * windows' requests are given it on their way out (see keepToServer).
 */
async function api(pathname, method = 'GET') {
  const res = await fetch(`${server.url}/api${pathname}`, {
    method,
    headers: { [TOKEN_HEADER]: token },
  });
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
    headers: {
      [TOKEN_HEADER]: token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
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
    throw Object.assign(
      new Error(payload?.error ?? `${method} ${pathname} failed: ${res.status}`),
      {
        status: res.status,
      },
    );
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

/**
 * Read the clock from the server and show it. Resolves to the block that was read (null for
 * none, or when the server could not be asked), which is what away detection wants when it asks
 * what is on the clock *now*.
 */
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
  return live.session;
}

/**
 * Read the clock and what is waiting for an answer again, which is what is wanted when something
 * has just been done somewhere else that changes both (a block started in the window, or the
 * quick-switch box put away) and the menu bar should show it now, and not in 5 s and 15 s.
 */
function refreshMenuBar() {
  return poll().then(() => attention?.refresh());
}

/**
 * The clock text changes every second; the menu only changes when the
 * block does. Rebuilding the menu on every tick is wasted work — and on some
 * platforms the toolkit complains about it.
 */
let menuSignature = null;

/** What the menu-bar item says, as last set: the tests read it, since only a Mac has a title to see. */
let trayText = { title: '', toolTip: '' };

// The tooltip is set again every second, changed or not, and that is kept on purpose: Windows can
// lose it when Explorer restarts (the icon is put back, and not its tip), and the next second's
// call puts it back.
function setTrayText(title, toolTip) {
  trayText = { title, toolTip };
  if (isMac) tray.setTitle(title);
  tray.setToolTip(toolTip);
}

function renderTitle() {
  if (!tray) return;
  const { title, toolTip } = menuBarText({
    session: live.session,
    elapsed: elapsedSeconds(live, Date.now()),
    waiting: attention?.pending() ?? 0,
    // Off a Mac the tooltip is all there is of the clock, and is worded to fit (see menu-bar.mjs).
    platform: process.platform,
  });
  setTrayText(title, toolTip);
}

/** The menu as it was last built, as data that still has its click handlers: what the tests press. */
let builtMenu = null;

function renderMenu() {
  if (!tray) return;
  const s = live.session;
  // The shortcut that shows the window, as it is registered right now: none when it is off, or
  // when it could not be had.
  const showHotkey = hotkeys.active().show;
  // Whether a shortcut is set that could not be registered: the menu says so, since a shortcut
  // that does nothing says nothing.
  const hotkeyTrouble = hotkeysFailing(hotkeyStatuses);
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
    showHotkey,
    hotkeyTrouble,
  ]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const wording = trayMenuWording(process.platform);

  builtMenu = [
    // What is waiting for an answer goes first: it is why the menu-bar item has a dot.
    ...(attention?.menuItems() ?? []),
    ...(s
      ? [
          { label: trimLabel(s.title), enabled: false },
          {
            label: s.projectName ? trimLabel(`Project: ${s.projectName}`) : 'No project',
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
    {
      label: 'Open FocusDesk',
      // The key as a label: it is registered with globalShortcut (see hotkeys), not by the menu.
      ...(showHotkey ? { accelerator: forElectron(showHotkey) } : {}),
      click: showWindow,
    },
    // A shortcut that is set and could not be had: Settings says which, and why, on its row.
    ...hotkeyMenuItems(hotkeyStatuses, () => showWindow('/settings')),
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
      label: wording.dataFolder,
      click: () => void shell.openPath(process.env.FOCUSDESK_DATA_DIR),
    },
    { type: 'separator' },
    {
      label: 'Quit FocusDesk',
      // A Mac's ⌘Q, and not named where there is no such key (see trayMenuWording).
      ...(wording.quitAccelerator ? { accelerator: wording.quitAccelerator } : {}),
      click: () => app.quit(),
    },
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

/**
 * The tray icon: the first of this platform's files (see trayIconFiles) that can be read. A Mac's
 * is a template image, which macOS recolours for light and dark menu bars; the others' are in the
 * app's own colours, since nothing recolours an icon on a Windows taskbar or a Linux panel.
 */
function trayIcon() {
  for (const file of trayIconFiles(process.platform)) {
    const icon = nativeImage.createFromPath(path.join(here, 'assets', file));
    if (icon.isEmpty()) continue;
    if (isMac) icon.setTemplateImage(true);
    return icon;
  }
  console.error('[focusdesk] no tray icon could be read');
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  renderTitle();
  renderMenu();
}

/* ------------------------------------------------------------- shortcuts */

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * A shortcut of the setting as Electron is to be handed it on this system (see nativeAccelerator:
 * off a Mac, Command is written as Super). The setting and what is told about it, here and in
 * Settings, stay in the spelling it was saved in; only the calls into globalShortcut use this.
 */
const forElectron = (accelerator) => nativeAccelerator(accelerator, process.platform);

/** What the pause shortcut does: pause the block on the clock or resume it, or with none, show the window. */
function pauseOrResume() {
  const s = live.session;
  if (!s) {
    showWindow();
    return;
  }
  void act(`/sessions/${s.id}/${s.status === 'paused' ? 'resume' : 'pause'}`);
}

/** Show the quick-switch box, from its shortcut or from ⌘K in the window. Never throws into Electron. */
function openQuickSwitch() {
  try {
    palette.showPalette();
  } catch (err) {
    console.error('[focusdesk] quick switch', err);
  }
}

/**
 * The shortcuts that work in any app: show the window, pause or resume the block on the clock,
 * and open the quick-switch box. Which keys each one is, is its setting (show_hotkey,
 * pause_hotkey, quick_switch_hotkey), and none of them is written down here: see hotkeyPlan for
 * what a setting that is missing means, and createHotkeys for what is done when one changes or
 * cannot be had. Each is handed to Electron through forElectron.
 */
const hotkeys = createHotkeys({
  globalShortcut,
  toSystem: forElectron,
  normalize: (text) => normalizeAccelerator(text),
  handlers: { show: () => showWindow(), pause: pauseOrResume, quickSwitch: openQuickSwitch },
  log: (...args) => console.error('[focusdesk]', ...args),
});

/**
 * How each of the three shortcuts stood the last time they were registered, as applyHotkeys
 * answered: { show, pause, quickSwitch }, each { ok, accelerator, code?, error? }. Null until
 * then. The tray's menu says "A shortcut isn't working" by it. A read of the settings that
 * failed is not a registration that did, and does not replace it.
 */
let hotkeyStatuses = null;

/**
 * Read the settings and make the three shortcuts what they say. Answers { show, pause,
 * quickSwitch }, each { ok, accelerator, code?, error? }: the shortcut that is registered
 * afterwards, null for none, and when the setting asked for one that could not be had, why
 * (`error`) and which kind of why (`code`: 'taken' or 'invalid'). A shortcut that could not be
 * had never costs the one that was working.
 *
 * Settings that cannot be read leave every shortcut as it is, and say so, with the code
 * 'unreadable' on each so that nobody has to read the words to know that nothing was tried. The
 * exception is the start, before anything has been read or registered: a setting that is not
 * there is its default, and one failed read is not a reason to be left without the keys.
 *
 * The tray's "Open FocusDesk" names the shortcut that shows the window, and the tray says when a
 * shortcut is not working, so the menu is built again with whatever that is now.
 */
async function applyHotkeys() {
  let unread = null;
  try {
    settings = await api('/settings');
  } catch (err) {
    console.error('[focusdesk] could not read the settings', err);
    unread = `Could not read the settings: ${messageOf(err)}`;
  }
  if (unread && settings) {
    return Object.fromEntries(
      Object.entries(hotkeys.active()).map(([action, accelerator]) => [
        action,
        { ok: false, accelerator, code: 'unreadable', error: unread },
      ]),
    );
  }
  hotkeyStatuses = hotkeys.apply(settings);
  try {
    renderMenu();
  } catch (err) {
    // The shortcuts are registered; a menu that could not be rebuilt is no reason to say they are not.
    console.error('[focusdesk] could not update the menu', err);
  }
  return hotkeyStatuses;
}

// One at a time, so that two reloads cannot leave the shortcuts at whichever answered last, and
// so that what is asked in one order (let go of, take again, let go of) is done in it.
let hotkeyQueue = Promise.resolve();
function inHotkeyOrder(task) {
  const run = hotkeyQueue.then(task);
  hotkeyQueue = run.catch(() => {});
  return run;
}

function syncHotkeys() {
  return inHotkeyOrder(applyHotkeys);
}

// The shortcuts are let go of while Settings listens for a key to record, since a key that
// FocusDesk holds never reaches the page: its action runs, and the page hears nothing.

/** The longest the shortcuts stay let go of: what a page that never says so is held to. */
const SUSPEND_MAX_MS = 60_000;

/**
 * Whether the page has asked for the shortcuts to be let go of, and not yet for them back. It is
 * set at once, where the shortcuts themselves follow in their turn (see inHotkeyOrder).
 */
let suspendAsked = false;
let suspendTimer = null;

/**
 * Let go of every shortcut until resumeHotkeys, whichever way that comes about: the page says so,
 * the window or the page goes away from under it (see createWindow), or SUSPEND_MAX_MS is up.
 */
function suspendHotkeys() {
  suspendAsked = true;
  clearTimeout(suspendTimer);
  suspendTimer = setTimeout(() => {
    console.error('[focusdesk] the shortcuts were let go of for too long: taking them again');
    resumeHotkeys().catch((err) => console.error('[focusdesk] could not take them again', err));
  }, SUSPEND_MAX_MS);
  return inHotkeyOrder(() => hotkeys.suspend());
}

/**
 * Take the shortcuts again: at once, as they were, which needs nothing from anywhere, and then
 * from the settings as they are now, which is what registers a change made while they were let go
 * of. Always done in the end, whatever the page says or does not.
 */
function resumeHotkeys() {
  suspendAsked = false;
  clearTimeout(suspendTimer);
  suspendTimer = null;
  hotkeys.resume();
  return syncHotkeys();
}

/* ------------------------------------------------ away, and needs attention */

/** How often the machine is asked how long it has been without input. */
const IDLE_POLL_MS = 15_000;
/** How often the server is asked what needs attention. */
const PROMPT_POLL_MS = 15_000;
/** How often the settings are read again, which away detection goes by, besides when one is saved. */
const SETTINGS_POLL_MS = 60_000;

/** What the tests put in place of the clock, the idle time and the lock, to stand in for hours of waiting. */
const stubbed = { now: null, idleSeconds: null, locked: null };

function systemIdleSeconds() {
  if (stubbed.idleSeconds != null) return stubbed.idleSeconds;
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    // Not every platform can say. Never idle is the safe answer: nothing is reported or held back for it.
    return 0;
  }
}

/**
 * Whether the system says the screen is locked right now: what tells somebody at the lock
 * screen from somebody who is back whose unlock was never seen (see away.mjs). A platform that
 * cannot say answers 'unknown', which is not locked; one that throws is taken to be locked, the
 * answer that ends nothing early.
 */
function systemIsLocked() {
  if (stubbed.locked != null) return stubbed.locked;
  try {
    return powerMonitor.getSystemIdleState(1) === 'locked';
  } catch {
    return true;
  }
}

/**
 * The settings as last read. Away detection goes by them, and is off until they have been; the
 * notifications go by them too (see notificationAllowed), and a setting that is not there is on.
 */
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
    // Whether a notification is wanted for a prompt of this kind: the master switch and the
    // kind's own, as the settings were last read. Asked as the prompt is first listed.
    notifyAllowed: (kind) => notificationAllowed(kind, settings),
    showError: (message) => {
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'FocusDesk',
          message: 'That did not work',
          detail: message,
        })
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
    // Asked of the server as each stretch begins, and not read from what the menu bar last saw:
    // that can be five seconds old, and a block stopped in the window a moment before the screen
    // locks is not one anybody was away from (nor is one just started one that was not).
    getLive: () => poll(),
    isLocked: systemIsLocked,
    getSettings: () => settings,
    report: async ({ sessionId, startedAt, endedAt }) => {
      const entry = { sessionId, startedAt, endedAt, ok: true, error: null };
      try {
        await apiJson(`/sessions/${sessionId}/away`, 'POST', { startedAt, endedAt });
      } catch (err) {
        entry.ok = false;
        entry.error = messageOf(err);
        throw err;
      } finally {
        // Noted once it has an outcome, so whoever sees an entry knows how it went.
        reports.push(entry);
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

  // What either window has just done to the server: saving the settings (the thresholds may be
  // different now), and anything that changes the block on the clock, which the menu bar would
  // otherwise not know for five seconds (see requests.mjs for what counts).
  electronSession.defaultSession.webRequest.onCompleted((details) => {
    const again = rereadAfter(details, server.url);
    if (again.settings) void readSettings();
    if (again.live) void refreshMenuBar();
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
        /** Pretend the system says the screen is locked (true) or not (false), or let it say for itself with null. */
        setLocked: (locked) => {
          stubbed.locked = locked;
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

/* ------------------------------------------------- what a Mac does not need */

/**
 * Spell checking that sends nothing anywhere. A Mac checks with its own spell checker and fetches
 * nothing. On Windows and Linux Electron checks with Hunspell dictionaries, and downloads the one
 * for the language that is set from Google (redirector.gvt1.com) as the first window loads: a
 * connection to the outside, which the app promises never to make. Switching the checker off does
 * not stop it, since the download is for the language and not for the checking, so the languages
 * are emptied as well. With both done the app was measured making no connection but to its own
 * server, and looking up no name. It has to be done before the first window exists, and on the
 * default session, which both windows use (the main window and the quick-switch box name no
 * session of their own: a window with a partition of its own would need the same). The price is
 * that nothing typed in the app is underlined there.
 */
function keepSpellCheckerOffline() {
  if (isMac) return;
  electronSession.defaultSession.setSpellCheckerEnabled(false);
  electronSession.defaultSession.setSpellCheckerLanguages([]);
}

/**
 * Electron makes a File, Edit, View, Window and Help bar for an app that does not make a menu of
 * its own, and on Windows and Linux it shows at the top of every window. The app has no use for
 * it there, so it is taken away. A Mac keeps its menu as it is: that is where ⌘Q, copy and paste
 * come from, and it is not a bar in the window.
 *
 * Nothing in the app relies on a menu accelerator off a Mac. The tray menu's accelerators are
 * labels (the keys themselves are registered with globalShortcut, below), and what the pages do
 * with the keyboard they do themselves. What goes with the bar is Electron's own set of keys:
 * Ctrl+R and Ctrl+Shift+R to reload, Ctrl+Shift+I for the developer tools, Ctrl+W to close the
 * window, Ctrl+Q on Linux, zoom, and F11 for full screen.
 */
function dropApplicationMenu() {
  if (!isMac) Menu.setApplicationMenu(null);
}

/* ----------------------------------------------------------------- boot */

app.whenReady().then(async () => {
  // The copy that lost the lock is already quitting; starting a server here
  // would open the same database the running copy has.
  if (!gotLock) return;
  // Before there is a window to have either.
  keepSpellCheckerOffline();
  dropApplicationMenu();
  try {
    // Imported only now, so the env vars above are already in place when the
    // database file is opened at module load.
    let startServer;
    ({ startServer, normalizeAccelerator } = await import('./dist/server.mjs'));
    server = await startServer({ port: 0, host: '127.0.0.1', token });
    console.log(`[focusdesk] serving ${server.url} · data ${server.dataDir}`);
  } catch (err) {
    dialog.showErrorBox(
      'FocusDesk could not start',
      `The local server failed to start.\n\n${err instanceof Error ? err.stack : String(err)}`,
    );
    app.exit(1);
    return;
  }

  // Before either window exists, so that nothing a window loads goes past it: the windows may
  // load from the server alone, their requests to it carry the key, and they are allowed nothing
  // but notifications and writing to the clipboard (see privacy.mjs).
  keepToServer(electronSession.defaultSession, { serverUrl: server.url, token });

  // The windows call these, so they are in place before either page loads. Settings asks for the
  // shortcuts to be read again after it saves one, to be let go of while it listens for a key to
  // record (and given back after), and for a sample notification on request.
  ipcMain.handle('hotkeys:reload', () => syncHotkeys());
  ipcMain.handle('hotkeys:suspend', async (event, on) => {
    // Only the main window records a shortcut, and only its events give the shortcuts back
    // (see createWindow): a page that is not that window is not let to take them away.
    if (event.sender !== win?.webContents) return;
    await (on === true ? suspendHotkeys() : resumeHotkeys());
  });
  ipcMain.handle('notification:test', () => showTestNotification({ Notification }));
  palette = createPalette({
    serverUrl: server.url,
    backgroundColor: BACKGROUND,
    // The box may have changed what is on the clock, and a block that is started answers the
    // nudge to start one: show both in the menu bar now, not in 5s and 15s.
    onClose: () => void refreshMenuBar(),
  });
  if (process.env.FOCUSDESK_TEST === '1') {
    // What the end-to-end tests reach into the running app by, and nothing else does.
    globalThis.__focusdesk = {
      serverUrl: server.url,
      /** The key to the server's API, for the tests' own requests to it: only when testing. */
      token,
      showPalette: palette.showPalette,
      hidePalette: palette.hidePalette,
      get paletteWindow() {
        return palette.window;
      },
      /** Whether the quick-switch box is on screen. */
      paletteVisible: () => !!palette.window?.isVisible(),
      /** What is registered for each shortcut, as saved: { show, pause, quickSwitch }, null for none. */
      get activeHotkeys() {
        return hotkeys.active();
      },
      /** The quick-switch shortcut: what this was before there were three. */
      get activeHotkey() {
        return hotkeys.active().quickSwitch;
      },
      /** Whether the shortcuts are let go of for now, while Settings listens for a key. */
      hotkeysSuspended: () => hotkeys.suspended(),
      /** How each shortcut stood when last registered, as the tray reads it: null before that. */
      hotkeyStatuses: () => (hotkeyStatuses ? JSON.parse(JSON.stringify(hotkeyStatuses)) : null),
    };
  }

  createWindow();
  createTray();

  await poll();
  setInterval(() => void poll(), 5_000);
  setInterval(renderTitle, 1_000);

  // All three shortcuts, as the settings have them.
  console.log(`[focusdesk] shortcuts: ${describeHotkeys(await syncHotkeys())}`);

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
