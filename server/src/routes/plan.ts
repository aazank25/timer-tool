import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { badRequest, handler, intParam, notFound, parse } from '../lib/http.js';
import { nowIso } from '../lib/time.js';

export const planRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface PlanRow {
  id: number;
  plan_day: string;
  position: number;
  project_id: number | null;
  title: string;
  planned_minutes: number;
  calendar_event_id: string | null;
  session_id: number | null;
  done: number;
  project_name: string | null;
  project_color: string | null;
  actual_seconds: number | null;
  session_status: string | null;
}

const view = (r: PlanRow) => ({
  id: r.id,
  day: r.plan_day,
  position: r.position,
  projectId: r.project_id,
  projectName: r.project_name,
  projectColor: r.project_color,
  title: r.title,
  plannedMinutes: r.planned_minutes,
  calendarEventId: r.calendar_event_id,
  sessionId: r.session_id,
  sessionStatus: r.session_status,
  actualSeconds: r.actual_seconds ?? 0,
  done: !!r.done,
});

const SELECT = `
  SELECT i.*, p.name AS project_name, p.color AS project_color,
         s.active_seconds AS actual_seconds, s.status AS session_status
  FROM plan_items i
  LEFT JOIN projects p ON p.id = i.project_id
  LEFT JOIN sessions s ON s.id = i.session_id`;

function get(id: number): PlanRow {
  const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as PlanRow | undefined;
  if (!row) throw notFound('Plan item');
  return row;
}

const createSchema = z.object({
  day: z.string().regex(DAY),
  title: z.string().trim().min(1).max(300),
  projectId: z.number().int().positive().nullish(),
  plannedMinutes: z.number().int().min(1).max(8 * 60).optional(),
  calendarEventId: z.string().max(300).nullish(),
});

planRouter.get(
  '/',
  handler((req) => {
    const day = String(req.query.day ?? '');
    if (!DAY.test(day)) throw badRequest('day must be YYYY-MM-DD');
    const rows = db
      .prepare(`${SELECT} WHERE i.plan_day = ? ORDER BY i.position ASC, i.id ASC`)
      .all(day) as PlanRow[];
    return rows.map(view);
  }),
);

planRouter.post(
  '/',
  handler((req, res) => {
    const body = parse(createSchema, req.body);
    const now = nowIso();
    const next = db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM plan_items WHERE plan_day = ?')
      .get(body.day) as { pos: number };
    const info = db
      .prepare(
        `INSERT INTO plan_items
           (plan_day, position, project_id, title, planned_minutes, calendar_event_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.day,
        next.pos,
        body.projectId ?? null,
        body.title,
        body.plannedMinutes ?? 45,
        body.calendarEventId ?? null,
        now,
        now,
      );
    res.status(201);
    return view(get(Number(info.lastInsertRowid)));
  }),
);

planRouter.patch(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'plan item id');
    const body = parse(
      createSchema.partial().extend({ done: z.boolean().optional() }),
      req.body,
    );
    get(id);
    const map: Record<string, unknown> = {
      plan_day: body.day,
      title: body.title,
      project_id: body.projectId,
      planned_minutes: body.plannedMinutes,
      calendar_event_id: body.calendarEventId,
      done: body.done === undefined ? undefined : body.done ? 1 : 0,
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
      db.prepare(`UPDATE plan_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    return view(get(id));
  }),
);

planRouter.post(
  '/reorder',
  handler((req) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).max(200) }), req.body);
    const stmt = db.prepare('UPDATE plan_items SET position = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    db.transaction(() => ids.forEach((id, i) => stmt.run(i, now, id)))();
    return { reordered: ids.length };
  }),
);

planRouter.delete(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'plan item id');
    const info = db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
    if (!info.changes) throw notFound('Plan item');
    return { deleted: id };
  }),
);
