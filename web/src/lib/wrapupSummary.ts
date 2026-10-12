import type { TaskStatus } from '../api';
import type { WrapUpDay, WrapUpWeek } from '../wrapup';
import { duration } from './format';

/*
 * The text a wrap-up pastes into a chat. Plain functions of what the server said, with
 * nothing to import at run time but the plain `format.ts`, so the same code runs in the
 * browser and in the test suite, which loads this file by its path (the web app has no
 * test runner of its own).
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_WORDS: Record<TaskStatus, string> = {
  not_started: 'not started',
  in_progress: 'in progress',
  held_up: 'held up',
  completed: 'completed',
};

/**
 * How long, the way every other screen says it: "1h 25m", "45m", "2h", seconds under a
 * minute, and 0m for nothing. It is `duration`, the one every screen uses and not a copy of
 * it, so a figure in the pasted summary cannot read differently from the same figure on the
 * page (two copies of the rule did, once: one said 1h 60m for 1h 59m 40s).
 */
export const span = (seconds: number): string => duration(seconds);

/**
 * "Mon Oct 12", spelled the same whatever the viewer's locale: this is pasted into
 * somebody else's chat, where "lun. 12 oct." would be the odd one out.
 */
export function shortDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Where a task has got to: what is logged, against its estimate when it has one. */
function progress(loggedSeconds: number, estimatedMinutes: number | null): string {
  return estimatedMinutes == null
    ? `${span(loggedSeconds)} logged`
    : `${span(loggedSeconds)} of ${span(estimatedMinutes * 60)}`;
}

interface TaskLike {
  title: string;
  status: TaskStatus;
  estimatedMinutes: number | null;
  loggedSeconds: number;
}

/** "Building the status page — 2h 30m of 3h (in progress)". Nothing logged and no estimate has no figures. */
function taskPhrase(t: TaskLike): string {
  const status = STATUS_WORDS[t.status];
  if (t.loggedSeconds === 0 && t.estimatedMinutes == null) return `${t.title} (${status})`;
  return `${t.title} — ${progress(t.loggedSeconds, t.estimatedMinutes)} (${status})`;
}

const projectLabel = (p: { projectId: number | null; name: string }) =>
  p.projectId == null ? 'No project' : p.name;

/**
 * What a project's blocks were, biggest first. Blocks with the same title are one piece
 * of work done in several sittings, so they are added together, not listed three times.
 */
function worked(blocks: { title: string; elapsedSeconds: number }[]): string {
  const byTitle = new Map<string, number>();
  for (const b of blocks) byTitle.set(b.title, (byTitle.get(b.title) ?? 0) + b.elapsedSeconds);
  return [...byTitle]
    .sort((a, b) => b[1] - a[1])
    .map(([title, seconds]) => `${title} (${span(seconds)})`)
    .join(', ');
}

/**
 * The day, in a few lines that read the same pasted into Slack or an email:
 *   Mon Oct 12 — 5h 20m focused, 7 blocks, focus 3.9/5
 *   • ROI Dashboard 3h 10m: Competitor demo teardown (45m), …
 *   • No project 40m: …
 *   Tasks: Building the ROI Current Status — 2h 30m of 3h (in progress)
 *   Tomorrow: <note>
 * `note` is what is in the Tomorrow box right now, saved or not, so what is copied is
 * what is on the screen. A day with nothing logged says so instead of printing zeros.
 */
export function daySummary(view: WrapUpDay, note: string | null): string {
  const lines: string[] = [];
  if (view.blocks === 0) {
    lines.push(`${shortDate(view.day)} — Nothing logged yet`);
  } else {
    const parts = [`${span(view.focusSeconds)} focused`, plural(view.blocks, 'block')];
    if (view.avgFocusRating != null) parts.push(`focus ${view.avgFocusRating}/5`);
    lines.push(`${shortDate(view.day)} — ${parts.join(', ')}`);
    for (const p of view.byProject) {
      const blocks = view.sessions.filter((s) => s.projectId === p.projectId);
      lines.push(`• ${projectLabel(p)} ${span(p.seconds)}: ${worked(blocks)}`);
    }
  }
  if (view.tasks.length) lines.push(`Tasks: ${view.tasks.map(taskPhrase).join('; ')}`);
  if (note) lines.push(`Tomorrow: ${note}`);
  return lines.join('\n');
}

/** A task as the week saw it: this week's time first, then where it stands overall. */
function weekTaskPhrase(t: TaskLike & { secondsThisWeek: number }): string {
  const status = STATUS_WORDS[t.status];
  const all =
    t.estimatedMinutes == null && t.loggedSeconds === t.secondsThisWeek
      ? ''
      : `, ${progress(t.loggedSeconds, t.estimatedMinutes)}`;
  return `${t.title} — ${span(t.secondsThisWeek)} this week${all} (${status})`;
}

/**
 * The week, for the Monday message:
 *   Week of Mon Oct 5 — 18h 40m focused over 5 days, 24 blocks, focus 3.8/5
 *   • ROI Dashboard 9h 10m
 *   Worked on: …
 *   Completed: Tickets view (Wed); …
 *   Unfinished: Pricing memo — 1h of 3h (in progress); …
 *   Next week: <note>
 * A line with nothing to say is left out. `note` is the Next week box as it is now.
 */
export function weekSummary(view: WrapUpWeek, note: string | null): string {
  const lines: string[] = [];
  const head = `Week of ${shortDate(view.from)}`;
  if (view.blocks === 0) {
    lines.push(`${head} — Nothing logged yet`);
  } else {
    const parts = [
      `${span(view.focusSeconds)} focused over ${plural(view.activeDays, 'day')}`,
      plural(view.blocks, 'block'),
    ];
    if (view.avgFocusRating != null) parts.push(`focus ${view.avgFocusRating}/5`);
    lines.push(`${head} — ${parts.join(', ')}`);
    for (const p of view.byProject) lines.push(`• ${projectLabel(p)} ${span(p.seconds)}`);
  }
  if (view.tasks.length) lines.push(`Worked on: ${view.tasks.map(weekTaskPhrase).join('; ')}`);
  if (view.completed.length) {
    const done = view.completed.map((t) =>
      t.completedOn ? `${t.title} (${weekdayOf(t.completedOn)})` : t.title,
    );
    lines.push(`Completed: ${done.join('; ')}`);
  }
  if (view.unfinished.length)
    lines.push(`Unfinished: ${view.unfinished.map(taskPhrase).join('; ')}`);
  if (note) lines.push(`Next week: ${note}`);
  return lines.join('\n');
}
