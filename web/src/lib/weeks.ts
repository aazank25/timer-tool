import { addDays } from './format';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day from the address bar, or null. Anything that is not a real YYYY-MM-DD is dropped
 * here instead of being sent to the server to be refused: a stale or hand-typed link
 * should open on the default, not on an error. The pattern alone lets 2026-02-30 through,
 * so the day has to survive a round trip through Date, as it does on the server.
 */
export function realDay(value: string | null | undefined): string | null {
  if (!value || !DAY.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** 0 for Monday up to 6 for Sunday: weeks here begin on Monday. */
const sinceMonday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** The Monday of the week a day falls in, by the same rule as weekStart on the server. */
export function weekStart(day: string): string {
  return addDays(day, -sinceMonday(day));
}

/**
 * The week the review opens on, given the day the user is in. A review is of a week that
 * is over, and it gets done at the start of the next one, so on Monday and Tuesday, when
 * the week just finished is the one on your mind and the new one has barely begun (an
 * empty screen, on a Monday morning), it opens on last week. A review often slips a day,
 * which is why Tuesday counts. From Wednesday the current week has enough in it to be
 * worth looking at and last week has gone stale, so that is the one it opens on.
 */
export function defaultWeek(today: string): string {
  return addDays(weekStart(today), sinceMonday(today) <= 1 ? -7 : 0);
}
