import { db } from '../db.js';
import { badRequest, conflict, notFound } from './http.js';
import type { InterruptionReason } from './interruptions.js';
import { cutOut, toSpans } from './segments.js';
import { dayStartHour, getNumber, getSetting, tz } from './settings.js';
import { requireProject, requireTask, startTask } from './tasks.js';
import { focusDay, nowIso, secondsBetween } from './time.js';

export type SessionStatus = 'running' | 'paused' | 'completed' | 'abandoned';

/** A pomodoro counts down a fixed length; a stopwatch just counts up until you stop it. */
export type TimerMode = 'stopwatch' | 'pomodoro';

export interface SessionRow {
  id: number;
  project_id: number | null;
  /** The task this block was the work on, if any. */
  task_id: number | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  /** NULL is the stopwatch signal. There is deliberately no mode column to disagree with it. */
  planned_minutes: number | null;
  estimated_minutes: number | null;
  started_at: string;
  ended_at: string | null;
  local_day: string;
  active_seconds: number;
  interruptions: number;
  focus_rating: number | null;
  notes: string | null;
  status: SessionStatus;
  calendar_event_id: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string | null;
  project_color?: string | null;
  task_title?: string | null;
}

export interface SessionView {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  taskId: number | null;
  taskTitle: string | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  mode: TimerMode;
  /** The planned fields are null for a stopwatch: it has no length to count down from. */
  plannedMinutes: number | null;
  plannedSeconds: number | null;
  /** A guess to compare against. Display only; it never feeds a score or a countdown. */
  estimatedMinutes: number | null;
  startedAt: string;
  endedAt: string | null;
  day: string;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  overrunSeconds: number | null;
  interruptions: number;
  focusRating: number | null;
  focusScore: number | null;
  notes: string | null;
  status: SessionStatus;
  isLive: boolean;
  calendarEventId: string | null;
}

const SELECT = `
  SELECT s.*, p.name AS project_name, p.color AS project_color, t.title AS task_title
  FROM sessions s
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN tasks t ON t.id = s.task_id`;

/**
 * A 0-100 blend of how focused the block felt and how it actually went.
 * Self-report leads (you know best), but a block you cut short or spent
 * fielding interruptions cannot score as highly as one you rode out.
 *   60% self rating · 25% share of the planned block actually worked · 15% interruption decay
 * A stopwatch block has no plan to fall short of — you stopped when you were
 * done, so it counts as complete. (An estimate is a guess, not a plan, and
 * never feeds in.)
 * Null until the block has been rated.
 */
export function focusScore(s: {
  focus_rating: number | null;
  active_seconds: number;
  planned_minutes: number | null;
  interruptions: number;
}): number | null {
  if (s.focus_rating == null) return null;
  const rating = (s.focus_rating - 1) / 4;
  let completion = 1;
  if (s.planned_minutes != null) {
    const planned = Math.max(1, s.planned_minutes * 60);
    completion = Math.min(1, s.active_seconds / planned);
  }
  const calm = 1 / (1 + s.interruptions / 2);
  return Math.round(100 * (0.6 * rating + 0.25 * completion + 0.15 * calm));
}

/** Seconds actually spent working, counting an open segment up to `now`. */
function segmentSeconds(sessionId: number, now = nowIso()): number {
  const rows = db
    .prepare('SELECT started_at, ended_at FROM session_segments WHERE session_id = ?')
    .all(sessionId) as { started_at: string; ended_at: string | null }[];
  return rows.reduce((sum, r) => sum + secondsBetween(r.started_at, r.ended_at ?? now), 0);
}

export function toView(row: SessionRow): SessionView {
  // active_seconds is flushed on every pause/stop, so it is authoritative for
  // anything that is not currently ticking.
  const elapsed = row.status === 'running' ? segmentSeconds(row.id) : row.active_seconds;
  const plannedSeconds = row.planned_minutes == null ? null : row.planned_minutes * 60;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    projectColor: row.project_color ?? null,
    taskId: row.task_id,
    taskTitle: row.task_title ?? null,
    title: row.title,
    intent: row.intent,
    kind: row.kind,
    mode: plannedSeconds == null ? 'stopwatch' : 'pomodoro',
    plannedMinutes: row.planned_minutes,
    plannedSeconds,
    estimatedMinutes: row.estimated_minutes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    day: row.local_day,
    elapsedSeconds: elapsed,
    remainingSeconds: plannedSeconds == null ? null : Math.max(0, plannedSeconds - elapsed),
    overrunSeconds: plannedSeconds == null ? null : Math.max(0, elapsed - plannedSeconds),
    interruptions: row.interruptions,
    focusRating: row.focus_rating,
    focusScore: focusScore({ ...row, active_seconds: elapsed }),
    notes: row.notes,
    status: row.status,
    isLive: row.status === 'running' || row.status === 'paused',
    calendarEventId: row.calendar_event_id,
  };
}

