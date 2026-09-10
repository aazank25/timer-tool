import { db } from '../db.js';
import { getNumber, tz } from './settings.js';
import { focusScore, listSessions, type SessionRow, type SessionView } from './sessions.js';
import { addDays, dayRange, localHour } from './time.js';

export interface ProjectSlice {
  projectId: number | null;
  name: string;
  color: string;
  seconds: number;
  blocks: number;
  avgFocusScore: number | null;
  share: number;
}

export interface DayStats {
  day: string;
  focusSeconds: number;
  breakSeconds: number;
  blocks: number;
  completedBlocks: number;
  abandonedBlocks: number;
  interruptions: number;
  avgFocusRating: number | null;
  avgFocusScore: number | null;
  ratedBlocks: number;
  targetMinutes: number;
  longestStreakSeconds: number;
  byProject: ProjectSlice[];
  byHour: { hour: number; seconds: number }[];
  sessions: SessionView[];
}

const UNASSIGNED = { name: 'Unassigned', color: '#94a3b8' };

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function rollupProjects(rows: SessionRow[]): ProjectSlice[] {
  const map = new Map<string, ProjectSlice & { scores: number[] }>();
  for (const r of rows) {
    const key = String(r.project_id ?? 'none');
    let slice = map.get(key);
    if (!slice) {
      slice = {
        projectId: r.project_id,
        name: r.project_name ?? UNASSIGNED.name,
        color: r.project_color ?? UNASSIGNED.color,
        seconds: 0,
        blocks: 0,
        avgFocusScore: null,
        share: 0,
        scores: [],
      };
      map.set(key, slice);
    }
    slice.seconds += r.active_seconds;
    slice.blocks += 1;
    const score = focusScore(r);
    if (score != null) slice.scores.push(score);
  }
  const total = [...map.values()].reduce((a, s) => a + s.seconds, 0) || 1;
  return [...map.values()]
    .map(({ scores, ...s }) => ({
      ...s,
      avgFocusScore: avg(scores),
      share: Math.round((s.seconds / total) * 1000) / 10,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * Spread each block's worked time across the clock hours it actually covered,
 * so a 45-minute block starting at 10:40 lands 20 minutes in hour 10 and 25 in
 * hour 11. Reads the segment log, so paused time is not attributed anywhere.
 */
function rollupHours(sessionIds: number[], zone: string): { hour: number; seconds: number }[] {
  const buckets = new Array<number>(24).fill(0);
  if (!sessionIds.length) return buckets.map((seconds, hour) => ({ hour, seconds }));

  const placeholders = sessionIds.map(() => '?').join(',');
  const segments = db
    .prepare(
      `SELECT started_at, ended_at FROM session_segments
       WHERE session_id IN (${placeholders}) AND ended_at IS NOT NULL`,
    )
    .all(...sessionIds) as { started_at: string; ended_at: string }[];

  for (const seg of segments) {
    let cursor = Date.parse(seg.started_at);
    const end = Date.parse(seg.ended_at);
    while (cursor < end) {
      const hour = localHour(new Date(cursor).toISOString(), zone);
      // Walk to the next wall-clock hour boundary a minute at a time rather
      // than assuming 60 minutes, so DST shifts and half-hour zones hold up.
      let boundary = Math.floor(cursor / 60_000) * 60_000 + 60_000;
      while (boundary < end && localHour(new Date(boundary).toISOString(), zone) === hour) {
        boundary += 60_000;
      }
      const sliceEnd = Math.min(end, boundary);
      buckets[hour] = (buckets[hour] ?? 0) + Math.round((sliceEnd - cursor) / 1000);
      cursor = sliceEnd;
    }
  }
  return buckets.map((seconds, hour) => ({ hour, seconds }));
}

/** Longest run of back-to-back work with no gap longer than `gapSeconds`. */
function longestStreak(rows: SessionRow[], gapSeconds = 15 * 60): number {
  const spans = rows
    .filter((r) => r.kind === 'focus' && r.ended_at)
    .map((r) => ({ start: Date.parse(r.started_at), end: Date.parse(r.ended_at as string) }))
    .sort((a, b) => a.start - b.start);
  let best = 0;
  let runStart: number | null = null;
  let runEnd = 0;
  for (const s of spans) {
    if (runStart == null || s.start - runEnd > gapSeconds * 1000) {
      runStart = s.start;
      runEnd = s.end;
    } else {
      runEnd = Math.max(runEnd, s.end);
    }
    best = Math.max(best, runEnd - runStart);
  }
  return Math.round(best / 1000);
}

function rowsForRange(from: string, to: string): SessionRow[] {
  return db
    .prepare(
      `SELECT s.*, p.name AS project_name, p.color AS project_color
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.local_day BETWEEN ? AND ?
       ORDER BY s.started_at ASC`,
    )
    .all(from, to) as SessionRow[];
}

export function dayStats(day: string): DayStats {
  const rows = rowsForRange(day, day);
  const focusRows = rows.filter((r) => r.kind === 'focus' && r.status !== 'abandoned');
  const ratings = rows.map((r) => r.focus_rating).filter((r): r is number => r != null);
  const scores = rows.map(focusScore).filter((s): s is number => s != null);
  return {
    day,
    focusSeconds: focusRows.reduce((a, r) => a + r.active_seconds, 0),
    breakSeconds: rows.filter((r) => r.kind === 'break').reduce((a, r) => a + r.active_seconds, 0),
    blocks: focusRows.length,
    completedBlocks: rows.filter((r) => r.status === 'completed' && r.kind === 'focus').length,
    abandonedBlocks: rows.filter((r) => r.status === 'abandoned').length,
    interruptions: rows.reduce((a, r) => a + r.interruptions, 0),
    avgFocusRating: avg(ratings),
    avgFocusScore: avg(scores),
    ratedBlocks: ratings.length,
    targetMinutes: getNumber('daily_target_minutes', 300),
    longestStreakSeconds: longestStreak(rows),
    byProject: rollupProjects(focusRows),
    byHour: rollupHours(
      focusRows.map((r) => r.id),
      tz(),
    ),
    sessions: listSessions({ day }),
  };
}

export interface RangeStats {
  from: string;
  to: string;
  totalFocusSeconds: number;
  totalBlocks: number;
  activeDays: number;
  avgFocusScore: number | null;
  avgSecondsPerActiveDay: number;
  days: {
    day: string;
    focusSeconds: number;
    blocks: number;
    avgFocusScore: number | null;
    byProject: { projectId: number | null; seconds: number }[];
  }[];
  byProject: ProjectSlice[];
  byHour: { hour: number; seconds: number }[];
}

export function rangeStats(from: string, to: string): RangeStats {
  const rows = rowsForRange(from, to).filter((r) => r.kind === 'focus' && r.status !== 'abandoned');
  const byDay = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.local_day) ?? [];
    list.push(r);
    byDay.set(r.local_day, list);
  }
  const days = dayRange(from, to).map((day) => {
    const list = byDay.get(day) ?? [];
    const scores = list.map(focusScore).filter((s): s is number => s != null);
    const perProject = new Map<number | null, number>();
    for (const r of list) {
      perProject.set(r.project_id, (perProject.get(r.project_id) ?? 0) + r.active_seconds);
    }
    return {
      day,
      focusSeconds: list.reduce((a, r) => a + r.active_seconds, 0),
      blocks: list.length,
      avgFocusScore: avg(scores),
      byProject: [...perProject].map(([projectId, seconds]) => ({ projectId, seconds })),
    };
  });
  const allScores = rows.map(focusScore).filter((s): s is number => s != null);
  const activeDays = days.filter((d) => d.focusSeconds > 0).length;
  const total = rows.reduce((a, r) => a + r.active_seconds, 0);
  return {
    from,
    to,
    totalFocusSeconds: total,
    totalBlocks: rows.length,
    activeDays,
    avgFocusScore: avg(allScores),
    avgSecondsPerActiveDay: activeDays ? Math.round(total / activeDays) : 0,
    days,
    byProject: rollupProjects(rows),
    byHour: rollupHours(
      rows.map((r) => r.id),
      tz(),
    ),
  };
}

/** Rolling window ending on `day`, inclusive. */
export const trailing = (day: string, days: number) => ({
  from: addDays(day, -(days - 1)),
  to: day,
});
