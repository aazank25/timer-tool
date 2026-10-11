import { Router } from 'express';
import { badRequest, handler } from '../lib/http.js';
import { dayStartHour, today, tz } from '../lib/settings.js';
import { dayStats, rangeStats, trailing } from '../lib/stats.js';

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