export function getSessionRow(id: number): SessionRow {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
  if (!row) throw notFound('Session');
  return row;
}

export function liveSessionRow(): SessionRow | undefined {
  return db
    .prepare(`${SELECT} WHERE s.status IN ('running','paused') LIMIT 1`)
    .get() as SessionRow | undefined;
}

export interface StartInput {
  /**
   * Left out, the block takes the task's project (if it has one); naming a
   * project, or null for none, always wins.
   */
  projectId?: number | null;
  /**
   * The task this block is the work on. A task's own estimate is total effort
   * across many blocks, so it is never copied onto the block as its estimate.
   */
  taskId?: number | null;
  title: string;
  intent?: string | null;
  /**
   * Left out, `plannedMinutes` alone still means a countdown of that length
   * (every caller that predates stopwatch relies on it), and a break is always
   * a countdown; with none of those, the `default_timer_mode` setting decides.
   * Asking for a stopwatch and a length together is a contradiction and is
   * refused.
   */
  mode?: TimerMode;
  plannedMinutes?: number;
  /** A guess to compare against when you review; never a countdown. */
  estimatedMinutes?: number | null;
  kind?: 'focus' | 'break';
  planItemId?: number | null;
  calendarEventId?: string | null;
}

export function startSession(input: StartInput): SessionView {
  // Wrong whatever is on the clock, so refused before looking at it. PATCH
  // answers 400 to the same contradiction rather than quietly dropping the plan.
  if (input.mode === 'stopwatch' && input.plannedMinutes != null) {
    throw badRequest('A stopwatch has no planned length');
  }
  // Wrong whatever is on the clock, so refused before looking at it, like the above.
  const task = input.taskId == null ? null : requireTask(input.taskId);
  const live = liveSessionRow();
  if (live) {
    throw conflict(
      `"${live.title}" is still on the clock — stop it before starting another block`,
    );
  }
  const now = nowIso();
  const kind = input.kind ?? 'focus';
  const defaultMinutes =
    kind === 'break' ? getNumber('short_break_minutes', 10) : getNumber('focus_minutes', 45);
  const fallbackMode: TimerMode =
    getSetting('default_timer_mode') === 'pomodoro' ? 'pomodoro' : 'stopwatch';
  // A break is a rest with an end, so the setting for how you like to work
  // never turns it into a stopwatch.
  const mode =
    input.mode ?? (input.plannedMinutes != null || kind === 'break' ? 'pomodoro' : fallbackMode);
  const planned = mode === 'stopwatch' ? null : (input.plannedMinutes ?? defaultMinutes);
  // A task's project is where a block on it belongs unless the caller says otherwise.
  const projectId = input.projectId !== undefined ? input.projectId : (task?.projectId ?? null);

  return db.transaction(() => {
    // Ahead of the first write, so a project that is not there is the caller's 400
    // and not the foreign key's 500.
    if (projectId != null) requireProject(projectId);
    const info = db
      .prepare(
        `INSERT INTO sessions
          (project_id, task_id, title, intent, kind, planned_minutes, estimated_minutes,
           started_at, local_day, active_seconds, status, calendar_event_id, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?, ?)`,
      )
      .run(
        projectId,
        task?.id ?? null,
        input.title,
        input.intent ?? null,
        kind,
        planned,
        input.estimatedMinutes ?? null,
        now,
        focusDay(now, tz(), dayStartHour()),
        input.calendarEventId ?? null,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO session_segments (session_id, started_at) VALUES (?, ?)').run(id, now);
    // Work begun on a task moves it along. A break is a rest, not work on it.
    if (task && kind === 'focus') startTask(task.id);
    if (input.planItemId) {
      db.prepare('UPDATE plan_items SET session_id = ?, updated_at = ? WHERE id = ?').run(
        id,
        now,
        input.planItemId,
      );
    }
    return toView(getSessionRow(id));
  })();
}

/** Close the open segment and flush the running total onto the session. */
function flush(id: number, now: string): number {
  db.prepare(
    'UPDATE session_segments SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL',
  ).run(now, id);
  const total = segmentSeconds(id, now);
  db.prepare('UPDATE sessions SET active_seconds = ?, updated_at = ? WHERE id = ?').run(
    total,
    now,
    id,
  );
  return total;
}

export function pauseSession(id: number): SessionView {
  const row = getSessionRow(id);
  if (row.status !== 'running') throw conflict(`Session is ${row.status}, not running`);
  const now = nowIso();
  return db.transaction(() => {
    flush(id, now);
    db.prepare("UPDATE sessions SET status = 'paused', updated_at = ? WHERE id = ?").run(now, id);
    return toView(getSessionRow(id));
  })();
}

export function resumeSession(id: number): SessionView {
  const row = getSessionRow(id);
  if (row.status !== 'paused') throw conflict(`Session is ${row.status}, not paused`);
  const now = nowIso();
  return db.transaction(() => {
    db.prepare('INSERT INTO session_segments (session_id, started_at) VALUES (?, ?)').run(id, now);
    db.prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?").run(now, id);
    return toView(getSessionRow(id));
  })();
}

export interface StopInput {
  focusRating?: number | null;
  notes?: string | null;
  title?: string;
  projectId?: number | null;
  /** Override the clock — for when the timer ran on while you were away. */
  activeSeconds?: number;
}

export function stopSession(
  id: number,
  status: 'completed' | 'abandoned',
  input: StopInput = {},
): SessionView {
  const row = getSessionRow(id);
  if (row.status === 'completed' || row.status === 'abandoned') {
    throw conflict(`Session is already ${row.status}`);
  }
  const now = nowIso();
  return db.transaction(() => {
    flush(id, now);
    if (input.activeSeconds != null) {
      overwriteActiveSeconds(id, input.activeSeconds, now);
    }
    db.prepare(
      `UPDATE sessions SET
         status = ?, ended_at = ?,
         title = COALESCE(?, title),
         project_id = CASE WHEN ? = 1 THEN ? ELSE project_id END,
         focus_rating = COALESCE(?, focus_rating),
         notes = COALESCE(?, notes),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      now,
      input.title ?? null,
      input.projectId !== undefined ? 1 : 0,
      input.projectId ?? null,
      input.focusRating ?? null,
      input.notes ?? null,
      now,
      id,
    );
    if (status === 'completed') {
      db.prepare('UPDATE plan_items SET done = 1, updated_at = ? WHERE session_id = ?').run(
        now,
        id,
      );
    }
    return toView(getSessionRow(id));
  })();
}

/**
 * Replace the segment history with a single span of the given length.
 * Used when the clock kept running after you walked away.
 */
export function overwriteActiveSeconds(id: number, seconds: number, now = nowIso()): void {
  const row = getSessionRow(id);
  const clamped = Math.max(0, Math.round(seconds));
  db.transaction(() => {
    db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(id);
    db.prepare(
      'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
    ).run(id, row.started_at, new Date(Date.parse(row.started_at) + clamped * 1000).toISOString());
    db.prepare('UPDATE sessions SET active_seconds = ?, updated_at = ? WHERE id = ?').run(
      clamped,
      now,
      id,
    );
    keepPendingAway(id, now);
  })();
}

/**
 * Answer, as Keep it, the away stretches of a block that are still waiting for one. It is
 * for the moment its time has been set by hand (typed in, given when finishing, or the block
 * moved to another time): whoever did that has said what the time was, and a stretch dropped
 * from it afterwards would take the same minutes off twice, or cut the wrong ones. Not a
 * transaction of its own: it belongs to the write that set the time.
 */
export function keepPendingAway(sessionId: number, now: string): void {
  db.prepare(
    "UPDATE away_intervals SET status = 'kept', resolved_at = ? WHERE session_id = ? AND status = 'pending'",
  ).run(now, sessionId);
}

/**
 * Log an interruption on a block, or take some back with a negative `delta`. The count on
 * the block is what the score and the day's totals read; the rows in `interruptions` say
 * what each one was. The two are written together, so a failed write cannot leave a count
 * that no row stands behind or the reverse.
 *   + each one added gets a row of its own, with `reason` or none (NULL, "No reason")
 *   - takes that many of the block's most recent rows away with it, and never below zero:
 *     the count stops at 0, and no more rows go than there are. Most recent by id, which is
 *     the order they were made in, and which stays right if the clock is set back.
 * A reason says what an added interruption was, so it means nothing to a delta that adds none.
 * Blocks logged before reasons existed have a count and no rows, and taking one back from
 * those only lowers the count.
 */
export function addInterruption(
  id: number,
  delta = 1,
  reason: InterruptionReason | null = null,
): SessionView {
  const now = nowIso();
  return db.transaction(() => {
    const row = getSessionRow(id);
    db.prepare('UPDATE sessions SET interruptions = ?, updated_at = ? WHERE id = ?').run(
      Math.max(0, row.interruptions + delta),
      now,
      id,
    );
    if (delta > 0) {
      const add = db.prepare('INSERT INTO interruptions (session_id, at, reason) VALUES (?, ?, ?)');
      for (let n = 0; n < delta; n++) add.run(id, now, reason);
    } else if (delta < 0) {
      db.prepare(
        `DELETE FROM interruptions WHERE id IN (
           SELECT id FROM interruptions WHERE session_id = ? ORDER BY id DESC LIMIT ?)`,
      ).run(id, -delta);
    }
    return toView(getSessionRow(id));
  })();
}

/**
 * Take the rows of a block back to what its count says, after the count was written by hand
 * (the block editor can set it to anything): the oldest `count` rows stay and the newer ones
 * go, the same ones that taking an interruption back removes. Left alone, a block whose count
 * was lowered would keep the reasons of interruptions it no longer has, and the next one
 * logged would sit behind them and be read as the one in front, under the wrong reason. A
 * count above the rows needs nothing: the difference is interruptions with no reason, as on a
 * block from before reasons. Not a transaction of its own: the caller's write of the count is
 * the other half of it.
 */
export function trimInterruptionRows(id: number, count: number): void {
  db.prepare(
    `DELETE FROM interruptions WHERE id IN (
       SELECT id FROM interruptions WHERE session_id = ? ORDER BY id ASC LIMIT -1 OFFSET ?)`,
  ).run(id, count);
}

export function extendSession(id: number, minutes: number): SessionView {
  const row = getSessionRow(id);
  // null + minutes is a number in JS, so without this a stopwatch would quietly
  // turn into a fixed-length block.
  if (row.planned_minutes == null) {
    throw conflict('Stopwatch blocks have no planned length to extend');
  }
  const next = Math.max(1, row.planned_minutes + minutes);
  db.prepare('UPDATE sessions SET planned_minutes = ?, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    id,
  );
  return toView(getSessionRow(id));
}

export interface SwitchInput {
  /** The block to start, exactly as `startSession` takes it. */
  start: StartInput;
  /** How the block being left went. Nothing to rate when nothing is on the clock. */
  rating?: number | null;
}

/**
 * Finish the block on the clock and start another in one step: the quick-switch box.
 * Whatever is live, running or paused, is completed (with the rating when there is
 * one) and then the new block goes through `startSession`, so every rule for starting
 * one applies unchanged. All of it is one transaction: a start that is refused (a task
 * or project that is not there, a stopwatch given a length) rolls the completion back
 * with it, and the block that was on the clock is left exactly as it was.
 */
export function switchSession(input: SwitchInput): {
  stopped: SessionView | null;
  started: SessionView;
} {
  return db.transaction(() => {
    const live = liveSessionRow();
    const stopped = live ? stopSession(live.id, 'completed', { focusRating: input.rating }) : null;
    return { stopped, started: startSession(input.start) };
  })();
}

/**
 * Log a block that happened away from the timer. Given a calendar event it is the time
 * spent on that meeting: the block is linked to it, so the meeting shows what was logged
 * on it, and a meeting that has time logged on it already (by a block that was not thrown
 * away) is refused with a 409 rather than logged a second time.
 */
export function logManualSession(input: {
  projectId?: number | null;
  title: string;
  startedAt: string;
  minutes: number;
  focusRating?: number | null;
  notes?: string | null;
  kind?: 'focus' | 'break';
  calendarEventId?: string | null;
}): SessionView {
  const now = nowIso();
  const seconds = Math.round(input.minutes * 60);
  const endedAt = new Date(Date.parse(input.startedAt) + seconds * 1000).toISOString();
  return db.transaction(() => {
    if (input.calendarEventId != null) {
      // Nothing enforces the link, so a meeting that is not there is refused here, ahead of
      // the write, rather than left pointing at nothing.
      if (!db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(input.calendarEventId)) {
        throw badRequest('Unknown calendar event');
      }
      // Looked up in the same transaction as the write, so two requests cannot both pass.
      if (
        db
          .prepare(
            "SELECT 1 FROM sessions WHERE calendar_event_id = ? AND status <> 'abandoned' LIMIT 1",
          )
          .get(input.calendarEventId)
      ) {
        throw conflict('That meeting is already logged');
      }
    }
    const info = db
      .prepare(
        `INSERT INTO sessions
          (project_id, title, kind, planned_minutes, started_at, ended_at, local_day,
           active_seconds, focus_rating, notes, status, calendar_event_id, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.title,
        input.kind ?? 'focus',
        Math.max(1, Math.round(input.minutes)),
        input.startedAt,
        endedAt,
        focusDay(input.startedAt, tz(), dayStartHour()),
        seconds,
        input.focusRating ?? null,
        input.notes ?? null,
        input.calendarEventId ?? null,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare(
      'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
    ).run(id, input.startedAt, endedAt);
    return toView(getSessionRow(id));
  })();
}

/**
 * Take a stretch of wall-clock time off a block: time the clock ticked on while you were
 * away. Every run of the clock that overlaps it is trimmed, split or removed (see cutOut)
 * and the total is worked out again from what is left, so a running, paused or finished
 * block reads as if that stretch had never been worked. Only ticking time comes off: a
 * stretch that was partly spent paused costs the block only the part it was running. A
 * running block keeps running, with the clock carrying on from the end of the stretch.
 * One transaction, so the segments and the total cannot disagree.
 */
export function dropInterval(sessionId: number, from: string, to: string): SessionView {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw badRequest('The time to drop has to end after it starts');
  }
  getSessionRow(sessionId);
  const now = nowIso();
  return db.transaction(() => {
    const rows = db
      .prepare(
        'SELECT started_at, ended_at FROM session_segments WHERE session_id = ? ORDER BY started_at, id',
      )
      .all(sessionId) as { started_at: string; ended_at: string | null }[];
    const cut = cutOut(toSpans(rows), start, end, Date.parse(now));
    // A stretch that falls where the clock was not running changes nothing, so nothing is rewritten.
    if (cut.removedMs > 0) {
      db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(sessionId);
      const add = db.prepare(
        'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
      );
      // The total is the closed runs only, as everywhere else: a running block's open run
      // is counted live, and is added to this only when it is closed.
      let closedSeconds = 0;
      for (const span of cut.spans) {
        const startedAt = new Date(span.start).toISOString();
        const endedAt = span.end == null ? null : new Date(span.end).toISOString();
        add.run(sessionId, startedAt, endedAt);
        if (endedAt) closedSeconds += secondsBetween(startedAt, endedAt);
      }
      db.prepare('UPDATE sessions SET active_seconds = ?, updated_at = ? WHERE id = ?').run(
        closedSeconds,
        now,
        sessionId,
      );
    }
    return toView(getSessionRow(sessionId));
  })();
}

export interface ListFilter {
  day?: string;
  from?: string;
  to?: string;
  projectId?: number;
  kind?: 'focus' | 'break';
  limit?: number;
}

export function listSessions(f: ListFilter): SessionView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.day) {
    where.push('s.local_day = ?');
    args.push(f.day);
  }
  if (f.from) {
    where.push('s.local_day >= ?');
    args.push(f.from);
  }
  if (f.to) {
    where.push('s.local_day <= ?');
    args.push(f.to);
  }
  if (f.projectId) {
    where.push('s.project_id = ?');
    args.push(f.projectId);
  }
  if (f.kind) {
    where.push('s.kind = ?');
    args.push(f.kind);
  }
  const sql =
    `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
    ` ORDER BY s.started_at DESC LIMIT ?`;
  args.push(f.limit ?? 500);
  return (db.prepare(sql).all(...args) as SessionRow[]).map(toView);
}
