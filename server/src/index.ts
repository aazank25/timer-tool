import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config } from './lib/config.js';
import { errorMiddleware } from './lib/http.js';
import { initDb } from './db.js';
import { apiRouter } from './routes/index.js';

initDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// The Vite dev server runs on a different port; in production the client is
// served from this same origin and needs no CORS at all.
if (!config.isProd) app.use(cors({ origin: config.devOrigins }));

app.use('/api', apiRouter);

const hasWebBuild = fs.existsSync(path.join(config.webDist, 'index.html'));
if (hasWebBuild) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  // Client-side routing: everything that is not /api falls back to the shell.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

app.use(errorMiddleware);

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log(`[focusdesk] api ready at ${url}/api`);
  console.log(
    hasWebBuild
      ? `[focusdesk] open ${url}`
      : `[focusdesk] no web build found — run \`npm run dev\` for the UI, or \`npm run build\` first`,
  );
  console.log(`[focusdesk] data: ${config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
