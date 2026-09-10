import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { badRequest, handler, intParam, notFound, parse } from '../lib/http.js';
import { dayStartHour, tz } from '../lib/settings.js';
import {
  addInterruption,
  extendSession,
  getSessionRow,
  listSessions,
  liveSessionRow,
  logManualSession,
  overwriteActiveSeconds,
  pauseSession,
  resumeSession,
  startSession,
  stopSession,
  toView,
} from '../lib/sessions.js';
import { focusDay, nowIso } from '../lib/time.js';

export const sessionsRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const rating = z.number().int().min(1).max(5);

const startSchema = z.object({
  projectId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(300),
  intent: z.string().max(2000).nullish(),
  plannedMinutes: z.number().int().min(1).max(8 * 60).optional(),
  kind: z.enum(['focus', 'break']).optional(),
  planItemId: z.number().int().positive().nullish(),
  calendarEventId: z.string().max(300).nullish(),
});

const stopSchema = z.object({
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  title: z.string().trim().min(1).max(300).optional(),
  projectId: z.number().int().positive().nullish(),
  activeSeconds: z.number().int().min(0).max(24 * 3600).optional(),
});

const manualSchema = z.object({
  projectId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(300),
  startedAt: z.string().datetime({ offset: true }),
  minutes: z.number().min(1).max(12 * 60),
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  kind: z.enum(['focus', 'break']).optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  projectId: z.number().int().positive().nullish(),
  intent: z.string().max(2000).nullish(),
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  interruptions: z.number().int().min(0).max(999).optional(),
  activeSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  plannedMinutes: z.number().int().min(1).max(8 * 60).optional(),
});

/** The block currently on the clock, if any. */
sessionsRouter.get(
  '/active',
  handler(() => {
    const row = liveSessionRow();
    return { session: row ? toView(row) : null };
  }),
);

sessionsRouter.get(
  '/',
  handler((req) => {
    const q = req.query as Record<string, string | undefined>;
    for (const key of ['day', 'from', 'to'] as const) {
      if (q[key] && !DAY.test(q[key] as string)) throw badRequest(`${key} must be YYYY-MM-DD`);
    }
    return listSessions({
      day: q.day,
      from: q.from,
      to: q.to,
      projectId: q.projectId ? Number(q.projectId) : undefined,
      kind: q.kind === 'break' || q.kind === 'focus' ? q.kind : undefined,
      limit: q.limit ? Math.min(2000, Number(q.limit)) : undefined,
    });
  }),
);

sessionsRouter.post(
  '/',
  handler((req, res) => {
    const body = parse(startSchema, req.body);
    res.status(201);
    return startSession(body);
  }),
);

sessionsRouter.post(
  '/manual',
  handler((req, res) => {
    const body = parse(manualSchema, req.body);
    res.status(201);
    return logManualSession(body);
  }),
);

sessionsRouter.get(
  '/:id',
  handler((req) => toView(getSessionRow(intParam(req.params.id, 'session id')))),
);

sessionsRouter.post(
  '/:id/pause',
  handler((req) => pauseSession(intParam(req.params.id, 'session id'))),
);

sessionsRouter.post(
  '/:id/resume',
  handler((req) => resumeSession(intParam(req.params.id, 'session id'))),
);

sessionsRouter.post(
  '/:id/interruption',
  handler((req) => {
    const delta = parse(z.object({ delta: z.number().int().min(-10).max(10).optional() }), req.body ?? {});
    return addInterruption(intParam(req.params.id, 'session id'), delta.delta ?? 1);
  }),
);

sessionsRouter.post(
  '/:id/extend',
  handler((req) => {
    const body = parse(z.object({ minutes: z.number().int().min(-120).max(240) }), req.body);
    return extendSession(intParam(req.params.id, 'session id'), body.minutes);
  }),
);

sessionsRouter.post(
  '/:id/complete',
  handler((req) =>
    stopSession(intParam(req.params.id, 'session id'), 'completed', parse(stopSchema, req.body ?? {})),
  ),
);

sessionsRouter.post(
  '/:id/abandon',
  handler((req) =>
    stopSession(intParam(req.params.id, 'session id'), 'abandoned', parse(stopSchema, req.body ?? {})),
  ),
);

/** Edit a logged block after the fact — retitle it, reassign it, re-rate it. */
sessionsRouter.patch(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'session id');
    const body = parse(patchSchema, req.body);
    const row = getSessionRow(id);
    if (body.activeSeconds !== undefined) {
      if (row.status === 'running') {
        throw badRequest('Pause or stop the block before rewriting its elapsed time');
      }
      overwriteActiveSeconds(id, body.activeSeconds);
    }
    const map: Record<string, unknown> = {
      title: body.title,
      project_id: body.projectId,
      intent: body.intent,
      focus_rating: body.focusRating,
      notes: body.notes,
      interruptions: body.interruptions,
      planned_minutes: body.plannedMinutes,
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [col, val] of Object.entries(map)) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(val);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(nowIso(), id);
      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    return toView(getSessionRow(id));
  }),
);

/** Move a logged block to a different start time, keeping its length. */
sessionsRouter.post(
  '/:id/reschedule',
  handler((req) => {
    const id = intParam(req.params.id, 'session id');
    const { startedAt } = parse(
      z.object({ startedAt: z.string().datetime({ offset: true }) }),
      req.body,
    );
    const row = getSessionRow(id);
    if (row.status !== 'completed' && row.status !== 'abandoned') {
      throw badRequest('Only finished blocks can be rescheduled');
    }
    const endedAt = new Date(Date.parse(startedAt) + row.active_seconds * 1000).toISOString();
    db.transaction(() => {
      db.prepare(
        'UPDATE sessions SET started_at = ?, ended_at = ?, local_day = ?, updated_at = ? WHERE id = ?',
      ).run(startedAt, endedAt, focusDay(startedAt, tz(), dayStartHour()), nowIso(), id);
      db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(id);
      db.prepare(
        'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
      ).run(id, startedAt, endedAt);
    })();
    return toView(getSessionRow(id));
  }),
);

sessionsRouter.delete(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'session id');
    const info = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    if (!info.changes) throw notFound('Session');
    return { deleted: id };
  }),
);
