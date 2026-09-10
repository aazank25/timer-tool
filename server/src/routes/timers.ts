import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { handler, intParam, notFound, parse } from '../lib/http.js';
import { nowIso } from '../lib/time.js';

export const timersRouter = Router();

export interface TimerView {
  /** Present only for a pinned timer; derived suggestions have none. */
  id: number | null;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  plannedMinutes: number | null;
  pinned: boolean;
  useCount: number;
  totalSeconds: number;
  lastUsedAt: string | null;
}

const key = (projectId: number | null, title: string) => `${projectId ?? 'none'}::${title}`;

/**
 * One-click starting points. Pinned timers come first, then the project+title
 * pairs you actually keep returning to — so the list is useful on day two
 * without anyone curating it.
 */
function listTimers(limit: number): TimerView[] {
  const pinned = db
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.planned_minutes, t.position,
              p.name AS project_name, p.color AS project_color
       FROM saved_timers t LEFT JOIN projects p ON p.id = t.project_id
       ORDER BY t.position ASC, t.id ASC`,
    )
    .all() as {
    id: number;
    project_id: number | null;
    title: string;
    planned_minutes: number | null;
    project_name: string | null;
    project_color: string | null;
  }[];

  // History, grouped by the pair. Abandoned blocks are poor suggestions.
  const history = db
    .prepare(
      `SELECT s.project_id, s.title,
              COUNT(*)                        AS use_count,
              SUM(s.active_seconds)           AS total_seconds,
              MAX(s.started_at)               AS last_used_at,
              CAST(ROUND(AVG(s.planned_minutes)) AS INTEGER) AS planned_minutes,
              p.name AS project_name, p.color AS project_color
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.kind = 'focus' AND s.status = 'completed'
       GROUP BY s.project_id, s.title
       ORDER BY use_count DESC, last_used_at DESC
       LIMIT ?`,
    )
    .all(limit * 3) as {
    project_id: number | null;
    title: string;
    use_count: number;
    total_seconds: number | null;
    last_used_at: string | null;
    planned_minutes: number | null;
    project_name: string | null;
    project_color: string | null;
  }[];

  const stats = new Map(history.map((h) => [key(h.project_id, h.title), h]));
  const out: TimerView[] = [];

  for (const t of pinned) {
    const s = stats.get(key(t.project_id, t.title));
    out.push({
      id: t.id,
      projectId: t.project_id,
      projectName: t.project_name,
      projectColor: t.project_color,
      title: t.title,
      plannedMinutes: t.planned_minutes ?? s?.planned_minutes ?? null,
      pinned: true,
      useCount: s?.use_count ?? 0,
      totalSeconds: s?.total_seconds ?? 0,
      lastUsedAt: s?.last_used_at ?? null,
    });
  }

  const pinnedKeys = new Set(pinned.map((t) => key(t.project_id, t.title)));
  for (const h of history) {
    if (out.length >= limit) break;
    if (pinnedKeys.has(key(h.project_id, h.title))) continue;
    out.push({
      id: null,
      projectId: h.project_id,
      projectName: h.project_name,
      projectColor: h.project_color,
      title: h.title,
      plannedMinutes: h.planned_minutes,
      pinned: false,
      useCount: h.use_count,
      totalSeconds: h.total_seconds ?? 0,
      lastUsedAt: h.last_used_at,
    });
  }
  return out;
}

timersRouter.get(
  '/',
  handler((req) => {
    const limit = req.query.limit ? Math.min(60, Math.max(1, Number(req.query.limit))) : 18;
    return listTimers(limit);
  }),
);

timersRouter.post(
  '/',
  handler((req, res) => {
    const body = parse(
      z.object({
        projectId: z.number().int().positive().nullish(),
        title: z.string().trim().min(1).max(300),
        plannedMinutes: z.number().int().min(1).max(480).nullish(),
      }),
      req.body,
    );
    db.prepare(
      `INSERT INTO saved_timers (project_id, title, planned_minutes, position, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM saved_timers), ?)
       ON CONFLICT DO NOTHING`,
    ).run(body.projectId ?? null, body.title, body.plannedMinutes ?? null, nowIso());
    res.status(201);
    return listTimers(18);
  }),
);

timersRouter.delete(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'timer id');
    const info = db.prepare('DELETE FROM saved_timers WHERE id = ?').run(id);
    if (!info.changes) throw notFound('Saved timer');
    return listTimers(18);
  }),
);
