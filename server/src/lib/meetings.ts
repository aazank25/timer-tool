import { db } from '../db.js';
import { badRequest, conflict } from './http.js';
import { minutesShort, quoted } from './prompt-text.js';
import { promptState, setPromptState } from './prompt-state.js';
import type { PromptAction, PromptProvider } from './prompts.js';
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
const MAX_LOG_MINUTES = 12 * 60;

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
 * Timed events that began before now and ended no longer ago than the end window: every
 * event either prompt could be about. The bounds are loose and in SQL only to keep the
 * read small; each prompt then checks the instants properly.
 */
function recentEvents(now: Date): EventRow[] {
  return db
    .prepare(`${EVENT} WHERE e.all_day = 0 AND e.ends_at >= ? AND e.starts_at <= ?`)
    .all(iso(now.getTime() - END_WINDOW_MS - 60_000), iso(now.getTime() + 60_000)) as EventRow[];
}

/** Whether time has been logged on the meeting, by a block linked to it that was not thrown away. */
function isLogged(eventId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sessions WHERE calendar_event_id = ? AND status <> 'abandoned' LIMIT 1")
    .get(eventId);
}

/**
 * The block that was paused for this meeting, if it is still paused. The start prompt wrote
 * its id down when it paused it; the block's start time goes with it because the id of a
 * deleted block can be given to a new one.
 */
function pausedFor(eventId: string): SessionRow | undefined {
  const note = promptState(`meeting-start:${eventId}`);
  if (note?.status !== 'done' || typeof note.data?.sessionId !== 'number') return undefined;
  const block = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND status = 'paused'")
    .get(note.data.sessionId) as SessionRow | undefined;
  return block && block.started_at === note.data.startedAt ? block : undefined;
}

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

  list(now) {
    if (!meetingPromptsOn()) return [];
    const block = liveSessionRow();
    if (!block || block.status !== 'running' || block.kind !== 'focus') return [];
    const since = Date.parse(runningSince(block));
    const t = now.getTime();

    return (
      recentEvents(now)
        .filter((e) => {
          const starts = Date.parse(e.starts_at);
          return starts <= t && t - starts <= START_WINDOW_MS && t < Date.parse(e.ends_at);
        })
        // A block that is the time spent on this very meeting is not in its way.
        .filter((e) => block.calendar_event_id !== e.id && !promptState(`meeting-start:${e.id}`))
        .map((e) => ({
          id: `meeting-start:${e.id}`,
          kind: 'meeting-start',
          title: `${nameOf(e)} has started`,
          body: `Pause ${quoted(block.title)} for it?`,
          // It was not due until both were true: the meeting had begun and the clock was running.
          createdAt: iso(Math.max(Date.parse(e.starts_at), since)),
          actions: [
            { id: 'pause', label: 'Pause block', primary: true },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        }))
    );
  },

  act(id, action) {
    if (action === 'dismiss') {
      setPromptState(id, 'dismissed');
    } else if (action === 'pause') {
      const block = liveSessionRow();
      if (!block) throw conflict('That prompt is no longer current');
      pauseSession(block.id);
      setPromptState(id, 'done', { sessionId: block.id, startedAt: block.started_at });
    } else {
      throw badRequest(`Unknown action: ${action}`);
    }
  },
};

/** The length a meeting is logged at: what was scheduled, as whole minutes, within what a block can be. */
function loggedMinutes(e: EventRow): number {
  const scheduled = (Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000;
  return Math.min(MAX_LOG_MINUTES, Math.max(1, Math.round(scheduled)));
}

/** Log the meeting as a finished block over its scheduled time, unless time is already logged on it. */
function logMeeting(e: EventRow): void {
  if (isLogged(e.id)) return;
  logManualSession({
    projectId: e.project_id,
    title: nameOf(e).slice(0, 300),
    startedAt: iso(Date.parse(e.starts_at)),
    minutes: loggedMinutes(e),
    calendarEventId: e.id,
  });
}

function resumePaused(eventId: string): void {
  const paused = pausedFor(eventId);
  if (paused) resumeSession(paused.id);
}

export const meetingEndProvider: PromptProvider = {
  kind: 'meeting-end',

  list(now) {
    if (!meetingPromptsOn()) return [];
    const t = now.getTime();

    return recentEvents(now).flatMap((e) => {
      const ended = Date.parse(e.ends_at);
      const id = `meeting-end:${e.id}`;
      if (!(ended <= t && t - ended <= END_WINDOW_MS) || promptState(id)) return [];
      const logged = isLogged(e.id);
      const paused = pausedFor(e.id);
      // Logged, and nothing left to pick back up: there is nothing to ask.
      if (logged && !paused) return [];

      const length = minutesShort(loggedMinutes(e));
      const log: PromptAction = {
        id: 'log',
        label: e.project_name ? `Log ${length} under ${e.project_name}` : `Log ${length}`,
      };
      const dismiss: PromptAction = { id: 'dismiss', label: 'Dismiss' };
      let body: string;
      let actions: PromptAction[];
      if (!logged && paused) {
        body = `Log the ${length} and resume ${quoted(paused.title)}?`;
        actions = [
          { id: 'log-resume', label: `Log ${length} and resume`, primary: true },
          log,
          { id: 'resume', label: 'Resume' },
          dismiss,
        ];
      } else if (!logged) {
        body = `Log the ${length} as time spent?`;
        actions = [{ ...log, primary: true }, dismiss];
      } else {
        body = `Resume ${quoted(paused!.title)}?`;
        actions = [{ id: 'resume', label: 'Resume', primary: true }, dismiss];
      }
      return [
        {
          id,
          kind: 'meeting-end',
          title: `${nameOf(e)} is over`,
          body,
          createdAt: iso(ended),
          actions,
        },
      ];
    });
  },

  act(id, action) {
    const eventId = id.slice('meeting-end:'.length);
    const event = db.prepare(`${EVENT} WHERE e.id = ?`).get(eventId) as EventRow | undefined;
    if (!event) throw conflict('That prompt is no longer current');

    switch (action) {
      case 'dismiss':
        setPromptState(id, 'dismissed');
        return;
      case 'log':
        logMeeting(event);
        break;
      case 'resume':
        resumePaused(eventId);
        break;
      case 'log-resume':
        logMeeting(event);
        resumePaused(eventId);
        break;
      default:
        throw badRequest(`Unknown action: ${action}`);
    }
    // Once there is nothing left to offer it is finished for good, so deleting the log
    // afterwards on purpose does not bring the question back.
    if (isLogged(eventId) && !pausedFor(eventId)) setPromptState(id, 'done');
  },
};
