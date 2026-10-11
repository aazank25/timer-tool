import { db } from '../db.js';
import { badRequest, notFound } from './http.js';
// sessions.ts imports this file back, for requireTask and startTask. That is safe
// because neither file uses the other while it is loading, only from inside a
// function, so keep it that way: no module-level use of what these two provide.
import { liveSessionRow, toView as sessionView } from './sessions.js';
import { today } from './settings.js';
import { nowIso, weekStart } from './time.js';

export type TaskPriority = 'high' | 'medium' | 'low';
export type TaskStatus = 'not_started' | 'in_progress' | 'held_up' | 'completed';
/** Which tasks a listing covers: what is still to do, what is done, or both. */
export type TaskScope = 'open' | 'completed' | 'all';

export interface TaskRow {
  id: number;
  project_id: number | null;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimated_minutes: number | null;
  added_on: string;
  start_date: string | null;
  target_date: string | null;
  completed_on: string | null;
  notes: string | null;
  results: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  project_name: string | null;
  project_color: string | null;
  /** Finished blocks only. A block still on the clock is measured live in `toView`. */
  logged_seconds: number;
  block_count: number;
  last_worked_at: string | null;
}

export interface TaskView {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Total effort across every block it takes. Display only: never a block's own estimate. */
  estimatedMinutes: number | null;
  addedOn: string;
  /** The Monday of the week it was added: the sheet's "Week Of". */
  weekOf: string;
  startDate: string | null;
  targetDate: string | null;
  completedOn: string | null;
  notes: string | null;
  results: string | null;
  position: number;
  /** Focus time logged on it, a block still on the clock included. */
  loggedSeconds: number;
  blockCount: number;
  lastWorkedAt: string | null;
  /** Past its target day and not completed. */
  overdue: boolean;
}

/**
 * What the finished blocks on each task add up to. Breaks and abandoned blocks
 * are not work on it, and a block still on the clock is left out: its
 * active_seconds is only flushed on pause or stop, so `toView` reads that one
 * off the clock instead and nothing is counted twice.
 */
const SELECT = `
  SELECT t.*, p.name AS project_name, p.color AS project_color,
         COALESCE(w.logged_seconds, 0) AS logged_seconds,
         COALESCE(w.block_count, 0)    AS block_count,
         w.last_worked_at
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN (
    SELECT task_id,
           SUM(active_seconds) AS logged_seconds,
           COUNT(*)            AS block_count,
           MAX(started_at)     AS last_worked_at
    FROM sessions
    WHERE task_id IS NOT NULL AND kind = 'focus' AND status = 'completed'
    GROUP BY task_id
  ) w ON w.task_id = t.id`;

/**
 * The Monday of the week a task was added, in SQL, by the same rule as weekStart
 * in lib/time.ts (Monday-anchored, so a Sunday belongs to the week before it):
 * back six days, then forward to the next Monday. That is the day itself for a
 * Monday and the Monday just gone for every other day.
 */
const WEEK_OF = `date(t.added_on, '-6 days', 'weekday 1')`;

/**
 * Newest week first, then the most pressing within it whatever day it was added,
 * then the newest day, then the order you put them in. The week has to come
 * before the priority and the day after it: sorting by day first would bury a
 * Monday's high-priority task under Friday's low-priority one.
 */
const ORDER = `
  ORDER BY ${WEEK_OF} DESC,
           CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           t.added_on DESC,
           t.position ASC, t.id ASC`;

/** The block on the clock, when it is focus work on a task. */
interface OnTheClock {
  taskId: number;
  seconds: number;
  startedAt: string;
}

function onTheClock(): OnTheClock | null {
  const row = liveSessionRow();
  if (!row || row.task_id == null || row.kind !== 'focus') return null;
  return {
    taskId: row.task_id,
    seconds: sessionView(row).elapsedSeconds,
    startedAt: row.started_at,
  };
}

function toView(row: TaskRow, day: string, clock: OnTheClock | null): TaskView {
  const live = clock?.taskId === row.id ? clock : null;
  const lastWorkedAt =
    live && (row.last_worked_at == null || live.startedAt > row.last_worked_at)
      ? live.startedAt
      : row.last_worked_at;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectColor: row.project_color,
    title: row.title,
    priority: row.priority,
    status: row.status,
    estimatedMinutes: row.estimated_minutes,
    addedOn: row.added_on,
    weekOf: weekStart(row.added_on),
    startDate: row.start_date,
    targetDate: row.target_date,
    completedOn: row.completed_on,
    notes: row.notes,
    results: row.results,
    position: row.position,
    loggedSeconds: row.logged_seconds + (live?.seconds ?? 0),
    blockCount: row.block_count + (live ? 1 : 0),
    lastWorkedAt,
    overdue: row.target_date != null && row.target_date < day && row.status !== 'completed',
  };
}

export function getTask(id: number): TaskView {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  if (!row) throw notFound('Task');
  return toView(row, today(), onTheClock());
}

export interface TaskFilter {
  /** Defaults to 'open': every status except completed. */
  view?: TaskScope;
  /** A project's id, or 'none' for the tasks that belong to no project. */
  projectId?: number | 'none';
}

