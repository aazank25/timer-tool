import { db } from '../db.js';
import { badRequest, conflict } from './http.js';
import { minutesShort, quoted } from './prompt-text.js';
import { promptState, promptStates, setPromptState, type PromptState } from './prompt-state.js';
import type { PromptAction, PromptProvider } from './prompts.js';
import { gapsIn, toSpans, type Span } from './segments.js';
import {
  liveSessionRow,
  logManualSession,
  pauseSession,
  resumeSession,
  type SessionRow,
} from './sessions.js';
import { getSetting } from './settings.js';

/**
 * Meetings from the synced calendar, as two prompts. When one starts while a block is
 * running, it offers to pause the block; when one ends, it offers to log the time and to
 * pick the block back up. Both are worked out from the events and the blocks as they are
 * now, so a prompt goes away by itself the moment there is nothing left to offer, and a
 * note in prompt_state covers the rest: what was dismissed, and which block was paused.
 */

/** A meeting that began longer ago than this is one you are already in, so pausing is moot. */
const START_WINDOW_MS = 15 * 60_000;
/** A meeting that ended longer ago than this is too old to be asked about. */
const END_WINDOW_MS = 60 * 60_000;
/** The longest block a person can log by hand, which is as long as a meeting is logged. */
const MAX_LOG_SECONDS = 12 * 60 * 60;
/** Less than this is not worth a block of its own. */
const MIN_LOG_MS = 60_000;

interface EventRow {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  project_id: number | null;
  project_name: string | null;
}

const EVENT = `
  SELECT e.id, e.title, e.starts_at, e.ends_at, e.project_id, p.name AS project_name
  FROM calendar_events e LEFT JOIN projects p ON p.id = e.project_id`;

const iso = (ms: number) => new Date(ms).toISOString();
const meetingPromptsOn = () => getSetting('meeting_prompts') === 'true';
const nameOf = (e: EventRow) => (e.title ?? '').trim() || '(untitled)';

/**
 * What is written down about a meeting when its start prompt or its end prompt is handled.
 * It is kept under the meeting and not under the block the start prompt named, so that
 * dismissing it dismisses it for the meeting, whichever block is on the clock.
 */
const startKey = (eventId: string) => `meeting-start:${eventId}`;
const endKey = (eventId: string) => `meeting-end:${eventId}`;

/**
 * Timed events that began no longer ago than the start window and have not ended: every
 * event the start prompt could be about. The bounds are loose and in SQL only to keep the
 * read small; the prompt then checks the instants properly.
 */
function startedEvents(now: Date): EventRow[] {
  const t = now.getTime();
  return db
    .prepare(
      `${EVENT} WHERE e.all_day = 0 AND e.starts_at >= ? AND e.starts_at <= ? AND e.ends_at >= ?`,
    )
    .all(iso(t - START_WINDOW_MS - 60_000), iso(t + 60_000), iso(t - 60_000)) as EventRow[];
}

/** Timed events that ended no longer ago than the end window, loosely, as above. */
function endedEvents(now: Date): EventRow[] {
  const t = now.getTime();
  return db
    .prepare(`${EVENT} WHERE e.all_day = 0 AND e.ends_at >= ? AND e.ends_at <= ?`)
    .all(iso(t - END_WINDOW_MS - 60_000), iso(t + 60_000)) as EventRow[];
}

