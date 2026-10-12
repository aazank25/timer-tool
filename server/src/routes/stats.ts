import { Router } from 'express';
import { badRequest, handler } from '../lib/http.js';
import { dayStartHour, today, tz } from '../lib/settings.js';
import {
  dayStats,
  estimateStats,
  interruptionStats,
  rangeStats,
  trailing,
} from '../lib/stats.js';

export const statsRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const s = String(value);
  if (!DAY.test(s)) throw badRequest('day must be YYYY-MM-DD');
  return s;
}

statsRouter.get(
  '/today',
  handler(() => ({ today: today(), timezone: tz(), dayStartHour: dayStartHour() })),
);

statsRouter.get(
  '/day',
  handler((req) => dayStats(requireDay(req.query.day, today()))),
);

statsRouter.get(
  '/range',
  handler((req) => {
    const to = requireDay(req.query.to, today());
    const days = req.query.days ? Number(req.query.days) : undefined;
    const from =
      req.query.from !== undefined
        ? requireDay(req.query.from, to)
        : trailing(to, Number.isFinite(days) && days ? Math.min(370, Math.max(1, days)) : 7).from;
    if (from > to) throw badRequest('from must not be after to');
    return rangeStats(from, to);
  }),
);

/**
 * A day that is on the calendar. The pattern alone lets 2026-02-30 through, and Date reads
 * it as March 2nd, so a window that named it would quietly be a different one.
 */
function requireRealDay(name: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const s = String(value);
  if (!DAY.test(s)) throw badRequest(`${name} must be YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${name} must be a real date`);
  }
  return s;
}

/**
 * The days a request asks about, asked for as /range is: `to` is today unless it is given,
 * `from` is `defaultDays` back from it (counting `to`) unless it is given, and `from` may
 * not be after `to`.
 */
function requireWindow(query: { from?: unknown; to?: unknown }, defaultDays: number) {
  const to = requireRealDay('to', query.to, today());
  const from =
    query.from === undefined
      ? trailing(to, defaultDays).from
      : requireRealDay('from', query.from, to);
  if (from > to) throw badRequest('from must not be after to');
  return { from, to };
}

/** What pulled you away from your focus blocks, by reason. The last 7 days unless told otherwise. */
statsRouter.get(
  '/interruptions',
  handler((req) => {
    const { from, to } = requireWindow(req.query, 7);
    return interruptionStats(from, to);
  }),
);

/** Your estimates against what the work took. The last 90 days unless told otherwise. */
statsRouter.get(
  '/estimates',
  handler((req) => {
    const { from, to } = requireWindow(req.query, 90);
    return estimateStats(from, to);
  }),
);
