import { Router } from 'express';
import { z } from 'zod';
import { handler, parse } from '../lib/http.js';
import { today } from '../lib/settings.js';
import {
  dayView,
  finishDay,
  finishWeek,
  setDayNote,
  setWeekNote,
  weekView,
} from '../lib/wrapup.js';

export const wrapupRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The pattern alone lets 2026-02-30 through, and it would be filed under a day that is
 * really March 2nd. A day has to survive a round trip through Date to count.
 */
function isRealDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Weeks are asked for by any day in them, so a week parameter is read as a day too. */
const day = z.string().regex(DAY, 'must be YYYY-MM-DD').refine(isRealDay, 'must be a real date');

const dayQuery = z.object({ day: day.optional() });
const weekQuery = z.object({ week: day.optional() });

// Always named, so a body with no `note` is refused instead of clearing the one that is
// there. Null, or text that is blank once trimmed, clears it.
const noteBody = z.object({ note: z.string().trim().max(500).nullable() });

/* ---------------------------------------------------------------------- day */

wrapupRouter.get(
  '/day',
  handler((req) => dayView(parse(dayQuery, req.query).day ?? today())),
);

wrapupRouter.put(
  '/day/:day',
  handler((req) => {
    const key = parse(day, req.params.day);
    return setDayNote(key, parse(noteBody, req.body).note);
  }),
);

wrapupRouter.post(
  '/day/:day/done',
  handler((req) => finishDay(parse(day, req.params.day))),
);

/* --------------------------------------------------------------------- week */

wrapupRouter.get(
  '/week',
  handler((req) => weekView(parse(weekQuery, req.query).week ?? today())),
);

wrapupRouter.put(
  '/week/:week',
  handler((req) => {
    const key = parse(day, req.params.week);
    return setWeekNote(key, parse(noteBody, req.body).note);
  }),
);

wrapupRouter.post(
  '/week/:week/done',
  handler((req) => finishWeek(parse(day, req.params.week))),
);
