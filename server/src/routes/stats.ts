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

statsRouter.get(
  '/today',
  handler(() => ({ today: today(), timezone: tz(), dayStartHour: dayStartHour() })),
);

statsRouter.get(
  '/day',
  handler((req) => dayStats(requireRealDay('day', req.query.day, today()))),
);

/**
 * The most days /range answers for at once: a year, and a few days over so that a year back from
 * any day fits. Every day of a window is worked out one by one, on the one thread the server
 * has, so a window of centuries would hold up every other request for as long as it took.
 */
const MAX_RANGE_DAYS = 370;

/**
 * How far back from `to` a window without a `from` goes: 7 days unless asked, at least one, and
 * no more than the most /range answers for. 0 is not asking, and is the 7 it has always been.
 */
function requireDays(value: unknown): number {
  if (value === undefined || value === '') return 7;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw badRequest('days must be a whole number');
  }
  const days = Number(value);
  if (days === 0) return 7;
  return Math.min(MAX_RANGE_DAYS, Math.max(1, days));
}

statsRouter.get(
  '/range',
  handler((req) => {
    const to = requireRealDay('to', req.query.to, today());
    const days = requireDays(req.query.days);
    const from =
      req.query.from !== undefined
        ? requireRealDay('from', req.query.from, to)
        : trailing(to, days).from;
    if (!DAY.test(from)) throw badRequest('That window starts before the year 0000');
    if (from > to) throw badRequest('from must not be after to');
    // Counted from the two dates, before any day of the window is looked at.
    const span =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (span > MAX_RANGE_DAYS) throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at once`);
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
