import { Router } from 'express';
import { z } from 'zod';
import {
  addSource,
  assignEventProject,
  defaultWindow,
  listEvents,
  readSources,
  redact,
  removeSource,
  syncCalendars,
  updateSource,
} from '../lib/calendar.js';
import { badRequest, handler, parse } from '../lib/http.js';
import { getSetting } from '../lib/settings.js';
import { today } from './stats.js';

export const calendarRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const s = String(value);
  if (!DAY.test(s)) throw badRequest('day must be YYYY-MM-DD');
  return s;
}

calendarRouter.get(
  '/sources',
  handler(() => ({
    sources: readSources().map(redact),
    lastSyncedAt: getSetting('calendar_last_sync') ?? null,
  })),
);

calendarRouter.post(
  '/sources',
  handler((req, res) => {
    const body = parse(
      z.object({ label: z.string().trim().min(1).max(80), url: z.string().min(8).max(2000) }),
      req.body,
    );
    res.status(201);
    return addSource(body.label, body.url);
  }),
);

calendarRouter.patch(
  '/sources/:id',
  handler((req) => {
    const body = parse(
      z.object({
        label: z.string().trim().min(1).max(80).optional(),
        url: z.string().min(8).max(2000).optional(),
        enabled: z.boolean().optional(),
      }),
      req.body,
    );
    return updateSource(String(req.params.id), body);
  }),
);

calendarRouter.delete(
  '/sources/:id',
  handler((req) => {
    removeSource(String(req.params.id));
    return { deleted: String(req.params.id) };
  }),
);

calendarRouter.post(
  '/sync',
  handler(async () => {
    const results = await syncCalendars();
    return { results, syncedAt: new Date().toISOString() };
  }),
);

calendarRouter.get(
  '/events',
  handler((req) => {
    const anchor = today();
    if (req.query.day !== undefined) {
      const d = day(req.query.day, anchor);
      return listEvents(d, d);
    }
    const window = defaultWindow(anchor);
    return listEvents(day(req.query.from, window.from), day(req.query.to, window.to));
  }),
);

calendarRouter.patch(
  '/events/:id',
  handler((req) => {
    const body = parse(
      z.object({ projectId: z.number().int().positive().nullable() }),
      req.body,
    );
    return assignEventProject(String(req.params.id), body.projectId);
  }),
);
