import { Router } from 'express';
import { z } from 'zod';
import { handler, parse } from '../lib/http.js';
import { allSettings, setSettings } from '../lib/settings.js';

export const settingsRouter = Router();

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
    day_start_hour: z.coerce.number().int().min(0).max(12),
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
    setSettings(body as Record<string, string | number | boolean>);
    const all = allSettings();
    return Object.fromEntries(Object.entries(all).filter(([k]) => !SECRET_KEYS.has(k)));
  }),
);
