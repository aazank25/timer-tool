/**
 * All instants are stored as UTC ISO-8601 strings.
 * "Days" are user-facing and therefore resolved in the user's timezone,
 * which is a setting (defaults to the host timezone).
 */

export const nowIso = () => new Date().toISOString();

export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** YYYY-MM-DD for an instant, as seen in `tz`. */
export function localDay(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // en-CA renders ISO-like YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Hour of day (0-23) for an instant, as seen in `tz`. */
export function localHour(iso: string | Date, tz: string): number {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return Number(h) % 24;
}

/** Inclusive list of YYYY-MM-DD between two day keys. */
export function dayRange(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Shift a day key by n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday-anchored week start for a day key. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(day, -dow);
}

export function secondsBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
}

/**
 * The day a focus block belongs to. Blocks started after midnight but before
 * `dayStartHour` count toward the previous day, so a 1am push still shows up
 * on the day it felt like.
 */
export function focusDay(iso: string | Date, tz: string, dayStartHour: number): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return localDay(new Date(d.getTime() - dayStartHour * 3_600_000), tz);
}
