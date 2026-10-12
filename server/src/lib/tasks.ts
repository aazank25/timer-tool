import { db } from '../db.js';
import { badRequest, notFound } from './http.js';
// sessions.ts imports this file back, for requireTask and startTask. That is safe
// because neither file uses the other while it is loading, only from inside a
// function, so keep it that way: no module-level use of what these two provide.
import { liveSessionRow, toView as sessionView, type SessionRow } from './sessions.js';
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
  /** The Monday of the week it sits in. Stored, not worked out from `added_on`: see migration 6. */
  week_of: string;
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
  /**
   * The Monday of the week it sits in: the sheet's "Week Of". It starts as the week it was
   * added and moves when the task is carried forward or filed under another week by hand.
   */
  weekOf: string;
  /** The Monday of the week it was added, when that is not the week it sits in now. */
  carriedFrom: string | null;
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
 * off the clock instead and nothing is counted twice. Exported so the estimate
 * insights count a task's logged time by this same rule and not a copy of it.
 */
export const LOGGED_ON_TASKS = `
  SELECT task_id,
         SUM(active_seconds) AS logged_seconds,
         COUNT(*)            AS block_count,
         MAX(started_at)     AS last_worked_at
  FROM sessions
  WHERE task_id IS NOT NULL AND kind = 'focus' AND status = 'completed'
  GROUP BY task_id`;

const SELECT = `
  SELECT t.*, p.name AS project_name, p.color AS project_color,
         COALESCE(w.logged_seconds, 0) AS logged_seconds,
         COALESCE(w.block_count, 0)    AS block_count,
         w.last_worked_at
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN (${LOGGED_ON_TASKS}) w ON w.task_id = t.id`;

/**
 * The priority as a number, most pressing first. A band is ordered by it wherever the
 * bands are listed, so the list and a carry-over cannot disagree about what comes first.
 */
