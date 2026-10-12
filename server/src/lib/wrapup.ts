import { db } from '../db.js';
import { listSessions, type SessionView } from './sessions.js';
import { today } from './settings.js';
import type { ProjectSlice } from './stats.js';
import { listTasks, type TaskStatus, type TaskView } from './tasks.js';
import { addDays, dayRange, nowIso, weekStart } from './time.js';

/**
 * The end-of-day wrap-up and the Monday review: what a day or a week came to, read
 * back at the moment someone sits down to close it out, plus the one line they leave
 * for what comes next.
 *
 * Every total here is built from the blocks as `toView` reads them, not from the stored
 * active_seconds that dayStats and rangeStats add up. A block on the clock only has its
 * time flushed to that column when it is paused or stopped, so stats count it as nothing
 * until then. A wrap-up is read at the end of the day, quite possibly with the last
 * block still running, and a summary that left it out would come up short by exactly the
 * work just done. `toView` has the live elapsed time, so the numbers here include it.
 */

/**
 * listSessions stops at 500 blocks unless told otherwise. A day or a week never comes
 * near that, but a cap that silently cut a total short would be worse than a big one.
 */
const EVERY_BLOCK = 10_000;

/** Same as stats.ts, which keeps its own copy: a block with no project is "Unassigned". */
const UNASSIGNED = { name: 'Unassigned', color: '#94a3b8' };

/**
 * The blocks that count as focused work, oldest first: focus blocks that were not
 * discarded. A break is rest and an abandoned block was thrown away, so neither is time
 * on the page. A block still on the clock is in, with its elapsed time read live.
 */
function focusBlocks(range: { day: string } | { from: string; to: string }): SessionView[] {
  return listSessions({ ...range, kind: 'focus', limit: EVERY_BLOCK })
    .filter((s) => s.status !== 'abandoned')
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id - b.id);
}

/** One decimal place, like the other screens' averages. Null when there is nothing to average. */
function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function totals(blocks: SessionView[]) {
  return {
    focusSeconds: blocks.reduce((sum, s) => sum + s.elapsedSeconds, 0),
    blocks: blocks.length,
    avgFocusRating: average(blocks.map((s) => s.focusRating).filter((r): r is number => r != null)),
  };
}

/**
 * Time per project, biggest first, in the shape DayStats uses so the same charts read
 * it. stats.ts builds its rollup from stored rows, whose time is short for a block still
 * on the clock (see the top of this file); this one adds up the views, which are not.
 * `blocks` arrives oldest first, so projects with equal time keep the order they began in.
 */
