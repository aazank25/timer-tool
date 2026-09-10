import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { handler, intParam, notFound, parse } from '../lib/http.js';
import { nowIso } from '../lib/time.js';

export const projectsRouter = Router();

const HEX = /^#[0-9a-fA-F]{6}$/;

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().regex(HEX, 'color must be a #rrggbb hex string').optional(),
  description: z.string().max(2000).nullish(),
  weeklyTargetMinutes: z.number().int().min(0).max(100 * 60).nullish(),
  notionUrl: z.string().url().max(2000).nullish(),
});
const patchSchema = upsertSchema.partial().extend({ archived: z.boolean().optional() });

interface ProjectRow {
  id: number;
  name: string;
  color: string;
  description: string | null;
  weekly_target_minutes: number | null;
  notion_url: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  total_seconds: number | null;
  block_count: number;
  last_worked_at: string | null;
}

const view = (r: ProjectRow) => ({
  id: r.id,
  name: r.name,
  color: r.color,
  description: r.description,
  weeklyTargetMinutes: r.weekly_target_minutes,
  notionUrl: r.notion_url,
  archived: !!r.archived,
  totalSeconds: r.total_seconds ?? 0,
  blockCount: r.block_count ?? 0,
  lastWorkedAt: r.last_worked_at,
  createdAt: r.created_at,
});

const SELECT = `
  SELECT p.*,
         (SELECT COALESCE(SUM(active_seconds), 0) FROM sessions s
           WHERE s.project_id = p.id AND s.kind = 'focus' AND s.status <> 'abandoned')
           AS total_seconds,
         (SELECT COUNT(*) FROM sessions s
           WHERE s.project_id = p.id AND s.kind = 'focus' AND s.status <> 'abandoned')
           AS block_count,
         (SELECT MAX(started_at) FROM sessions s WHERE s.project_id = p.id) AS last_worked_at
  FROM projects p`;

function get(id: number): ProjectRow {
  const row = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as ProjectRow | undefined;
  if (!row) throw notFound('Project');
  return row;
}

projectsRouter.get(
  '/',
  handler((req) => {
    const includeArchived = req.query.includeArchived === 'true';
    const rows = db
      .prepare(
        `${SELECT} ${includeArchived ? '' : 'WHERE p.archived = 0'}
         ORDER BY p.archived ASC, last_worked_at DESC NULLS LAST, p.name ASC`,
      )
      .all() as ProjectRow[];
    return rows.map(view);
  }),
);

projectsRouter.post(
  '/',
  handler((req, res) => {
    const body = parse(upsertSchema, req.body);
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO projects
           (name, color, description, weekly_target_minutes, notion_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.color ?? '#6366f1',
        body.description ?? null,
        body.weeklyTargetMinutes ?? null,
        body.notionUrl ?? null,
        now,
        now,
      );
    res.status(201);
    return view(get(Number(info.lastInsertRowid)));
  }),
);

projectsRouter.patch(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'project id');
    const body = parse(patchSchema, req.body);
    get(id);
    const map: Record<string, unknown> = {
      name: body.name,
      color: body.color,
      description: body.description,
      weekly_target_minutes: body.weeklyTargetMinutes,
      notion_url: body.notionUrl,
      archived: body.archived === undefined ? undefined : body.archived ? 1 : 0,
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
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    return view(get(id));
  }),
);

/**
 * Archives by default. A hard delete keeps the history but detaches it
 * (sessions.project_id is ON DELETE SET NULL), so logged time is never lost.
 */
projectsRouter.delete(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'project id');
    get(id);
    if (req.query.hard === 'true') {
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return { deleted: id };
    }
    db.prepare('UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
    return view(get(id));
  }),
);