/** Which of these meetings have time logged on them, by a block linked to them that was not thrown away. */
function loggedAmong(eventIds: string[]): Set<string> {
  const logged = new Set<string>();
  // Few enough at a time to stay inside what one statement can be given.
  for (let at = 0; at < eventIds.length; at += 500) {
    const chunk = eventIds.slice(at, at + 500);
    const rows = db
      .prepare(
        `SELECT DISTINCT calendar_event_id AS id FROM sessions
         WHERE status <> 'abandoned' AND calendar_event_id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as { id: string }[];
    for (const row of rows) logged.add(row.id);
  }
  return logged;
}

const isLogged = (eventId: string): boolean => loggedAmong([eventId]).has(eventId);

/**
 * The block that was paused for a meeting, if it is still paused, given the note its start
 * prompt wrote down when it paused it. The block's start time is in the note with its id
 * because the id of a deleted block can be given to a new one.
 */
function pausedFor(note: PromptState | null | undefined): SessionRow | undefined {
  if (note?.status !== 'done' || typeof note.data?.sessionId !== 'number') return undefined;
  const block = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND status = 'paused'")
    .get(note.data.sessionId) as SessionRow | undefined;
  return block && block.started_at === note.data.startedAt ? block : undefined;
}

const pausedForMeeting = (eventId: string) => pausedFor(promptState(startKey(eventId)));

/** When the clock last started running, which is when a running block began to be in the way. */
function runningSince(block: SessionRow): string {
  const open = db
    .prepare(
      'SELECT started_at FROM session_segments WHERE session_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(block.id) as { started_at: string } | undefined;
  return open?.started_at ?? block.started_at;
}

export const meetingStartProvider: PromptProvider = {
  kind: 'meeting-start',
  actionIds: ['pause', 'dismiss'],

  list(now) {
    if (!meetingPromptsOn()) return [];
    const block = liveSessionRow();
    if (!block || block.status !== 'running' || block.kind !== 'focus') return [];
    const since = Date.parse(runningSince(block));
    const t = now.getTime();

    const begun = startedEvents(now).filter((e) => {
      const starts = Date.parse(e.starts_at);
      return (
        starts <= t &&
        t - starts <= START_WINDOW_MS &&
        t < Date.parse(e.ends_at) &&
        // A block that is the time spent on this very meeting is not in its way.
        block.calendar_event_id !== e.id
      );
    });
    const handled = promptStates(begun.map((e) => startKey(e.id)));

    return begun
      .filter((e) => !handled.has(startKey(e.id)))
      .map((e) => ({
        // The block is in the id: "Pause Deep work?" must not pause whatever is on the clock
        // by the time it is answered.
        id: `${startKey(e.id)}:${block.id}`,
        kind: 'meeting-start',
        title: `${nameOf(e)} has started`,
        body: `Pause ${quoted(block.title)} for it?`,
        // It was not due until both were true: the meeting had begun and the clock was running.
        createdAt: iso(Math.max(Date.parse(e.starts_at), since)),
        actions: [
          { id: 'pause', label: 'Pause block', primary: true },
          { id: 'dismiss', label: 'Dismiss' },
        ],
      }));
  },

  act(id, action) {
    // meeting-start:<event>:<block>. An event's id has colons of its own, so the block is
    // what comes after the last one.
    const rest = id.slice('meeting-start:'.length);
    const cut = rest.lastIndexOf(':');
    const eventId = rest.slice(0, cut);
    const blockId = Number(rest.slice(cut + 1));
    if (cut < 1 || !Number.isInteger(blockId)) throw conflict('That prompt is no longer current');

    if (action === 'dismiss') {
      setPromptState(startKey(eventId), 'dismissed');
    } else if (action === 'pause') {
      // Only the block the prompt named is paused for it.
      const block = liveSessionRow();
      if (!block || block.id !== blockId || block.status !== 'running') {
        throw conflict('That prompt is no longer current');
      }
      pauseSession(block.id);
      setPromptState(startKey(eventId), 'done', {
        sessionId: block.id,
        startedAt: block.started_at,
      });
    } else {
      throw badRequest(`Unknown action: ${action}`);
    }
  },
};

/** The stretch a meeting is logged over: what was scheduled, and at least a minute of it. */
function windowOf(e: EventRow): { from: number; to: number } {
  const from = Date.parse(e.starts_at);
  return { from, to: Math.max(Date.parse(e.ends_at), from + MIN_LOG_MS) };
}

/**
 * The runs of every focus block that was not thrown away, near the stretch from `from` to
 * `to`: what the meetings in it have to be set against. The bounds in SQL are a day wider
 * each way, because the times of a block logged by hand can carry an offset and so do not
 * sort as instants; they are compared exactly afterwards.
 */
function focusRuns(from: number, to: number): Span[] {
  const day = 86_400_000;
  return toSpans(
    db
      .prepare(
        `SELECT g.started_at, g.ended_at
         FROM sessions s JOIN session_segments g ON g.session_id = s.id
         WHERE s.kind = 'focus' AND s.status <> 'abandoned'
           AND s.started_at <= ? AND (s.ended_at IS NULL OR s.ended_at >= ?)
           AND g.started_at <= ? AND (g.ended_at IS NULL OR g.ended_at >= ?)`,
      )
      .all(iso(to + day), iso(from - day), iso(to + day), iso(from - day)) as {
      started_at: string;
      ended_at: string | null;
    }[],
  );
}

/**
 * What logging a meeting would add: the part of its scheduled time that no focus block was
 * ticking through, as the first instant of it and how long all of it comes to. Time that is
 * on a block already is not counted a second time, so a block that ran through the first 14
 * minutes of a meeting leaves the other 16 to log, and one that ran all through it leaves
 * nothing. Never more than a block can be, and null when less than a minute is left.
 */
function uncounted(
  e: EventRow,
  runs: Span[],
  now: number,
): { startsAt: number; seconds: number } | null {
  const { from, to } = windowOf(e);
  const near = runs.filter((s) => s.start < to && (s.end ?? now) > from);
  const gaps = gapsIn(near, from, to, now);
  const first = gaps[0];
  const ms = gaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  if (!first || ms < MIN_LOG_MS) return null;
  return { startsAt: first.start, seconds: Math.min(MAX_LOG_SECONDS, Math.round(ms / 1000)) };
}

/** The length of the part to log, as the buttons and the question say it: "16m". */
const lengthOf = (part: { seconds: number }) => minutesShort(Math.round(part.seconds / 60));

/**
 * Log the meeting as a finished block, unless time is logged on it already. It holds only
 * the time that is not on a block already, from the first moment of it.
 */
function logMeeting(e: EventRow, now: Date): void {
  if (isLogged(e.id)) return;
  const { from, to } = windowOf(e);
  const part = uncounted(e, focusRuns(from, to), now.getTime());
  // Everything it scheduled is on other blocks, so there is nothing to add.
  if (!part) return;
  logManualSession({
    projectId: e.project_id,
    title: nameOf(e).slice(0, 300),
    startedAt: iso(part.startsAt),
    minutes: part.seconds / 60,
    calendarEventId: e.id,
  });
}

function resumePaused(eventId: string): void {
  const paused = pausedForMeeting(eventId);
  if (paused) resumeSession(paused.id);
}

export const meetingEndProvider: PromptProvider = {
  kind: 'meeting-end',
  actionIds: ['log-resume', 'log', 'resume', 'dismiss'],

  list(now) {
    if (!meetingPromptsOn()) return [];
    const t = now.getTime();

    const ended = endedEvents(now).filter((e) => {
      const at = Date.parse(e.ends_at);
      return at <= t && t - at <= END_WINDOW_MS;
    });
    const answered = promptStates(ended.map((e) => endKey(e.id)));
    const open = ended.filter((e) => !answered.has(endKey(e.id)));
    if (!open.length) return [];

    const logged = loggedAmong(open.map((e) => e.id));
    const started = promptStates(open.map((e) => startKey(e.id)));
    // Read once for all of them, from the first moment of the earliest to the end of the last.
    const toLog = open.filter((e) => !logged.has(e.id));
    const runs = toLog.length
      ? focusRuns(
          Math.min(...toLog.map((e) => windowOf(e).from)),
          Math.max(...toLog.map((e) => windowOf(e).to)),
        )
      : [];

    return open.flatMap((e) => {
      const paused = pausedFor(started.get(startKey(e.id)));
      const part = logged.has(e.id) ? null : uncounted(e, runs, t);
      // Nothing to log (it is logged, or all of it is on other blocks) and nothing to pick
      // back up: there is nothing to ask.
      if (!part && !paused) return [];

      const dismiss: PromptAction = { id: 'dismiss', label: 'Dismiss' };
      let body: string;
      let actions: PromptAction[];
      if (part) {
        const length = lengthOf(part);
        const log: PromptAction = {
          id: 'log',
          label: e.project_name ? `Log ${length} under ${e.project_name}` : `Log ${length}`,
        };
        if (paused) {
          body = `Log the ${length} and resume ${quoted(paused.title)}?`;
          actions = [
            { id: 'log-resume', label: `Log ${length} and resume`, primary: true },
            log,
            { id: 'resume', label: 'Resume' },
            dismiss,
          ];
        } else {
          body = `Log the ${length} as time spent?`;
          actions = [{ ...log, primary: true }, dismiss];
        }
      } else {
        body = `Resume ${quoted(paused!.title)}?`;
        actions = [{ id: 'resume', label: 'Resume', primary: true }, dismiss];
      }
      return [
        {
          id: endKey(e.id),
          kind: 'meeting-end',
          title: `${nameOf(e)} is over`,
          body,
          createdAt: iso(Date.parse(e.ends_at)),
          actions,
        },
      ];
    });
  },

  act(id, action, now) {
    const eventId = id.slice('meeting-end:'.length);
    const event = db.prepare(`${EVENT} WHERE e.id = ?`).get(eventId) as EventRow | undefined;
    if (!event) throw conflict('That prompt is no longer current');

    switch (action) {
      case 'dismiss':
        setPromptState(id, 'dismissed');
        return;
      case 'log':
        logMeeting(event, now);
        break;
      case 'resume':
        resumePaused(eventId);
        break;
      case 'log-resume':
        logMeeting(event, now);
        resumePaused(eventId);
        break;
      default:
        throw badRequest(`Unknown action: ${action}`);
    }
    // Once there is nothing left to offer it is finished for good, so deleting the log
    // afterwards on purpose does not bring the question back.
    if (isLogged(eventId) && !pausedForMeeting(eventId)) setPromptState(id, 'done');
  },
};
