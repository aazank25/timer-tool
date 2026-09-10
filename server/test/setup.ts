import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point the app at a throwaway database *before* anything imports db.ts,
 * which opens the file at module load.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-test-'));
process.env.FOCUSDESK_DATA_DIR = dir;
process.env.TZ = 'UTC';

export const testDataDir = dir;

export async function freshDb() {
  const { initDb, db } = await import('../src/db.js');
  initDb();
  db.exec(`DELETE FROM session_segments; DELETE FROM sessions; DELETE FROM plan_items;
           DELETE FROM calendar_events; DELETE FROM projects;`);
  return db;
}
