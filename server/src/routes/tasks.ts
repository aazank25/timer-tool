import { Router } from 'express';
import { z } from 'zod';
import { handler, intParam, parse } from '../lib/http.js';
import { createTask, deleteTask, listTasks, reorderTasks, updateTask } from '../lib/tasks.js';

export const tasksRouter = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The pattern alone lets 2026-02-30 through. It would be stored as typed while
 * everything that reads it (the week it falls in, whether it is overdue) took it
 * for March 2nd, so a day has to survive a round trip through Date to count.
 */
function isRealDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const day = z.string().regex(DAY, 'must be YYYY-MM-DD').refine(isRealDay, 'must be a real date');

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  projectId: z.number().int().positive().nullish(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['not_started', 'in_progress', 'held_up', 'completed']).optional(),
  // Total effort across every block it takes, not a single block's guess.
  estimatedMinutes: z.number().int().min(1).max(6000).nullish(),
  addedOn: day.optional(),
  startDate: day.nullish(),
  targetDate: day.nullish(),
  completedOn: day.nullish(),
  notes: z.string().max(20_000).nullish(),
  results: z.string().max(20_000).nullish(),
});
const patchSchema = createSchema.partial();

const listSchema = z.object({
  view: z.enum(['open', 'completed', 'all']).optional(),
  projectId: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
});

tasksRouter.get(
  '/',
  handler((req) => listTasks(parse(listSchema, req.query))),
);

tasksRouter.post(
  '/',
  handler((req, res) => {
    const body = parse(createSchema, req.body);
    res.status(201);
    return createTask(body);
  }),
);

tasksRouter.post(
  '/reorder',
  handler((req) => {
    const { ids } = parse(
      z.object({ ids: z.array(z.number().int().positive()).max(500) }),
      req.body,
    );
    return { reordered: reorderTasks(ids) };
  }),
);

tasksRouter.patch(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'task id');
    return updateTask(id, parse(patchSchema, req.body));
  }),
);

/** A hard delete: the blocks logged on the task are kept and simply unlinked. */
tasksRouter.delete(
  '/:id',
  handler((req) => {
    const id = intParam(req.params.id, 'task id');
    deleteTask(id);
    return { deleted: id };
  }),
);
