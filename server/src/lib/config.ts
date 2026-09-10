import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib -> src -> server -> repo root  (dist/lib -> dist -> server -> repo root)
const repoRoot = path.resolve(here, '..', '..', '..');

export const config = {
  /** Loopback only. This app is single-user and unauthenticated by design. */
  host: process.env.FOCUSDESK_HOST ?? '127.0.0.1',
  port: Number(process.env.FOCUSDESK_PORT ?? 4317),
  dataDir: process.env.FOCUSDESK_DATA_DIR ?? path.join(repoRoot, 'data'),
  /** Directory of the built web client, served in production. */
  webDist: process.env.FOCUSDESK_WEB_DIST ?? path.join(repoRoot, 'web', 'dist'),
  /** Vite dev server origin, allowed through CORS during development. */
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  isProd: process.env.NODE_ENV === 'production',
};

export function ensureDataDir(): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}

export const dbPath = () => path.join(ensureDataDir(), 'focusdesk.sqlite');