function rollupProjects(blocks: SessionView[]): ProjectSlice[] {
  const slices = new Map<string, ProjectSlice & { scores: number[] }>();
  for (const s of blocks) {
    const key = String(s.projectId ?? 'none');
    let slice = slices.get(key);
    if (!slice) {
      slice = {
        projectId: s.projectId,
        name: s.projectName ?? UNASSIGNED.name,
        color: s.projectColor ?? UNASSIGNED.color,
        seconds: 0,
        blocks: 0,
        avgFocusScore: null,
        share: 0,
        scores: [],
      };
      slices.set(key, slice);
    }
    slice.seconds += s.elapsedSeconds;
    slice.blocks += 1;
    if (s.focusScore != null) slice.scores.push(s.focusScore);
  }
  const total = [...slices.values()].reduce((a, s) => a + s.seconds, 0) || 1;
  return [...slices.values()]
    .map(({ scores, ...s }) => ({
      ...s,
      avgFocusScore: average(scores),
      share: Math.round((s.seconds / total) * 1000) / 10,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** What the blocks put on each task they were the work on, a block on the clock included. */
function secondsByTask(blocks: SessionView[]): Map<number, number> {
  const seconds = new Map<number, number>();
  for (const s of blocks) {
    if (s.taskId != null) seconds.set(s.taskId, (seconds.get(s.taskId) ?? 0) + s.elapsedSeconds);
  }
  return seconds;
}

/** A note is what is left after trimming, and nothing at all when that is nothing. */
function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

/* ---------------------------------------------------------------------- day */

export interface WrapUpDayTask {
  id: number;
  title: string;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  status: TaskStatus;
  estimatedMinutes: number | null;
  /** What the day's blocks put on it, the one on the clock included. */
  secondsToday: number;
  /** Everything logged on it, ever, so it can be read against its estimate. */
  loggedSeconds: number;
}

export interface WrapUpDay {
  day: string;
  focusSeconds: number;
  blocks: number;
  avgFocusRating: number | null;
  byProject: ProjectSlice[];
  /** The day's focus blocks, oldest first, the one on the clock included with its live time. */
  sessions: SessionView[];
  /** Finished focus blocks nobody has rated yet. A block still running is rated when it ends. */
  unrated: number[];
  /** Every task a block worked on, most time first. */
  tasks: WrapUpDayTask[];
  note: string | null;
  wrappedUpAt: string | null;
  /** The latest earlier day that has a note, so a wrap-up can open with what you meant to do. */
  previous: { day: string; note: string } | null;
}

export function dayView(day: string): WrapUpDay {
  const blocks = focusBlocks({ day });
  const row = db.prepare('SELECT note, wrapped_up_at FROM day_notes WHERE day = ?').get(day) as
    | { note: string | null; wrapped_up_at: string | null }
    | undefined;
  // A day that was only wrapped up, or whose note was cleared, has a row and no note.
  const previous = db
    .prepare(
      `SELECT day, note FROM day_notes
        WHERE day < ? AND note IS NOT NULL
        ORDER BY day DESC LIMIT 1`,
    )
    .get(day) as { day: string; note: string } | undefined;

  const seconds = secondsByTask(blocks);
  const tasks = (seconds.size ? listTasks({ view: 'all' }) : [])
    .filter((t) => seconds.has(t.id))
    .map(
      (t): WrapUpDayTask => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        projectName: t.projectName,
        projectColor: t.projectColor,
        status: t.status,
        estimatedMinutes: t.estimatedMinutes,
        secondsToday: seconds.get(t.id) ?? 0,
        loggedSeconds: t.loggedSeconds,
      }),
    )
    .sort((a, b) => b.secondsToday - a.secondsToday || a.id - b.id);

  return {
    day,
    ...totals(blocks),
    byProject: rollupProjects(blocks),
    sessions: blocks,
    unrated: blocks
      .filter((s) => s.status === 'completed' && s.focusRating == null)
      .map((s) => s.id),
    tasks,
    note: row?.note ?? null,
    wrappedUpAt: row?.wrapped_up_at ?? null,
    previous: previous ?? null,
  };
}

/**
 * Blank clears it. The row stays either way: "done" lives on it too, and editing the
 * note must not undo that.
 */
export function setDayNote(day: string, note: string | null): WrapUpDay {
  db.prepare(
    `INSERT INTO day_notes (day, note, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(day, cleanNote(note), nowIso());
  return dayView(day);
}

/**
 * Stamp the day as wrapped up. Pressing it again is not wrapping up again: the first
 * stamp is the one that stays, so the time on screen is when you actually finished.
 */
export function finishDay(day: string): WrapUpDay {
  const now = nowIso();
  db.prepare(
    `INSERT INTO day_notes (day, wrapped_up_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET wrapped_up_at = excluded.wrapped_up_at,
                                    updated_at = excluded.updated_at
     WHERE day_notes.wrapped_up_at IS NULL`,
  ).run(day, now, now);
  return dayView(day);
}

/** Whether "Done for the day" has been pressed. What a reminder asks before it nags. */
export function isDayWrappedUp(day: string): boolean {
  const row = db.prepare('SELECT wrapped_up_at FROM day_notes WHERE day = ?').get(day) as
    | { wrapped_up_at: string | null }
    | undefined;
  return row?.wrapped_up_at != null;
}

/* --------------------------------------------------------------------- week */

export interface WrapUpWeekTask {
  id: number;
  title: string;
  projectName: string | null;
  projectColor: string | null;
  status: TaskStatus;
  estimatedMinutes: number | null;
  /** What the week's blocks put on it. Zero for a task that is listed for another reason. */
  secondsThisWeek: number;
  /** Everything logged on it, ever, so it can be read against its estimate. */
  loggedSeconds: number;
  completedOn: string | null;
}

export interface WrapUpWeek {
  /** The Monday that names the week, whichever day of it was asked for. */
  week: string;
  from: string;
  to: string;
  focusSeconds: number;
  /** Days with focus time on them. */
  activeDays: number;
  blocks: number;
  avgFocusRating: number | null;
  /** Monday to Sunday, every day there whether or not it had any work. */
  days: { day: string; focusSeconds: number; blocks: number }[];
  byProject: ProjectSlice[];
  /** Every task a block worked on this week, most time first. */
  tasks: WrapUpWeekTask[];
  /** Tasks finished this week, in the order they were finished. */
  completed: WrapUpWeekTask[];
  /** Tasks from this week's sheet that are still not done: where a carry-over starts. */
  unfinished: WrapUpWeekTask[];
  note: string | null;
  reviewedAt: string | null;
}

/** Any day of a week names it; with no day at all it is the week the user is in. */
export function weekView(anyDay: string = today()): WrapUpWeek {
  const week = weekStart(anyDay);
  const from = week;
  const to = addDays(week, 6);
  const blocks = focusBlocks({ from, to });

  const perDay = new Map<string, { focusSeconds: number; blocks: number }>();
  for (const s of blocks) {
    const sum = perDay.get(s.day) ?? { focusSeconds: 0, blocks: 0 };
    sum.focusSeconds += s.elapsedSeconds;
    sum.blocks += 1;
    perDay.set(s.day, sum);
  }
  const days = dayRange(from, to).map((day) => ({
    day,
    focusSeconds: perDay.get(day)?.focusSeconds ?? 0,
    blocks: perDay.get(day)?.blocks ?? 0,
  }));

  const seconds = secondsByTask(blocks);
  const entry = (t: TaskView): WrapUpWeekTask => ({
    id: t.id,
    title: t.title,
    projectName: t.projectName,
    projectColor: t.projectColor,
    status: t.status,
    estimatedMinutes: t.estimatedMinutes,
    secondsThisWeek: seconds.get(t.id) ?? 0,
    loggedSeconds: t.loggedSeconds,
    completedOn: t.completedOn,
  });

  // Plain YYYY-MM-DD days, so a string comparison is a date comparison.
  const inWeek = (day: string | null) => day != null && day >= from && day <= to;
  const every = listTasks({ view: 'all' });
  const row = db.prepare('SELECT note, reviewed_at FROM week_reviews WHERE week = ?').get(week) as
    | { note: string | null; reviewed_at: string | null }
    | undefined;

  return {
    week,
    from,
    to,
    ...totals(blocks),
    activeDays: days.filter((d) => d.focusSeconds > 0).length,
    days,
    byProject: rollupProjects(blocks),
    tasks: every
      .filter((t) => seconds.has(t.id))
      .map(entry)
      .sort((a, b) => b.secondsThisWeek - a.secondsThisWeek || a.id - b.id),
    completed: every
      .filter((t) => t.status === 'completed' && inWeek(t.completedOn))
      .map(entry)
      .sort((a, b) => (a.completedOn ?? '').localeCompare(b.completedOn ?? '') || a.id - b.id),
    // The week a task belongs to is the task view's to say (`weekOf`): how that is arrived
    // at is the Tasks tab's business, and working it out again here from the day it was
    // added would quietly disagree with that screen the moment the two rules differ.
    unfinished: every.filter((t) => t.status !== 'completed' && t.weekOf === week).map(entry),
    note: row?.note ?? null,
    reviewedAt: row?.reviewed_at ?? null,
  };
}

/** Any day of the week will do: the review is filed under the Monday that names it. */
export function setWeekNote(anyDay: string, note: string | null): WrapUpWeek {
  const week = weekStart(anyDay);
  db.prepare(
    `INSERT INTO week_reviews (week, note, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(week, cleanNote(note), nowIso());
  return weekView(week);
}

/** As for a day: the first stamp stays. */
export function finishWeek(anyDay: string): WrapUpWeek {
  const week = weekStart(anyDay);
  const now = nowIso();
  db.prepare(
    `INSERT INTO week_reviews (week, reviewed_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET reviewed_at = excluded.reviewed_at,
                                     updated_at = excluded.updated_at
     WHERE week_reviews.reviewed_at IS NULL`,
  ).run(week, now, now);
  return weekView(week);
}

/** Whether the week has been marked reviewed. Any day of the week names it. */
export function isWeekReviewed(anyDay: string): boolean {
  const row = db
    .prepare('SELECT reviewed_at FROM week_reviews WHERE week = ?')
    .get(weekStart(anyDay)) as { reviewed_at: string | null } | undefined;
  return row?.reviewed_at != null;
}