export function listTasks(f: TaskFilter = {}): TaskView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  const view = f.view ?? 'open';
  if (view === 'open') where.push("t.status <> 'completed'");
  if (view === 'completed') where.push("t.status = 'completed'");
  if (f.projectId === 'none') {
    where.push('t.project_id IS NULL');
  } else if (f.projectId !== undefined) {
    where.push('t.project_id = ?');
    args.push(f.projectId);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${ORDER}`;
  const day = today();
  const clock = onTheClock();
  return (db.prepare(sql).all(...args) as TaskRow[]).map((row) => toView(row, day, clock));
}

export interface TaskInput {
  title: string;
  projectId?: number | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  estimatedMinutes?: number | null;
  /** Defaults to today. */
  addedOn?: string;
  startDate?: string | null;
  targetDate?: string | null;
  completedOn?: string | null;
  notes?: string | null;
  results?: string | null;
}

/** Undefined leaves a field as it is; null clears the ones that can be empty. */
export type TaskPatch = Partial<TaskInput>;

/**
 * A project that is not there is the caller's mistake, not a missing page. Blocks
 * are pointed at projects too, so starting and editing one asks the same question.
 */
export function requireProject(id: number): void {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) {
    throw badRequest('Unknown project');
  }
}

/**
 * The task a block is being pointed at. Throws a 400, not a 404: it is the
 * block's request that is wrong, not the page that was asked for.
 */
export function requireTask(id: number): { id: number; projectId: number | null } {
  const row = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(id) as
    | { id: number; project_id: number | null }
    | undefined;
  if (!row) throw badRequest('Unknown task');
  return { id: row.id, projectId: row.project_id };
}

/**
 * The dates a request writes, whether it names them or implies them by moving
 * the status. A date named in the request wins over one implied by the status
 * (null included: it is how you clear one), because whoever typed it knows
 * better than the rule does.
 *   -> in progress with no start date: started today
 *   -> completed with no completion date: completed today
 *   completed -> anything else: no longer completed, so the completion date goes
 */
function datesFor(
  was: { status: TaskStatus | null; startDate: string | null; completedOn: string | null },
  want: { status?: TaskStatus; startDate?: string | null; completedOn?: string | null },
): { start_date?: string | null; completed_on?: string | null } {
  const set: { start_date?: string | null; completed_on?: string | null } = {};
  if (want.startDate !== undefined) {
    set.start_date = want.startDate;
  } else if (want.status === 'in_progress' && was.startDate == null) {
    set.start_date = today();
  }
  if (want.completedOn !== undefined) {
    set.completed_on = want.completedOn;
  } else if (want.status === 'completed' && was.completedOn == null) {
    set.completed_on = today();
  } else if (
    want.status !== undefined &&
    want.status !== 'completed' &&
    was.status === 'completed'
  ) {
    set.completed_on = null;
  }
  return set;
}

export function createTask(input: TaskInput): TaskView {
  if (input.projectId != null) requireProject(input.projectId);
  const now = nowIso();
  const dates = datesFor({ status: null, startDate: null, completedOn: null }, input);
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tasks
          (project_id, title, priority, status, estimated_minutes, added_on, start_date,
           target_date, completed_on, notes, results, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks), ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.title,
        input.priority ?? 'medium',
        input.status ?? 'not_started',
        input.estimatedMinutes ?? null,
        input.addedOn ?? today(),
        dates.start_date ?? null,
        input.targetDate ?? null,
        dates.completed_on ?? null,
        input.notes ?? null,
        input.results ?? null,
        now,
        now,
      );
    return getTask(Number(info.lastInsertRowid));
  })();
}

export function updateTask(id: number, patch: TaskPatch): TaskView {
  const row = db
    .prepare('SELECT status, start_date, completed_on FROM tasks WHERE id = ?')
    .get(id) as
    | { status: TaskStatus; start_date: string | null; completed_on: string | null }
    | undefined;
  if (!row) throw notFound('Task');
  if (patch.projectId != null) requireProject(patch.projectId);

  const map: Record<string, unknown> = {
    project_id: patch.projectId,
    title: patch.title,
    priority: patch.priority,
    status: patch.status,
    estimated_minutes: patch.estimatedMinutes,
    added_on: patch.addedOn,
    target_date: patch.targetDate,
    notes: patch.notes,
    results: patch.results,
    ...datesFor(
      { status: row.status, startDate: row.start_date, completedOn: row.completed_on },
      patch,
    ),
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
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  return getTask(id);
}

/**
 * A hard delete. The blocks logged on it keep every minute: sessions.task_id is
 * ON DELETE SET NULL, so they simply stop pointing at it.
 */
export function deleteTask(id: number): void {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!info.changes) throw notFound('Task');
}

/** Positions follow the order given. Ids that no longer exist are skipped. */
export function reorderTasks(ids: number[]): number {
  const stmt = db.prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?');
  const now = nowIso();
  return db.transaction(() =>
    ids.reduce((moved, id, position) => moved + stmt.run(position, now, id).changes, 0),
  )();
}

/**
 * Work has begun on a task: a block was started on it. Not started and held up
 * both become in progress, with a start date if it has none. A completed task
 * stays completed, because reopening it is a decision, not a side effect.
 */
export function startTask(id: number): void {
  db.prepare(
    `UPDATE tasks
        SET status = 'in_progress', start_date = COALESCE(start_date, ?), updated_at = ?
      WHERE id = ? AND status IN ('not_started', 'held_up')`,
  ).run(today(), nowIso(), id);
}
