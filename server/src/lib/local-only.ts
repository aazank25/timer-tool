import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './http.js';

/**
 * FocusDesk has no sign-in, because it listens on loopback and only this computer can reach it.
 * A web page in the person's own browser is on this computer too, though, and has two ways in:
 *
 * - DNS rebinding. Once the page has loaded, the site it came from can have its name pointed at
 *   127.0.0.1. The page then talks to this server as if it were its own origin, and the browser
 *   lets it read every answer. What gives it away is the Host header, which still holds the
 *   site's name, so only the loopback names are answered.
 * - Cross-site writes. Any page can make the browser send a POST here. It cannot read the answer,
 *   but it does not need to for a route like pause or complete, which take no body and so have
 *   nothing to be refused for. What gives it away is the Origin header, or Sec-Fetch-Site, which
 *   the browser adds and a page cannot change.
 *
 * Mounted before everything else, the client bundle included, so that none of it is reached by a
 * request that did not come from the app. The app's own requests all pass: the web client is
 * served from here (or from the Vite dev server, which proxies /api and passes the browser's
 * Origin through), and the desktop app's main process uses Node's fetch, which sends no Origin.
 *
 * This keeps web pages out, and that is all. Anything that is not a browser can send any Host it
 * likes, so it is no substitute for listening on loopback only.
 */

/**
 * What a Host header, or an Origin after its `http://`, may say: one of the three loopback
 * names, in any case, with a port or without. It is spelled out rather than worked out, so that
 * nothing gets in by accident. Left out on purpose:
 *
 *   localhost.          the trailing dot. It is the same name to a resolver, but nobody opens
 *                       the app that way, and every extra spelling is one more to get right.
 *   127.1, 2130706433   other spellings of 127.0.0.1. A browser rewrites them before it sends
 *                       anything, so only a client that is not a browser would send them.
 *   127.0.0.2 and up    the rest of 127/8, which the server does not listen on.
 *   0.0.0.0             which most systems send to this computer, and which browsers have let
 *                       pages reach local servers by, but which nobody opens the app at.
 *   ::1                 without its brackets, which is not a Host at all.
 */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;

function isLoopback(authority: string): boolean {
  const match = LOOPBACK.exec(authority);
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65535);
}

/**
 * An Origin the app's own pages can have: plain http and a loopback host, as a browser writes
 * it. Not `null`, not https, and not a look-alike such as 127.0.0.1.evil.com.
 */
function isLoopbackOrigin(origin: string): boolean {
  return /^http:\/\//i.test(origin) && isLoopback(origin.slice('http://'.length));
}

/**
 * Whether the request is for this server, by one of its own names, said once.
 *
 * The request line is read as well as Host. A client talking to a proxy writes the whole address
 * there (`GET http://evil.com/api/settings`). Node hands that over as it came, Express routes on
 * the path inside it, and Host stays whatever was sent, so a request for another site would be
 * answered here under a Host of 127.0.0.1. A browser does that only to a proxy, never to the
 * server it is talking to, so a plain path is the only form answered. Two Host lines are refused
 * for the same reason: Node reads the first, and what a request is for should not depend on who
 * is reading.
 */
function isForThisServer(req: Request): boolean {
  if (!req.originalUrl.startsWith('/')) return false;
  const hostLines = req.rawHeaders.filter(
    (name, i) => i % 2 === 0 && name.toLowerCase() === 'host',
  );
  return hostLines.length === 1 && isLoopback(req.headers.host ?? '');
}

/**
 * A request that only reads changes nothing, so it is not asked where it came from: a page that
 * reads from another site is stopped by the browser's own CORS rule, and one that got here by
 * rebinding is stopped by the Host check.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether this is a request that changes something, sent by a page of another site. A browser
 * puts an Origin on every such request, and says Sec-Fetch-Site: cross-site on one that crossed
 * sites, so the app's own pages (an Origin of a loopback http address) pass, and so does a client
 * that is not a browser and sends neither.
 */
function isCrossSiteWrite(req: Request): boolean {
  if (READS.has(req.method)) return false;
  const { origin } = req.headers;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return true;
  return String(req.headers['sec-fetch-site'] ?? '').toLowerCase().includes('cross-site');
}

/**
 * Refuse a request that does not come from the app itself: a 403 in the same shape as every
 * other error, with no route run and nothing written. Mount it first.
 */
export function localOnly(req: Request, _res: Response, next: NextFunction): void {
  if (!isForThisServer(req)) {
    next(new HttpError(403, 'FocusDesk only answers requests for localhost, 127.0.0.1 or [::1]'));
    return;
  }
  if (isCrossSiteWrite(req)) {
    next(new HttpError(403, 'FocusDesk does not take changes from other websites'));
    return;
  }
  next();
}
