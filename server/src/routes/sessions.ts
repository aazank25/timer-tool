import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { reportAway } from '../lib/away.js';
import { MAX_EVENT_ID_LENGTH } from '../lib/calendar.js';
import { badRequest, handler, intParam, notFound, parse } from '../lib/http.js';
import { INTERRUPTION_REASON_KEYS } from '../lib/interruptions.js';
import { dayStartHour, tz } from '../lib/settings.js';
import {
  addInterruption,
  extendSession,
  getSessionRow,
  keepPendingAway,
  listSessions,
  liveSessionRow,
  logManualSession,
  overwriteActiveSeconds,
  pauseSession,
  resumeSession,
  startSession,
  stopSession,
  switchSession,
  toView,
  trimInterruptionRows,
} from '../lib/sessions.js';
import { requireProject, requireTask, startTaskForLinkedBlock } from '../lib/tasks.js';
import { focusDay, nowIso } from '../lib/time.js';

export const sessionsRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * How many blocks to list: a whole number, held to 1 to 2000 when it is outside them. A word or a
 * fraction is refused, since it is not a number of rows SQLite can be given. A negative one is
 * raised to 1 and never passed on: it is no limit there at all, so -1 would list every block there
 * is.
 */
const listLimit = z.coerce
  .number()
  .int()
  .transform((limit) => Math.min(2000, Math.max(1, limit)));
const rating = z.number().int().min(1).max(5);
/** A guess, not a plan: it is shown next to the actual and never counted. */
const estimate = z.number().int().min(1).max(8 * 60).nullish();

const startSchema = z.object({
  projectId: z.number().int().positive().nullish(),
  taskId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(300),
  intent: z.string().max(2000).nullish(),
  mode: z.enum(['stopwatch', 'pomodoro']).optional(),
  plannedMinutes: z.number().int().min(1).max(8 * 60).optional(),
  estimatedMinutes: estimate,
  kind: z.enum(['focus', 'break']).optional(),
  planItemId: z.number().int().positive().nullish(),
  calendarEventId: z.string().max(MAX_EVENT_ID_LENGTH).nullish(),
});

/** The block to start is the start body itself, so the two can never disagree about what one is. */
const switchSchema = z.object({
  start: startSchema,
  rating: rating.nullish(),
});

const stopSchema = z.object({
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  title: z.string().trim().min(1).max(300).optional(),
  projectId: z.number().int().positive().nullish(),
  // At least a second: zero would log an empty block and collapse its segments
  // into a zero-length span.
  activeSeconds: z.number().int().min(1).max(24 * 3600).optional(),
});

const manualSchema = z.object({
  projectId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(300),
  startedAt: z.string().datetime({ offset: true }),
  minutes: z.number().min(1).max(12 * 60),
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  kind: z.enum(['focus', 'break']).optional(),
  // The meeting this is the time spent on. It has to exist, and not be logged already;
  // logManualSession checks.
  calendarEventId: z.string().max(MAX_EVENT_ID_LENGTH).nullish(),
});

const awaySchema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  projectId: z.number().int().positive().nullish(),
  // Null unlinks the block from its task.
  taskId: z.number().int().positive().nullish(),
  intent: z.string().max(2000).nullish(),
  focusRating: rating.nullish(),
  notes: z.string().max(20_000).nullish(),
  interruptions: z.number().int().min(0).max(999).optional(),
  activeSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  plannedMinutes: z.number().int().min(1).max(8 * 60).optional(),
  estimatedMinutes: estimate,
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
      limit: q.limit ? parse(listLimit, q.limit) : undefined,
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

/**
 * Finish the block on the clock (rated, if a rating is sent) and start another, in one
 * request: what the quick-switch box does. A start that is refused changes nothing, the
 * block on the clock included.
 */
