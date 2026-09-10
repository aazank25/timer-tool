import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import cors from 'cors';
import express from 'express';
import { config } from './lib/config.js';
import { errorMiddleware } from './lib/http.js';
import { initDb } from './db.js';
import { apiRouter } from './routes/index.js';

export interface RunningServer {
  port: number;
  url: string;
  dataDir: string;
  hasWebBuild: boolean;
  close(): Promise<void>;
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // The Vite dev server runs on a different port; in production — and inside
  // the desktop app — the client is served from this origin and needs no CORS.
  if (!config.isProd) app.use(cors({ origin: config.devOrigins }));

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
 * Boot the API and the client bundle on a loopback port.
 *
 * Pass `port: 0` to take whatever port is free — that is what the desktop app
 * does, so two copies of FocusDesk can never fight over one port.
 */
export async function startServer(
  opts: { port?: number; host?: string } = {},
): Promise<RunningServer> {
  initDb();
  const app = createApp();
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(port, host);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://${host}:${actual}`,
    dataDir: config.dataDir,
    hasWebBuild: fs.existsSync(path.join(config.webDist, 'index.html')),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
