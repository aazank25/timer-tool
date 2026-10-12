import { Router } from 'express';
import { z } from 'zod';
import { normalizeAccelerator, usedByApp } from '../lib/accelerator.js';
import { badRequest, handler, parse } from '../lib/http.js';
import { allSettings, getSetting, setSettings } from '../lib/settings.js';

export const settingsRouter = Router();

/**
 * '' turns the shortcut off. Anything else has to be a combination Electron will read as it
 * was typed, and is kept in the one spelling normalizeAccelerator gives it. Refused here, not
 * left to the app that registers it: Electron drops a name it does not know and registers
 * what is left, so a typo would go on to grab some other key in every app. FocusDesk's own
 * shortcuts are refused here too. The app would turn them down at registration, but by then
 * the setting is saved, and the next start would find a shortcut it cannot register.
 */
const hotkey = z
  .string()
  .max(80)
  .transform((value, ctx) => {
    // Only spaces are blank. trim() would also take a no-break space, which is not what
    // anyone means by "off".
    if (/^ *$/.test(value)) return '';
    const accelerator = normalizeAccelerator(value);
    if (accelerator === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Use one key with at least one of Command, Control, CommandOrControl or Super, joined with +, like CommandOrControl+Alt+K (F1–F24 may use Shift or Alt alone), or leave it empty to turn the shortcut off',
      });
      return z.NEVER;
    }
    const purpose = usedByApp(accelerator);
    if (purpose !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${accelerator} is already the shortcut FocusDesk uses to ${purpose}. Pick a different one`,
      });
      return z.NEVER;
    }
    return accelerator;
  });

/**
 * Whole minutes from 0 (off) up to `max`. An empty string would coerce to 0 and quietly
 * switch the feature off, so it is refused rather than read as a choice.
 */
const offOrMinutes = (max: number) =>
  z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().int().min(0).max(max));

/** Weekdays by ISO number, 1 = Monday to 7 = Sunday, each at most once. Empty is no work days. */
const workDays = z.string().refine((list) => {
  if (list === '') return true;
  const days = list.split(',');
  return days.every((d) => /^[1-7]$/.test(d)) && new Set(days).size === days.length;
}, 'Use each weekday once, as a number from 1 (Monday) to 7 (Sunday), separated by commas');

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, on a 24-hour clock');

/** Values are stored as strings; keys not listed here are rejected. */
const schema = z
  .object({
    timezone: z.string().min(1).max(80),
    focus_minutes: z.coerce.number().int().min(1).max(480),
    short_break_minutes: z.coerce.number().int().min(1).max(120),
    long_break_minutes: z.coerce.number().int().min(1).max(240),
    blocks_before_long_break: z.coerce.number().int().min(1).max(12),
    daily_target_minutes: z.coerce.number().int().min(0).max(1440),
    autostart_breaks: z.union([z.boolean(), z.enum(['true', 'false'])]),
    default_timer_mode: z.enum(['stopwatch', 'pomodoro']),
    quick_switch_hotkey: hotkey,
    day_start_hour: z.coerce.number().int().min(0).max(12),
    // A 24-hour HH:MM with both parts two digits, or '' for "no reminder".
    wrapup_time: z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]),
    away_minutes: offOrMinutes(240),
    long_block_minutes: offOrMinutes(720),
    meeting_prompts: z.union([z.boolean(), z.enum(['true', 'false'])]),
    work_days: workDays,
    work_start: clockTime,
    work_end: clockTime,
    nudge_minutes: offOrMinutes(240),
    close_behavior: z.enum(['ask', 'menu-bar', 'quit']),
  })
  .partial();

const SECRET_KEYS = new Set(['calendar_sources']);

settingsRouter.get(
  '/',
  handler(() => {
    const all = allSettings();
    // Calendar feed URLs are secrets; they are managed through /api/calendar.
    return Object.fromEntries(Object.entries(all).filter(([k]) => !SECRET_KEYS.has(k)));
  }),
);

settingsRouter.patch(
  '/',
  handler((req) => {
    const body = parse(schema, req.body);
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: body.timezone }).format(new Date());
      } catch {
        throw new Error(`Unknown timezone: ${body.timezone}`);
      }
    }
    // Each of the two is fine alone and wrong together, and a patch may name only one of
    // them, so the other is read from what is stored. Refused before anything is written.
    if (body.work_start !== undefined || body.work_end !== undefined) {
      const start = body.work_start ?? getSetting('work_start') ?? '';
      const end = body.work_end ?? getSetting('work_end') ?? '';
      if (end <= start) throw badRequest('Work hours must end after they start');
    }
    setSettings(body as Record<string, string | number | boolean>);
    const all = allSettings();
    return Object.fromEntries(Object.entries(all).filter(([k]) => !SECRET_KEYS.has(k)));
  }),
);
