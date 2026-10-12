/**
 * What the menu-bar item says: the clock, the dot that says something is waiting, and the
 * tooltip. Nothing here touches Electron (the block on the clock and how many questions are
 * waiting are handed in, and the words are handed back), so what a person reads can be tested
 * without a menu bar to look at.
 */

/** The dot before the clock while something is waiting for an answer: seen without being read. */
export const WAITING_MARK = '•';

/** Seconds as a clock: 04:05, and 1:02:03 from an hour on. Never negative, and never "NaN". */
export function formatClock(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * How long the block on the clock has run, as of `now` (epoch milliseconds). The server owns the
 * clock and is asked every few seconds, so between two asks a running block is taken to have
 * gone on at the rate of the clock; a paused one stands still, and a clock that has been set
 * back does not take time off it.
 *
 * @param {{ session: { status: string } | null, elapsedAtPoll: number, polledAt: number }} live
 *   The block as last read, the seconds it had run then, and when that was.
 * @param {number} now
 */
export function elapsedSeconds({ session, elapsedAtPoll, polledAt }, now) {
  if (!session) return 0;
  if (session.status !== 'running') return elapsedAtPoll;
  return elapsedAtPoll + Math.max(0, (now - polledAt) / 1000);
}

/**
 * The words of the menu-bar item: its title (what is beside the icon) and its tooltip.
 *
 * A stopwatch has no planned time, so there is nothing to count down to and nothing to run over:
 * it counts up, unsigned. A Pomodoro counts down, and past its end it counts up with a plus. A
 * paused block says so with ||. The dot comes before the clock, and without a clock it stands
 * alone; the tooltip says in words how many questions are waiting.
 *
 * @param {object} what
 * @param {{ title: string, projectName?: string | null, plannedSeconds?: number | null, status: string } | null} what.session
 * @param {number} what.elapsed Seconds the block has run (see elapsedSeconds).
 * @param {number} what.waiting How many questions are waiting for an answer.
 * @returns {{ title: string, toolTip: string }}
 */
export function menuBarText({ session, elapsed, waiting }) {
  const mark = waiting > 0 ? WAITING_MARK : '';
  const needs =
    waiting > 0
      ? `\n${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} your attention`
      : '';

  if (!session) return { title: mark, toolTip: `FocusDesk - nothing running${needs}` };

  const stopwatch = session.plannedSeconds == null;
  let label;
  if (stopwatch) {
    label = formatClock(elapsed);
  } else {
    const remaining = session.plannedSeconds - elapsed;
    label = remaining >= 0 ? formatClock(remaining) : `+${formatClock(-remaining)}`;
  }
  const project = session.projectName ?? 'No project';
  return {
    title:
      session.status === 'paused' ? `${mark ? `${mark} ` : ''}|| ${label}` : `${mark} ${label}`,
    toolTip:
      (stopwatch
        ? `${session.title}\n${project} · stopwatch ${label}`
        : `${session.title}\n${project} - ${label}`) + needs,
  };
}
