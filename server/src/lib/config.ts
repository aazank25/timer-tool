import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib -> src -> server -> repo root  (dist/lib -> dist -> server -> repo root)
const repoRoot = path.resolve(here, '..', '..', '..');

export const config = {
  /**
   * Where the server listens: loopback only, and startServer refuses anything else. The API asks
   * for no sign-in, and without a token (as under `npm start`) it answers whatever reaches it.
   */
  host: process.env.FOCUSDESK_HOST ?? '127.0.0.1',
  port: Number(process.env.FOCUSDESK_PORT ?? 4317),
  dataDir: process.env.FOCUSDESK_DATA_DIR ?? path.join(repoRoot, 'data'),
  /** Directory of the built web client, served in production. */
  webDist: process.env.FOCUSDESK_WEB_DIST ?? path.join(repoRoot, 'web', 'dist'),
  /**
   * The Vite dev server's origins. Outside production a write from its page is taken as the app's
   * own even through a proxy that puts this server's address in the Host (isOwnOrigin in
   * local-only.ts). The repo's dev server passes the browser's Host on, and needs none of this.
   */
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  isProd: process.env.NODE_ENV === 'production',
};

/** Windows has no modes to set, and keeps the folders of a profile to their owner already. */
const POSIX = process.platform !== 'win32';

/**
 * The data folder, made if it is not there, and kept to the account it belongs to. Everything
 * the person has done is in it, and so is the address of their calendar feed, which is as good as
 * a password to the calendar, so no other account on this computer may list it or read from it.
 * The mode is set as well as asked for: asking does nothing to a folder that is already there,
 * and one made by hand, or by anything that does not ask, is open to every account.
 */
export function ensureDataDir(dir: string = config.dataDir): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) fs.chmodSync(dir, 0o700);
  return dir;
}

export const dbPath = () => path.join(ensureDataDir(), 'focusdesk.sqlite');

/** Read and written by its owner, and by no other account. Nothing is done if it is not there. */
export function keepToOwner(file: string): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Keep a database to its owner, along with what SQLite keeps beside it: run before SQLite opens
 * it. SQLite would make a new database with the mode every new file gets, which on most systems
 * lets every account read it, so one that is not there yet is made here, empty, with the owner's
 * mode. The -wal and -shm files SQLite makes later take the database's own mode. One that is
 * there already, and what a crash left beside it, are set to the owner's mode as well.
 *
 * A file that is there already is never opened here: closing it would let go of any lock this
 * process holds on it through SQLite.
 */
export function keepDatabaseToOwner(file: string): void {
  if (!POSIX) return;
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  for (const each of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) keepToOwner(each);
}
