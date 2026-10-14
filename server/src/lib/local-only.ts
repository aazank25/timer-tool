import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from './config.js';
import { HttpError } from './http.js';

/**
 * FocusDesk listens on loopback, so only this computer can reach it. A web page in the person's
 * own browser is on this computer too, though, and has these ways in:
 *
 * - DNS rebinding. Once the page has loaded, the site it came from can have its name pointed at
 *   127.0.0.1. The page then talks to this server as if it were its own origin, and the browser
 *   lets it read every answer. What gives it away is the Host header, which still holds the
 *   site's name, so only the loopback names are answered.
 * - Cross-site requests. Any page can make the browser send a request here. It cannot read the
 *   answer, but it does not need to for a write like pause or complete, which take no body and
 *   so have nothing to be refused for. A read it cannot see still has the server do the work of
 *   it, as often as the page likes, and whether it loads tells the page that the app is there,
 *   and on which port. What gives it away is the Origin header, or Sec-Fetch-Site, which the
 *   browser adds and a page cannot change. That goes for a page another program serves on this
 *   computer too: on another port it is another site, loopback or not.
 * - Framing. A page that cannot send a write itself can show the app in a frame and get the
 *   person to click in it. Every answer says it is not to be framed.
 *
 * Mounted before everything else, the client bundle included, so that none of it is reached by a
 * request that did not come from the app. The app's own requests all pass: the web client is
 * served from here (or from the Vite dev server, whose proxy passes the browser's Host, Origin
 * and Sec-Fetch-Site on as they were, so that its page is the app's own here as well), and the
 * desktop app's main process uses Node's fetch, which sends no Origin and no Sec-Fetch-Site.
 *
 * None of that keeps out a program that is not a browser. It can send any Host and any Origin it
 * likes, or none, and so can another account on this computer, which reaches loopback as well.
 * For those the server is started with a token, and then every request for the API has to carry
 * it. The desktop app makes a new one each time it starts, and only it holds it. `npm start` and
 * `npm run dev` start the server without one, and there the API answers whatever on this computer
 * is not a web page. Neither is a substitute for listening on loopback only, which is why the
 * server will not listen anywhere else.
 */

/**
 * What a Host header may say: one of the three loopback names, in any case, with a port or
 * without. It is spelled out rather than worked out, so that nothing gets in by accident. Left out
 * on purpose:
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
 * Every path the API is served on: /api and everything under it. Express routes /API and /Api
 * there as well, so the case is not looked at here either.
 */
const API = /^\/api(?:\/|$)/i;

/**
 * Where the page may load anything from, and send anything to: this server, and nowhere else.
 * The client is a script and a stylesheet of its own, with nothing written inline, so that is
 * all it needs, and a script that got into the page some other way could neither run from an
 * inline handler or a javascript: link nor send what it read anywhere. No plugins, no <base>,
 * no form that submits, and no frame of another page around it.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Whether an Origin is the app's own: the page was served by this server, at the very name and
 * port the request is addressed to (the Host, already checked to be a loopback one), as a browser
 * writes it. Another program's page on another port of this computer is not the app, and neither
 * is `null`, https, or a look-alike such as 127.0.0.1.evil.com.
 *
 * While developing, the page comes from the Vite dev server instead. Its proxy passes on the Host
 * the browser used, so a write from that page is the app's own by the same rule. A proxy that
 * puts this server's address in the Host instead (Vite's changeOrigin) leaves the dev page's
 * Origin against a Host it does not match, so the dev server's own origins (config.devOrigins)
 * are taken as well, outside production only: the desktop app and `npm start` run in production.
 */
