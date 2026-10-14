import fs from 'node:fs';
import path from 'node:path';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import express from 'express';
import { startCalendarSync } from './lib/calendar.js';
import { config } from './lib/config.js';
import { errorMiddleware } from './lib/http.js';
import { localOnly } from './lib/local-only.js';
import { initDb } from './db.js';
import { apiRouter } from './routes/index.js';

export interface RunningServer {
  port: number;
  url: string;
  dataDir: string;
  hasWebBuild: boolean;
  close(): Promise<void>;
}

export { normalizeAccelerator } from './lib/accelerator.js';
export { INTERRUPTION_REASONS } from './lib/interruptions.js';

/** How often the calendar feeds are read in the background. */
const DEFAULT_CALENDAR_SYNC_MS = 15 * 60_000;

/**
 * FOCUSDESK_CALENDAR_SYNC_MS sets it; 0 switches the background sync off, which is what a
 * test or a machine that must never reach out wants. A value that is not a number of
 * milliseconds, or is negative, is ignored.
 */
export function calendarSyncMs(): number {
  const raw = process.env.FOCUSDESK_CALENDAR_SYNC_MS;
  const ms = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : DEFAULT_CALENDAR_SYNC_MS;
}

export interface AppOptions {
  /**
   * What every request for the API must carry in its x-focusdesk-token header, so that only
   * whoever started the server can use it: the desktop app makes a new one at every launch.
   * Left out, or empty, the API asks for none, as under `npm start` and `npm run dev`.
   */
  token?: string;
}

export function createApp({ token }: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // First of all, ahead of the body parser, the API and the client bundle: nothing below is
  // reached by a request that did not come from the app itself.
  app.use(localOnly(token));
  app.use(express.json({ limit: '2mb' }));

  // No CORS, in development either: the client is served from this origin, or from the Vite dev
  // server, which proxies /api so that the page asks its own origin. Allowing another origin to
  // read the API would let any page that origin serves read all of it.
  app.use('/api', apiRouter);

  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    // Client-side routing: everything that is not /api falls back to the shell.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorMiddleware);
  return app;
}

/**
 * The addresses the server may listen on: loopback, by the names it goes by. Anything else, a
 * network address or 0.0.0.0 for all of them, would put the API in reach of other computers,
 * and the Host check in local-only.ts does not keep out a client that is not a browser.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/**
 * What loopback is, of an address the system says it bound: all of 127/8, and ::1. An IPv4 address
 * on an IPv6 socket (::ffff:127.0.0.1) is read as the IPv4 address it carries, and so is not
 * mistaken for another one.
 */
const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

function isLoopbackAddress(address: string): boolean {
  if (isIPv4(address)) return LOOPBACK_ADDRESSES.check(address, 'ipv4');
  return isIPv6(address) && LOOPBACK_ADDRESSES.check(address, 'ipv6');
}

/**
 * Boot the API and the client bundle on a loopback port.
 *
 * Pass `port: 0` to take whatever port is free — that is what the desktop app
 * does, so two copies of FocusDesk can never fight over one port.
 *
 * Throws when asked to listen anywhere but on loopback, whether by `host` or by FOCUSDESK_HOST,
 * before the database is migrated or anything listens. A name is not an address, though, and which
 * one `localhost` is belongs to the resolver, so once the server is bound the address it really got
 * is looked at too. If that is not loopback the server is shut again and this throws, before the
 * server has answered anyone or started reading a calendar.
 */
export async function startServer(
  opts: {
    port?: number;
    host?: string;
    /** Milliseconds between background calendar syncs; 0 for none. Defaults to FOCUSDESK_CALENDAR_SYNC_MS, then 15 minutes. */
    calendarSyncMs?: number;
  } & AppOptions = {},
): Promise<RunningServer> {
  const host = opts.host ?? config.host;
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      'FocusDesk listens on loopback only: the host must be 127.0.0.1, ::1 or localhost, ' +
        `not ${JSON.stringify(host)}`,
    );
  }
  initDb();
  const app = createApp({ token: opts.token });
  const port = opts.port ?? config.port;

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(port, host);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  // Nothing has been answered yet, and nothing will be until this has passed. A name is not an
  // address: which one `localhost` is belongs to the resolver, and a hosts file that puts it on
  // 0.0.0.0 has listen() take every interface, with the name on the list above.
  const bound = server.address();
  if (bound === null || typeof bound === 'string' || !isLoopbackAddress(bound.address)) {
    const where = typeof bound === 'object' && bound !== null ? bound.address : String(bound);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      'FocusDesk listens on loopback only: ' +
        `${JSON.stringify(host)} was bound to ${JSON.stringify(where)}, which is not loopback`,
    );
  }

  // Meeting prompts read the synced events, which would otherwise only move when Sync now
  // is pressed. It only fetches while a feed is switched on.
  const stopCalendarSync = startCalendarSync({ everyMs: opts.calendarSyncMs ?? calendarSyncMs() });

  return {
    port: bound.port,
    url: `http://${host}:${bound.port}`,
    dataDir: config.dataDir,
    hasWebBuild: fs.existsSync(path.join(config.webDist, 'index.html')),
    close: async () => {
      // Reading a feed is the one thing that goes on without a request to wait for. It is cut
      // short and waited for, so that nothing is written once this has returned.
      await stopCalendarSync();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
