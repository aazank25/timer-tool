import { db, DEFAULT_SETTINGS } from '../db.js';
import { hostTimeZone } from './time.js';

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key];
}

export function setSettings(patch: Record<string, string | number | boolean>): void {
  const up = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) up.run(k, String(v));
  })();
}

export function getNumber(key: string, fallback: number): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : fallback;
}

/** Timezone every day boundary in the app is resolved against. */
export const tz = () => getSetting('timezone') || hostTimeZone();
export const dayStartHour = () => getNumber('day_start_hour', 4);
