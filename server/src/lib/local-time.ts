/**
 * The way back from time.ts. That file says which day an instant falls on in the user's
 * timezone; a reminder has to go the other way, because "17:30 on the 12th, where I am" is
 * a moment, and not the same one in Tokyo as in New York or the same distance from midnight
 * UTC on either side of a clock change. Nothing here knows an offset: the zone's own rules
 * are asked, through Intl, about the instant in question.
 */

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone: making them is the slow part, and a poll asks a few times over. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      // h23, so that midnight is 00 and not 24.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, found);
  }
  return found;
}

/** How far ahead of UTC the zone's clocks are at an instant, in milliseconds. */
function offsetAt(ms: number, zone: string): number {
  const shown: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(ms)) shown[part.type] = part.value;
  const asIfUtc = Date.UTC(
    Number(shown.year),
    Number(shown.month) - 1,
    Number(shown.day),
    Number(shown.hour),
    Number(shown.minute),
    Number(shown.second),
  );
  // The reading has whole seconds only, so the instant is cut to match before they are compared.
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant, as epoch milliseconds, at which the clocks of `zone` read `time` ("HH:MM")
 * on the calendar day `day` ("YYYY-MM-DD").
 *
 * A clock change makes that ambiguous twice a year, and the answer is the one `Date` gives:
 * a time that happens twice (the hour clocks go back over) is its first occurrence, and a
 * time that never happens (the hour they skip) is read with the offset from before the
 * change, which lands it just after the gap. Nothing is ever left out and nothing is picked
 * at random, so a reminder set for 02:30 still comes, on the one night of the year it has
 * no 02:30 to come at.
 */
export function instantAt(day: string, time: string, zone: string): number {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  // The reading as if the zone were UTC. The real instant is never more than 14 hours from it.
  const reading = Date.UTC(year!, month! - 1, date!, hour!, minute!);

  // The zone's offset a day either side of it. They differ only when a clock change falls
  // between, and a day is further than the reach of any one of them.
  const before = offsetAt(reading - DAY_MS, zone);
  const after = offsetAt(reading + DAY_MS, zone);
  if (before === after) return reading - before;

  // Each offset gives a candidate, and a candidate is real only if the zone really is on
  // that offset at that instant.
  const early = reading - before;
  const late = reading - after;
  if (offsetAt(early, zone) === before) return early;
  if (offsetAt(late, zone) === after) return late;
  return early;
}

/** The ISO weekday of a plain day, 1 for Monday up to 7 for Sunday: how `work_days` counts. */
export function isoWeekday(day: string): number {
  return ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** An `HH:MM` setting, or null if it is blank or not a time: a reminder keyed to it is off. */
export function clockSetting(value: string | undefined): string | null {
  return value !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}