sessionsRouter.post(
  '/switch',
  handler((req, res) => {
    const body = parse(switchSchema, req.body);
    res.status(201);
    return switchSession(body);
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

/**
 * The desktop app reports time you were away while this block ran. It is kept as a prompt
 * until you keep it or drop it (see lib/away.ts), not decided here. A report with nothing
 * new in it, because the stretch was kept or dropped already, holds nothing: 200 and
 * `{ away: null }` rather than 201 and the stretch.
 */
sessionsRouter.post(
  '/:id/away',
  handler((req, res) => {
    const body = parse(awaySchema, req.body);
    const away = reportAway(intParam(req.params.id, 'session id'), body.startedAt, body.endedAt);
    res.status(away ? 201 : 200);
    return { away };
  }),
);

sessionsRouter.post(
  '/:id/interruption',
  handler((req) => {
    const body = parse(
      z.object({
        delta: z.number().int().min(-10).max(10).optional(),
        // One of the fixed reasons, or left out for an interruption with no reason given.
        reason: z.enum(INTERRUPTION_REASON_KEYS).optional(),
      }),
      req.body ?? {},
    );
    return addInterruption(intParam(req.params.id, 'session id'), body.delta ?? 1, body.reason);
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

/**
 * Edit a logged block after the fact — retitle it, reassign it, re-rate it, or link it
 * to the task it was the work on, which moves that task along (startTaskForLinkedBlock).
 */
sessionsRouter.patch(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'session id');
    const body = parse(patchSchema, req.body);
    const row = getSessionRow(id);
    // Giving a stopwatch a plan here would quietly turn it into a fixed-length
    // block. Checked before anything is written so a bad request changes nothing.
    if (row.planned_minutes == null && body.plannedMinutes !== undefined) {
      throw badRequest('Stopwatch blocks have no planned length to change');
    }
    if (body.activeSeconds !== undefined && row.status === 'running') {
      throw badRequest('Pause or stop the block before rewriting its elapsed time');
    }
    const map: Record<string, unknown> = {
      title: body.title,
      project_id: body.projectId,
      task_id: body.taskId,
      intent: body.intent,
      focus_rating: body.focusRating,
      notes: body.notes,
      interruptions: body.interruptions,
      planned_minutes: body.plannedMinutes,
      estimated_minutes: body.estimatedMinutes,
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [col, val] of Object.entries(map)) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(val);
    }
    // One transaction, so a request that fails partway cannot leave the block with
    // its time rewritten and nothing else, or linked to a task that was not moved
    // along with it. A project or task that is not there is refused first, ahead of
    // the first write, as a 400 rather than a foreign-key 500.
    db.transaction(() => {
      if (body.projectId != null) requireProject(body.projectId);
      if (body.taskId != null) requireTask(body.taskId);
      if (body.activeSeconds !== undefined) overwriteActiveSeconds(id, body.activeSeconds);
      startTaskForLinkedBlock(row, body.taskId);
      if (sets.length) {
        sets.push('updated_at = ?');
        args.push(nowIso(), id);
        db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      }
      // The rows of interruptions follow the count down, in the same transaction as it.
      if (body.interruptions !== undefined) trimInterruptionRows(id, body.interruptions);
    })();
    return toView(getSessionRow(id));
  }),
);

/** Move a logged block to a different start time, keeping its length. */
sessionsRouter.post(
  '/:id/reschedule',
  handler((req) => {
    const id = intParam(req.params.id, 'session id');
    const body = parse(
      z.object({ startedAt: z.string().datetime({ offset: true }) }),
      req.body,
    );
    const row = getSessionRow(id);
    if (row.status !== 'completed' && row.status !== 'abandoned') {
      throw badRequest('Only finished blocks can be rescheduled');
    }
    // Stored as the instant it names, in UTC to the millisecond, as a block logged by hand is,
    // so that it sorts by when it was and not by the digits it was given in.
    const startedAt = new Date(Date.parse(body.startedAt)).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + row.active_seconds * 1000).toISOString();
    db.transaction(() => {
      const now = nowIso();
      db.prepare(
        'UPDATE sessions SET started_at = ?, ended_at = ?, local_day = ?, updated_at = ? WHERE id = ?',
      ).run(startedAt, endedAt, focusDay(startedAt, tz(), dayStartHour()), now, id);
      db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(id);
      db.prepare(
        'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
      ).run(id, startedAt, endedAt);
      // Moved to the time it really was: the stretches reported against where it stood
      // before no longer line up with it, and the person has said where it belongs.
      keepPendingAway(id, now);
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