function isOwnOrigin(origin: string, host: string): boolean {
  const lower = origin.toLowerCase();
  if (lower === `http://${host.toLowerCase()}`) return true;
  return !config.isProd && config.devOrigins.includes(lower);
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
 * Whether the request carries the token the server was started with. It is compared in a time
 * that does not depend on how much of it is right, so that it cannot be worked out a character
 * at a time from how long a refusal takes. One of another length is wrong without comparing.
 */
function carriesToken(req: Request, token: Buffer): boolean {
  const sent = req.headers['x-focusdesk-token'];
  if (typeof sent !== 'string') return false;
  const given = Buffer.from(sent, 'utf8');
  return given.length === token.length && timingSafeEqual(given, token);
}

/**
 * Whether the browser says the request comes from a page of another site, or of another port of
 * this one (Sec-Fetch-Site: cross-site, or same-site for another port of the same name). The
 * app's own pages are same-origin, an address typed in or a bookmark is none, and a client that
 * is not a browser sends nothing at all.
 */
function isFromAnotherSite(req: Request): boolean {
  return /cross-site|same-site/.test(String(req.headers['sec-fetch-site'] ?? '').toLowerCase());
}

/**
 * A request that only reads changes nothing, so its Origin is not asked about: the browser does
 * not let a page of another site read the answer, and one that got here by rebinding is stopped
 * by the Host check. A read of the API is still refused when the browser says it came from
 * another site (see readsFromAnotherSite).
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether this is a request that changes something, sent by a page that is not the app's own. A
 * browser puts an Origin on every such request, and says on one that came from another site or
 * another port. The app's own pages are same-origin, so they pass, and so does a client that is
 * not a browser and sends neither.
 */
function isForeignWrite(req: Request): boolean {
  if (READS.has(req.method)) return false;
  const { origin } = req.headers;
  if (origin !== undefined && !isOwnOrigin(origin, req.headers.host ?? '')) return true;
  return isFromAnotherSite(req);
}

/**
 * Whether this is a read of the API that the browser says another site's page asked for. The app
 * never reads its API from anywhere but its own pages, so nothing of it is lost, and a page
 * elsewhere can neither have the server work for it nor find out that it is there. The client
 * bundle is still served to another site's link: following one is how the app is opened from
 * anywhere else, and the bundle holds nothing of the person's.
 */
function readsFromAnotherSite(req: Request): boolean {
  return API.test(req.path) && isFromAnotherSite(req);
}

/**
 * The token the server was started with, if any. Not having one is said by leaving it out, or as
 * an empty string. Anything else that is not a string is a mistake by whoever started the server,
 * and running with no token at all because of it would be the wrong way to fail.
 */
function tokenBytes(token: unknown): Buffer | null {
  if (token === undefined || token === '') return null;
  if (typeof token !== 'string') throw new TypeError('The API token must be a string');
  return Buffer.from(token, 'utf8');
}

/**
 * Refuse a request that does not come from the app itself: a 403 in the same shape as every
 * other error, with no route run and nothing written. Mount it first.
 *
 * Given a token, every request for the API (any method, /api/health included) must carry it in an
 * x-focusdesk-token header. The client bundle needs none: it is the same for everyone. The token
 * is never said in a refusal, or anywhere else.
 */
export function localOnly(token?: string): RequestHandler {
  const expected = tokenBytes(token);
  return (req, res, next) => {
    // On every answer, a refusal included: the policy above; the app never frames itself, so
    // nothing else may (the old header as well as the policy's); a file is only ever what its
    // type says it is; and no address of the app's goes out with a link that is followed.
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!isForThisServer(req)) {
      next(new HttpError(403, 'FocusDesk only answers requests for localhost, 127.0.0.1 or [::1]'));
      return;
    }
    if (expected !== null && API.test(req.path) && !carriesToken(req, expected)) {
      next(new HttpError(403, 'FocusDesk only answers the app that started it'));
      return;
    }
    if (isForeignWrite(req)) {
      next(new HttpError(403, 'FocusDesk does not take changes from other websites'));
      return;
    }
    if (readsFromAnotherSite(req)) {
      next(new HttpError(403, 'FocusDesk does not answer other websites'));
      return;
    }
    next();
  };
}
