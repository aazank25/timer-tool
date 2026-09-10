import { db } from '../db.js';
import { conflict, notFound } from './http.js';
import { dayStartHour, getNumber, tz } from './settings.js';
import { focusDay, nowIso, secondsBetween } from './time.js';

export type SessionStatus = 'running' | 'paused' | 'completed' | 'abandoned';

export interface SessionRow {
  id: number;
  project_id: number | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  planned_minutes: number;
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
}

export interface SessionView {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  plannedMinutes: number;
  plannedSeconds: number;
  startedAt: string;
  endedAt: string | null;
  day: string;
  elapsedSeconds: number;
  remainingSeconds: number;
  overrunSeconds: number;
  interruptions: number;
  focusRating: number | null;
  focusScore: number | null;
  notes: string | null;
  status: SessionStatus;
  isLive: boolean;
  calendarEventId: string | null;
}

const SELECT = `
  SELECT s.*, p.name AS project_name, p.color AS project_color
  FROM sessions s LEFT JOIN projects p ON p.id = s.project_id`;

/**
 * A 0-100 blend of how focused the block felt and how it actually went.
 * Self-report leads (you know best), but a block you cut short or spent
 * fielding interruptions cannot score as highly as one you rode out.
 *   60% self rating · 25% share of the planned block actually worked · 15% interruption decay
 * Null until the block has been rated.
 */
export function focusScore(s: {
  focus_rating: number | null;
  active_seconds: number;
  planned_minutes: number;
  interruptions: number;
}): number | null {
  if (s.focus_rating == null) return null;
  const rating = (s.focus_rating - 1) / 4;
  const planned = Math.max(1, s.planned_minutes * 60);
  const completion = Math.min(1, s.active_seconds / planned);
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
  const plannedSeconds = row.planned_minutes * 60;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    projectColor: row.project_color ?? null,
    title: row.title,
    intent: row.intent,
    kind: row.kind,
    plannedMinutes: row.planned_minutes,
    plannedSeconds,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    day: row.local_day,
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, plannedSeconds - elapsed),
    overrunSeconds: Math.max(0, elapsed - plannedSeconds),
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
  projectId?: number | null;
  title: string;
  intent?: string | null;
  plannedMinutes?: number;
  kind?: 'focus' | 'break';
  planItemId?: number | null;
  calendarEventId?: string | null;
}

export function startSession(input: StartInput): SessionView {
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
  const planned = input.plannedMinutes ?? defaultMinutes;

  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO sessions
          (project_id, title, intent, kind, planned_minutes, started_at, local_day,
           active_seconds, status, calendar_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.title,
        input.intent ?? null,
        kind,
        planned,
        now,
        focusDay(now, tz(), dayStartHour()),
        input.calendarEventId ?? null,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO session_segments (session_id, started_at) VALUES (?, ?)').run(id, now);
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
  })();
}

export function addInterruption(id: number, delta = 1): SessionView {
  const row = getSessionRow(id);
  const next = Math.max(0, row.interruptions + delta);
  db.prepare('UPDATE sessions SET interruptions = ?, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    id,
  );
  return toView(getSessionRow(id));
}

export function extendSession(id: number, minutes: number): SessionView {
  const row = getSessionRow(id);
  const next = Math.max(1, row.planned_minutes + minutes);
  db.prepare('UPDATE sessions SET planned_minutes = ?, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    id,
  );
  return toView(getSessionRow(id));
}

/** Log a block that happened away from the timer. */
export function logManualSession(input: {
  projectId?: number | null;
  title: string;
  startedAt: string;
  minutes: number;
  focusRating?: number | null;
  notes?: string | null;
  kind?: 'focus' | 'break';
}): SessionView {
  const now = nowIso();
  const seconds = Math.round(input.minutes * 60);
  const endedAt = new Date(Date.parse(input.startedAt) + seconds * 1000).toISOString();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO sessions
          (project_id, title, kind, planned_minutes, started_at, ended_at, local_day,
           active_seconds, focus_rating, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
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