const PRIORITY_RANK = `CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

/**
 * Newest week first, then the most pressing within it, then the order you have put
 * them in. The week and the priority make a task's band, and the order is yours
 * inside a band only: `position` is where it is kept. A new task takes the next
 * position, so it lands at the bottom of its band like a row added to the end of a
 * sheet, and a move renumbers the band it is made in. The week has to come before
 * the priority, or last week's high-priority task would sit above everything in
 * this week. The week is the one stored on the task, not one worked out from the day
 * it was added: a task carried forward sits with the week it was carried into. The day
 * it was added is deliberately not in the order: it would put the newest day on top
 * and undo every move.
 */
const ORDER = `
  ORDER BY t.week_of DESC, ${PRIORITY_RANK}, t.position ASC, t.id ASC`;

/**
 * One past the highest position any task has, so the task given it sorts last in
 * whichever band it is in. Positions are only compared inside a band, so the gaps
 * this leaves in the others do no harm.
 */
const NEXT_POSITION = '(SELECT COALESCE(MAX(position), -1) + 1 FROM tasks)';

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
  const addedWeek = weekStart(row.added_on);
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
    weekOf: row.week_of,
    carriedFrom: addedWeek === row.week_of ? null : addedWeek,
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
  /** Defaults to today. It is a record of when the task was added and never moves it between weeks. */
  addedOn?: string;
  /**
   * Any real day: the task is filed under that day's Monday. Left out, a new task goes in
   * the week of the day it was added, and an edit leaves the week where it is.
   */
  weekOf?: string;
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
  const addedOn = input.addedOn ?? today();
  // A new task sits in the week it was added unless it is filed under another on the way in.
  // A day given as the week is taken to its Monday, so no caller has to know to do that.
  const weekOf = weekStart(input.weekOf ?? addedOn);
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tasks
          (project_id, title, priority, status, estimated_minutes, added_on, week_of, start_date,
           target_date, completed_on, notes, results, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_POSITION}, ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.title,
        input.priority ?? 'medium',
        input.status ?? 'not_started',
        input.estimatedMinutes ?? null,
        addedOn,
        weekOf,
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
    .prepare('SELECT priority, status, week_of, start_date, completed_on FROM tasks WHERE id = ?')
    .get(id) as
    | {
        priority: TaskPriority;
        status: TaskStatus;
        week_of: string;
        start_date: string | null;
        completed_on: string | null;
      }
    | undefined;
  if (!row) throw notFound('Task');
  if (patch.projectId != null) requireProject(patch.projectId);

  // The week a task is filed under, as the Monday it is stored as. Saying the week it is
  // already in, by any day of it, is not a change.
  const weekOf = patch.weekOf === undefined ? undefined : weekStart(patch.weekOf);

  // A task that lands in another band goes to the bottom of it, like one added there.
  // One that stays in its band keeps its place whatever else about it is edited, so saying
  // the priority again is not a move. Neither is the day it was added, whatever that is
  // changed to: the day is a record, and only the week it is filed under puts it elsewhere.
  const changesBand =
    (patch.priority !== undefined && patch.priority !== row.priority) ||
    (weekOf !== undefined && weekOf !== row.week_of);

  const map: Record<string, unknown> = {
    project_id: patch.projectId,
    title: patch.title,
    priority: patch.priority,
    status: patch.status,
    estimated_minutes: patch.estimatedMinutes,
    added_on: patch.addedOn,
    week_of: weekOf,
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
  if (changesBand) sets.push(`position = ${NEXT_POSITION}`);
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

/**
 * Where a move puts a task: right before another task, or right after it. Exactly one
 * key, and the other cannot be there at all, so no value can name two sides at once.
 */
export type TaskMove = { before: number; after?: never } | { after: number; before?: never };

/**
 * Put a task right before or right after another one in its band. The band is read
 * from the database whole, completed tasks and all, whatever the screen shows: a list
 * that hides rows must not be able to number around them. The task comes out of it,
 * goes back in beside the anchor, and the band is numbered 0..n-1 again, writing only
 * the rows whose number changed. Two tasks of different bands have no order against
 * each other, so that is refused rather than guessed at, and nothing is written for a
 * request that is refused.
 */
export function moveTask(id: number, to: TaskMove): void {
  // The anchor and the side come from the one key that carries a value. Testing for the
  // keys instead would let a call that passes both, `after: undefined` beside a `before`,
  // take the anchor from one and the side from the other.
  const [anchorId, side] =
    to.before !== undefined ? ([to.before, 'before'] as const) : ([to.after, 'after'] as const);
  db.transaction(() => {
    const ends = db
      .prepare('SELECT t.id, t.priority, t.week_of FROM tasks t WHERE t.id IN (?, ?)')
      .all(id, anchorId) as { id: number; priority: TaskPriority; week_of: string }[];
    const task = ends.find((r) => r.id === id);
    if (!task) throw notFound('Task');
    // Beside itself is where it already is.
    if (anchorId === id) return;
    const anchor = ends.find((r) => r.id === anchorId);
    if (!anchor) throw badRequest('Unknown task');
    if (anchor.priority !== task.priority || anchor.week_of !== task.week_of) {
      throw badRequest('A task can only be moved within its own week and priority');
    }

    const band = db
      .prepare(
        `SELECT t.id, t.position FROM tasks t
          WHERE t.priority = ? AND t.week_of = ?
          ORDER BY t.position ASC, t.id ASC`,
      )
      .all(task.priority, task.week_of) as { id: number; position: number }[];
    const order = band.filter((r) => r.id !== id).map((r) => r.id);
    order.splice(order.indexOf(anchorId) + (side === 'after' ? 1 : 0), 0, id);

    const was = new Map(band.map((r) => [r.id, r.position]));
    const write = db.prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    order.forEach((taskId, position) => {
      if (was.get(taskId) !== position) write.run(position, now, taskId);
    });
  })();
}

/**
 * Bring every unfinished task from an earlier week into the week the user is in now, the
 * Monday of today. A task that is done stays in the week it was finished in, and one filed
 * under this week or a later one is not touched. Each carried task goes to the bottom of
 * its band here (this week, its own priority), like a row added to the end of the sheet,
 * and they keep the order they had: the oldest week first, then the order within its band,
 * so one that was ahead of another still is. Each is given the highest position yet, one
 * after the other, which is what puts it last and keeps them in that order.
 *
 * One transaction, so a failure part way carries none of them. Done twice it carries
 * nothing the second time, because by then no unfinished task is left in an earlier week.
 */
export function carryOverTasks(): { carried: number; weekOf: string } {
  const thisWeek = weekStart(today());
  return db.transaction(() => {
    const due = db
      .prepare(
        `SELECT t.id FROM tasks t
          WHERE t.status <> 'completed' AND t.week_of < ?
          ORDER BY t.week_of ASC, ${PRIORITY_RANK}, t.position ASC, t.id ASC`,
      )
      .all(thisWeek) as { id: number }[];
    const carry = db.prepare(
      `UPDATE tasks SET week_of = ?, position = ${NEXT_POSITION}, updated_at = ? WHERE id = ?`,
    );
    const now = nowIso();
    for (const { id } of due) carry.run(thisWeek, now, id);
    return { carried: due.length, weekOf: thisWeek };
  })();
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

/**
 * A block that has already started was pointed at a task from the block log: the work
 * on it happened, so the task moves along as it would have if the block had been
 * started on it. What that comes to depends on the block as it is now.
 *   running or paused  exactly what starting a block on the task does (startTask)
 *   completed          only a task not started moves, to in progress, and its start
 *                      date is the day that block was worked rather than today, since
 *                      that is when the work began. A start date the task already has
 *                      is kept (COALESCE), not replaced by that day. A task held up
 *                      or completed stays as it is: holding or finishing it was
 *                      decided after a block that old
 *   abandoned          nothing: a discarded block is not work on the task
 *   a break            nothing, in any state: a rest is not work on it either
 * `block` is the block as it stood before the edit, and `taskId` what the edit says
 * its task is, if it says anything. Only a different task counts. Saying the same one
 * again, unlinking and leaving the task out all change no task, so an edit that is
 * about something else cannot restart a task that was put on hold since. The block's
 * project is not touched here either: the edit says what that is.
 */
export function startTaskForLinkedBlock(
  block: Pick<SessionRow, 'kind' | 'status' | 'local_day' | 'task_id'>,
  taskId: number | null | undefined,
): void {
  if (taskId == null || taskId === block.task_id || block.kind === 'break') return;
  if (block.status === 'running' || block.status === 'paused') {
    startTask(taskId);
  } else if (block.status === 'completed') {
    db.prepare(
      `UPDATE tasks
          SET status = 'in_progress', start_date = COALESCE(start_date, ?), updated_at = ?
        WHERE id = ? AND status = 'not_started'`,
    ).run(block.local_day, nowIso(), taskId);
  }
}
