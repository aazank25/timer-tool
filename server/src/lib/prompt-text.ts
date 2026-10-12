import { tz } from './settings.js';

/** A length as a sentence has it: "40 min", "2 h", "1 h 20 min". Never less than a minute. */
export function minutesPhrase(seconds: number): string {
  const total = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The same length as a button has it: "45m", "2h", "1h 30m". */
export function minutesShort(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

type Way = 'time' | 'day' | 'dayAndTime' | 'dayKey';

/** The machine's own style for the way asked for. The day key is en-CA, which writes YYYY-MM-DD. */
function build(way: Way, timeZone: string): Intl.DateTimeFormat {
  const day = { weekday: 'short', month: 'short', day: 'numeric' } as const;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  switch (way) {
    case 'time':
      return new Intl.DateTimeFormat(undefined, { ...time, timeZone });
    case 'day':
      return new Intl.DateTimeFormat(undefined, { ...day, timeZone });
    case 'dayAndTime':
      return new Intl.DateTimeFormat(undefined, { ...day, ...time, timeZone });
    case 'dayKey':
      return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone,
      });
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Building a formatter costs far more than using one (it was most of the time a list of a
 * thousand prompts took), so each way of writing a time in each timezone is built once.
 */
function formatter(way: Way, timeZone: string): Intl.DateTimeFormat {
  const key = `${way}|${timeZone}`;
  let found = formatters.get(key);
  if (!found) {
    found = build(way, timeZone);
    formatters.set(key, found);
  }
  return found;
}

/** The time of day an instant falls at, in the person's own timezone and the machine's own style. */
export function clockTime(iso: string): string {
  return formatter('time', tz()).format(new Date(iso));
}

/** How a list of prompts writes the times in it. */
export interface Clock {
  /**
   * A stretch of time. A stretch inside today is "10:10 AM to 10:50 AM"; inside another day
   * it names the day once ("Sat, Oct 10, 10:10 AM to 10:50 AM"), and one that crosses
   * midnight names both, so that "12:00 PM to 12:00 PM" is never all there is to read.
   */
  range(startIso: string, endIso: string): string;
}

/**
 * The clock for one list of prompts, as of `now`. The timezone is read from the settings once
 * here, not once for every time written.
 */
export function clockFor(now: Date): Clock {
  const zone = tz();
  const time = formatter('time', zone);
  const day = formatter('day', zone);
  const dayAndTime = formatter('dayAndTime', zone);
  const dayKey = formatter('dayKey', zone);
  const today = dayKey.format(now);

  return {
    range(startIso, endIso) {
      const start = new Date(startIso);
      const end = new Date(endIso);
      const startDay = dayKey.format(start);
      if (startDay !== dayKey.format(end)) {
        return `${dayAndTime.format(start)} to ${dayAndTime.format(end)}`;
      }
      const within = `${time.format(start)} to ${time.format(end)}`;
      return startDay === today ? within : `${day.format(start)}, ${within}`;
    },
  };
}

/** A block's or meeting's name set inside curly quotes, the way the prompts quote it. */
export const quoted = (title: string): string => `“${title}”`;
