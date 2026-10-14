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

type Shape = 'day' | 'hour' | 'wall';

function build(shape: Shape, timeZone: string): Intl.DateTimeFormat {
  switch (shape) {
    case 'day':
      // en-CA renders ISO-like YYYY-MM-DD.
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    case 'hour':
      return new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        hour12: false,
      });
    case 'wall':
      // Everything on the clock, to the second, and the era, which the year is counted in.
      // h23, so that midnight is 00 and not 24.
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        era: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter for each zone and each thing read off it. Building one costs far more than
 * using it, and the memory each holds is slow to come back: the hour rollup asks once for
 * every minute it walks, and building one each time made a 90-day review take over a second
 * and grow the process by hundreds of megabytes.
 */
function formatter(shape: Shape, timeZone: string): Intl.DateTimeFormat {
  const key = `${shape}|${timeZone}`;
  let found = formatters.get(key);
  if (!found) {
    found = build(shape, timeZone);
    formatters.set(key, found);
  }
  return found;
}

/** YYYY-MM-DD for an instant, as seen in `tz`. Epoch milliseconds are taken as they are. */
export function localDay(iso: string | Date | number, tz: string): string {
  return formatter('day', tz).format(typeof iso === 'string' ? new Date(iso) : iso);
}

/** Hour of day (0-23) for an instant, as seen in `tz`. Epoch milliseconds are taken as they are. */
export function localHour(iso: string | Date | number, tz: string): number {
  return Number(formatter('hour', tz).format(typeof iso === 'string' ? new Date(iso) : iso)) % 24;
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
 * What the clocks of `tz` read at an instant, as the instant at which UTC's clocks read the
 * same. Hours taken off it are hours taken off the clock, with no clock change in the way.
 */
function wallClock(ms: number, tz: string): number {
  const shown: Record<string, string> = {};
  for (const part of formatter('wall', tz).formatToParts(ms)) shown[part.type] = part.value;
  const reading = new Date(0);
  // A year is counted within its era, so 1 BC comes back as 1, and it is the year 0.
  const year = shown.era === 'BC' ? 1 - Number(shown.year) : Number(shown.year);
  reading.setUTCFullYear(year, Number(shown.month) - 1, Number(shown.day));
  // The clock is read to the second; what is left of the second is the instant's own.
  reading.setUTCHours(
    Number(shown.hour),
    Number(shown.minute),
    Number(shown.second),
    ((ms % 1000) + 1000) % 1000,
  );
  return reading.getTime();
}

/**
 * The day a focus block belongs to. Blocks started after midnight but before
 * `dayStartHour` count toward the previous day, so a 1am push still shows up
 * on the day it felt like. The hour is the one on the clock: on a night the
 * clocks change, that many hours after midnight is an hour away from it, and
 * the day still turns over when the clock says so. The day is written the way
 * localDay writes one.
 */
export function focusDay(iso: string | Date, tz: string, dayStartHour: number): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return localDay(wallClock(d.getTime(), tz) - dayStartHour * 3_600_000, 'UTC');
}
