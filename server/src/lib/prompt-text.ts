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

/** The time of day an instant falls at, in the person's own timezone and the machine's own style. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz(),
  });
}

/** A block's or meeting's name set inside curly quotes, the way the prompts quote it. */
export const quoted = (title: string): string => `“${title}”`;
