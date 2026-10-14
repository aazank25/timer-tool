/**
 * What keeps the app to the person who runs it. The server listens on 127.0.0.1, which every
 * program on this computer can reach, whoever runs it, so it answers its API only to requests
 * that carry a key: one made afresh at each launch, which only this process holds. The windows
 * show the server's pages and nothing else: what they may load, what their requests carry and
 * what they may be allowed are held to it here, on the session both windows use, and what they
 * may open outside the app is held to web pages.
 *
 * Nothing here imports Electron. What it needs of it (the session, the shell) is handed in, the
 * way attention.mjs and shortcuts.mjs are handed theirs, so every rule can be tested without a
 * window.
 */
import { randomBytes } from 'node:crypto';
import { onServer } from './window-route.mjs';

/**
 * The header the server's API asks for, which holds the key. No page is given the key: it is put
 * on the windows' requests on their way out (see sendWith), where no script can read it, and the
 * main process sends it with its own (api and apiJson, in main.mjs). It is never logged.
 */
export const TOKEN_HEADER = 'x-focusdesk-token';

/** A key for one launch of the app: 32 random bytes, written so that it can go in a header. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * What a request from a window goes out with, as the answer to webRequest.onBeforeSendHeaders:
 * the key, when it is for the app's own server (the same scheme, host and port, compared as
 * parsed addresses and never as text), on top of what the page sent. A header of that name that
 * the page set itself, in any spelling, is replaced, so a page cannot choose the key. A request
 * for anywhere else is left exactly as it is. Electron asks again at each address a request is
 * redirected to, without what was added for the one before, so the key goes nowhere but the
 * server.
 *
 * @param {{ url?: string, requestHeaders?: Record<string, string> }} details As Electron gives
 *   them to webRequest.onBeforeSendHeaders.
 * @param {string} serverUrl The address the app is served from.
 * @param {string} token The key.
 * @returns {{ requestHeaders?: Record<string, string> }} An empty answer for a request left as
 *   it is.
 */
export function sendWith(details, serverUrl, token) {
  const { url, requestHeaders } = details ?? {};
  if (!onServer(url, serverUrl)) return {};
  const sent = Object.entries(requestHeaders ?? {}).filter(
    ([name]) => name.toLowerCase() !== TOKEN_HEADER,
  );
  return { requestHeaders: { ...Object.fromEntries(sent), [TOKEN_HEADER]: token } };
}

/**
 * What a window may load besides the app's own pages: what is made inside it and never leaves the
 * computer. A data: or blob: address is made by the page itself, and devtools: and
 * chrome-extension: are the developer tools' own.
 */
const INSIDE = new Set(['data:', 'blob:', 'devtools:', 'chrome-extension:']);

/**
 * Whether a window may make this request: one to the app's own server, or for an address of the
 * kinds above. The app's pages fetch nothing from anywhere else (no font, no script, no picture),
 * so a request for anywhere else is a page sending something out that it should not, and it is
 * cancelled before it is made. Anything that does not parse is cancelled too.
 */
export function mayLoad(url, serverUrl) {
  if (onServer(url, serverUrl)) return true;
  try {
    return INSIDE.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * What a page of the app may be allowed: to show a notification (a block that is done) and to
 * put text on the clipboard (Copy, on the wrap-up's summary). Electron grants a page whatever it
 * asks for unless the session says otherwise: the microphone and the camera, where the computer
 * is, what is on the clipboard, handing an address to another program.
 */
const PAGE_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

/**
 * Whether `permission` is allowed to a page at `url`, which may be the page's address or only its
 * origin: one of the two above, for a page of the app's own server. Everything else, and anything
 * for any other page, is refused.
 */
export function permitted(permission, url, serverUrl) {
  return PAGE_PERMISSIONS.has(permission) && onServer(url, serverUrl);
}

/**
 * What is opened outside the app, in the browser the system has for it: web pages. Not an email
 * address either. The app has no link to one, and the mail program reads what follows the ? in one
 * as options of its own, which on some systems include a file on this computer to attach.
 */
const OUTSIDE = new Set(['http:', 'https:']);

/**
 * Open `url` outside the app, in the browser, if it is a web page, and say whether it was. Any
 * other kind of address is refused: the system hands it to whichever program says it is the one
 * for it (a file share, a remote desktop, a search of another computer's files, a mail program,
 * an installed app with a scheme of its own) without asking anybody, so a link the app did not
 * write itself could start any of them. An address that does not parse is refused too. The
 * browser is handed the address as it was read here, which is what was checked. Of a refused one
 * only the scheme is logged, and never the address: it can hold anything.
 *
 * @param {string} url
 * @param {object} deps
 * @param {{ openExternal(url: string): Promise<void> }} deps.shell Electron's shell.
 * @param {(...args: unknown[]) => void} [deps.warn] Where a refusal is logged.
 * @returns {boolean}
 */
export function openOutside(url, { shell, warn = console.warn }) {
  let address;
  try {
    address = new URL(url);
  } catch {
    warn('[focusdesk] did not open a link that is not an address');
    return false;
  }
  if (!OUTSIDE.has(address.protocol)) {
    warn(`[focusdesk] did not open a ${address.protocol} link: only web links open`);
    return false;
  }
  shell.openExternal(address.href).catch(() => {
    warn(`[focusdesk] the system could not open a ${address.protocol} link`);
  });
  return true;
}

/**
 * Hold the windows to the app's own server, on the session they both use: a request for anywhere
 * else is cancelled, a request to the server carries the key, a page of the app may show
 * notifications and write to the clipboard, and nothing may have anything else, nor any device.
 * Done before either window exists, so that nothing is loaded before it.
 *
 * Only what the windows load goes through the session. The main process's own requests to the
 * server, and the calendar feeds that the server reads, are made with Node's fetch, which never
 * goes through it, and are not held here.
 *
 * Electron keeps one listener for each of these events on a session, and a second one put in
 * replaces the first without a word, so nothing else in the app may listen for them
 * (webRequest.onCompleted, in main.mjs, is another event).
 *
 * @param {object} session Electron's session (the default one).
 * @param {{ serverUrl: string, token: string }} server The address the app is served from, and
 *   the key.
 */
export function keepToServer(session, { serverUrl, token }) {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !mayLoad(details?.url, serverUrl) });
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(sendWith(details, serverUrl, token));
  });
  // A page asking for a permission, by the address of the frame that asks.
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permitted(permission, details?.requestingUrl, serverUrl));
  });
  // Whether a page has one already, by its origin: most ask this first, and some ask only this.
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permitted(permission, requestingOrigin, serverUrl),
  );
  // Nothing in the app talks to a USB, serial or HID device.
  session.setDevicePermissionHandler(() => false);
}
