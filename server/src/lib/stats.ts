import { db } from '../db.js';
import { INTERRUPTION_REASONS, type InterruptionReason } from './interruptions.js';
import { getNumber, tz } from './settings.js';
import { focusScore, listSessions, type SessionRow, type SessionView } from './sessions.js';
import { LOGGED_ON_TASKS } from './tasks.js';
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

/* ------------------------------------------------------------ interruptions */

export interface InterruptionStats {
  from: string;
  to: string;
  /** Every interruption counted on a focus block in the window, with a reason or without. */
  total: number;
  /** The reasons that were given, most often first. A reason nobody gave is left out. */
  byReason: { reason: InterruptionReason; label: string; count: number }[];
  /**
   * Counted, but no reason was given: logged before reasons existed, or logged with "No
   * reason". `total` is always the reasons given plus this.
   */
  unspecified: number;
}

/**
 * What pulled you away from your focus blocks in a window. Breaks are not counted, being
 * interrupted on a rest is not the thing this is about, and neither status matters: a block
 * that was abandoned was still interrupted.
 *
 * `total` is what the blocks' own counts add up to, the figure every other screen reads, and
 * the reasons are read against it. A block's rows are only counted up to its count, oldest
 * first, so a count lowered by hand (the block editor's API can do that without touching
 * the rows) cannot show more interruptions here than the block has. What the reasons do not
 * account for is `unspecified` (blocks from before reasons, and interruptions logged with
 * none), so that is worked out last, as the remainder, and the three always add up.
 */
export function interruptionStats(from: string, to: string): InterruptionStats {
  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(interruptions), 0) AS total FROM sessions
        WHERE kind = 'focus' AND local_day BETWEEN ? AND ?`,
    )
    .get(from, to) as { total: number };
  const given = db
    .prepare(
      `SELECT reason, COUNT(*) AS n FROM (
         SELECT i.reason AS reason,
                ROW_NUMBER() OVER (PARTITION BY i.session_id ORDER BY i.id) AS nth,
                s.interruptions AS counted
         FROM interruptions i
         JOIN sessions s ON s.id = i.session_id
         WHERE s.kind = 'focus' AND s.local_day BETWEEN ? AND ?
       )
       WHERE nth <= counted AND reason IS NOT NULL
       GROUP BY reason`,
    )
    .all(from, to) as { reason: InterruptionReason; n: number }[];
  const counts = new Map(given.map((r) => [r.reason, r.n]));
  // Walked in the order the reasons are listed in, and the sort keeps ties in that order, so
  // two reasons with the same count always come out the same way round.
  const byReason = INTERRUPTION_REASONS.map((r) => ({
    reason: r.key,
    label: r.label,
    count: counts.get(r.key) ?? 0,
  }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const named = byReason.reduce((sum, r) => sum + r.count, 0);
  return { from, to, total, byReason, unspecified: total - named };
}

/* ---------------------------------------------------------------- estimates */

/** How a kind of estimate has held up: how many there are, and how far off the middle one was. */
export interface Accuracy {
  count: number;
  /**
   * The median of actual / estimate, so 1.5 is half as long again as the guess and 0.8 is
   * a fifth under it. Null with fewer than three: the middle of one or two numbers says
   * nothing about how you usually guess.
   */
  medianRatio: number | null;
}

export interface EstimateStats {
  from: string;
  to: string;
  /** Finished focus blocks that were given an estimate. */
  blocks: Accuracy;
  /** Completed tasks that were given an estimate and had focus time logged on them. */
  tasks: Accuracy;
  /** The same two, for each project that has either. "No project" is the entry with a null id. */
  byProject: {
    projectId: number | null;
    name: string;
    color: string;
    blocks: Accuracy;
    tasks: Accuracy;
  }[];
}

const MIN_FOR_A_MEDIAN = 3;

function accuracy(ratios: number[]): Accuracy {
  const sorted = [...ratios].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // With an even number the middle is between two: halfway between them.
  const medianRatio =
    sorted.length < MIN_FOR_A_MEDIAN
      ? null
      : sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { count: sorted.length, medianRatio };
}

interface EstimateRow {
  project_id: number | null;
  project_name: string | null;
  project_color: string | null;
  estimated_minutes: number;
  actual_seconds: number;
}

/**
 * Your guesses set against what the work took, over a window of days.
 *
 * A block counts when it is a focus block that was completed (a discarded block says
 * nothing about how long the work takes, and a break is not work), has an estimate, and
 * was worked on a day in the window; its actual is its active seconds. A task counts when
 * it is completed on a day in the window, has an estimate, and has focus time logged on
 * it, counted by the same rule the Tasks tab uses for its Logged column (LOGGED_ON_TASKS):
 * one with an estimate and no time logged has no actual to compare. Each is a ratio of
 * actual to estimate, and a bucket's figure is the median of its ratios: one marathon
 * block cannot drag a typical guess far, as it would an average.
 *
 * A block is filed under the project of the block and a task under the project of the
 * task, which can differ, since a block can be billed elsewhere than the task it is on.
 */
export function estimateStats(from: string, to: string): EstimateStats {
  const blockRows = db
    .prepare(
      `SELECT s.project_id, p.name AS project_name, p.color AS project_color,
              s.estimated_minutes, s.active_seconds AS actual_seconds
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.kind = 'focus' AND s.status = 'completed' AND s.estimated_minutes IS NOT NULL
         AND s.local_day BETWEEN ? AND ?`,
    )
    .all(from, to) as EstimateRow[];
  const taskRows = db
    .prepare(
      `SELECT t.project_id, p.name AS project_name, p.color AS project_color,
              t.estimated_minutes, w.logged_seconds AS actual_seconds
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       JOIN (${LOGGED_ON_TASKS}) w ON w.task_id = t.id
       WHERE t.status = 'completed' AND t.estimated_minutes IS NOT NULL
         AND t.completed_on BETWEEN ? AND ? AND w.logged_seconds > 0`,
    )
    .all(from, to) as EstimateRow[];

  const ratio = (r: EstimateRow) => r.actual_seconds / (r.estimated_minutes * 60);
  const projects = new Map<
    number | null,
    { name: string; color: string; blocks: number[]; tasks: number[] }
  >();
  const pileOf = (r: EstimateRow) => {
    let pile = projects.get(r.project_id);
    if (!pile) {
      pile = {
        name: r.project_name ?? 'No project',
        color: r.project_color ?? UNASSIGNED.color,
        blocks: [],
        tasks: [],
      };
      projects.set(r.project_id, pile);
    }
    return pile;
  };
  for (const r of blockRows) pileOf(r).blocks.push(ratio(r));
  for (const r of taskRows) pileOf(r).tasks.push(ratio(r));

  const byProject = [...projects].map(([projectId, p]) => ({
    projectId,
    name: p.name,
    color: p.color,
    blocks: accuracy(p.blocks),
    tasks: accuracy(p.tasks),
  }));
  // The projects with the most to go on first, "No project" behind the named ones on a tie.
  byProject.sort(
    (a, b) =>
      b.blocks.count + b.tasks.count - (a.blocks.count + a.tasks.count) ||
      Number(a.projectId == null) - Number(b.projectId == null) ||
      a.name.localeCompare(b.name),
  );

  return {
    from,
    to,
    blocks: accuracy(blockRows.map(ratio)),
    tasks: accuracy(taskRows.map(ratio)),
    byProject,
  };
}
