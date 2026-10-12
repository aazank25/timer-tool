import { db } from '../db.js';
import { badRequest, conflict } from './http.js';
import { clockTime, minutesPhrase, quoted } from './prompt-text.js';
import type { Prompt, PromptProvider } from './prompts.js';
import { cutOut, toSpans } from './segments.js';
import { dropInterval, getSessionRow } from './sessions.js';
import { nowIso, secondsBetween } from './time.js';

/**
 * Time the desktop app saw you were away (locked, asleep or idle) while a block ran. The
 * clock kept ticking through it, so it is kept or dropped by you, never decided for you:
 * a report waits as a prompt until you say which, and then never asks again.
 */

/** A report may end a moment ahead of this clock: two clocks are never exactly alike. */
const SKEW_MS = 5_000;
/** Shorter than this is a glance away from the screen, not something to ask about. */
const MIN_AWAY_MS = 60_000;

export type AwayStatus = 'pending' | 'kept' | 'dropped';

export interface AwayView {
  id: number;
  sessionId: number;
  startedAt: string;
  endedAt: string;
  seconds: number;
  status: AwayStatus;
}

interface AwayRow {
  id: number;
  session_id: number;
  started_at: string;
  ended_at: string;
  status: AwayStatus;
  created_at: string;
  resolved_at: string | null;
}

const toView = (row: AwayRow): AwayView => ({
  id: row.id,
  sessionId: row.session_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  seconds: secondsBetween(row.started_at, row.ended_at),
  status: row.status,
});

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Record that you were away for a stretch of a block. It is held as pending until it is
 * kept or dropped. A stretch that overlaps or touches one already pending on the block is
 * the same absence reported again, or reported longer, so they become one: the earliest
 * keeps its place and its id, and the others are folded into it.
 */
export function reportAway(sessionId: number, startedAt: string, endedAt: string): AwayView {
  const block = getSessionRow(sessionId);
  if (block.kind !== 'focus') throw badRequest('Away time is only kept for focus blocks');
  if (block.status === 'abandoned') throw badRequest('That block was discarded');

  const now = nowIso();
  const to = Date.parse(endedAt);
  const blockStart = Date.parse(block.started_at);
  if (!(to > Date.parse(startedAt))) throw badRequest('Away time has to end after it starts');
  if (to > Date.parse(now) + SKEW_MS) throw badRequest('Away time cannot end in the future');
  if (to <= blockStart) throw badRequest('Away time has to fall after the block started');
  // Nobody was away from a block before it began, whatever the machine saw.
  const from = Math.max(Date.parse(startedAt), blockStart);
  if (to - from < MIN_AWAY_MS) throw badRequest('Away time has to be at least a minute');

  return db.transaction(() => {
    const touching = (
      db
        .prepare(
          "SELECT * FROM away_intervals WHERE session_id = ? AND status = 'pending' ORDER BY id",
        )
        .all(sessionId) as AwayRow[]
    ).filter((r) => Date.parse(r.started_at) <= to && Date.parse(r.ended_at) >= from);

    const [first, ...rest] = touching;
    if (!first) {
      const info = db
        .prepare(
          'INSERT INTO away_intervals (session_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(sessionId, iso(from), iso(to), now);
      return toView(
        db
          .prepare('SELECT * FROM away_intervals WHERE id = ?')
          .get(Number(info.lastInsertRowid)) as AwayRow,
      );
    }
    db.prepare('UPDATE away_intervals SET started_at = ?, ended_at = ? WHERE id = ?').run(
      iso(Math.min(from, ...touching.map((r) => Date.parse(r.started_at)))),
      iso(Math.max(to, ...touching.map((r) => Date.parse(r.ended_at)))),
      first.id,
    );
    const fold = db.prepare('DELETE FROM away_intervals WHERE id = ?');
    for (const r of rest) fold.run(r.id);
    return toView(db.prepare('SELECT * FROM away_intervals WHERE id = ?').get(first.id) as AwayRow);
  })();
}

export const awayProvider: PromptProvider = {
  kind: 'away',

  list(now) {
    // A discarded block has no time left to keep or drop, so it stops asking.
    const rows = db
      .prepare(
        `SELECT a.id, a.session_id, a.started_at, a.ended_at, a.created_at, s.title AS block_title
         FROM away_intervals a JOIN sessions s ON s.id = a.session_id
         WHERE a.status = 'pending' AND s.status <> 'abandoned'
         ORDER BY a.created_at, a.id`,
      )
      .all() as (AwayRow & { block_title: string })[];
    const segments = db.prepare(
      'SELECT started_at, ended_at FROM session_segments WHERE session_id = ?',
    );

    return rows.map((r): Prompt => {
      const length = secondsBetween(r.started_at, r.ended_at);
      // Dropping takes off only what the clock was counting, which is less than the whole
      // stretch when the block was paused through some of it, so say so.
      const counted = Math.round(
        cutOut(
          toSpans(segments.all(r.session_id) as { started_at: string; ended_at: string | null }[]),
          Date.parse(r.started_at),
          Date.parse(r.ended_at),
          now.getTime(),
        ).removedMs / 1000,
      );
      const during = `${clockTime(r.started_at)} to ${clockTime(r.ended_at)}`;
      const block = quoted(r.block_title);
      const body =
        counted === 0
          ? `${during}, during ${block}, but none of it was on the clock.`
          : minutesPhrase(counted) === minutesPhrase(length)
            ? `${during}, while ${block} was on the clock.`
            : `${during}, during ${block}, of which ${minutesPhrase(counted)} was on the clock.`;
      return {
        id: `away:${r.id}`,
        kind: 'away',
        title: `You were away ${minutesPhrase(length)}`,
        body,
        createdAt: r.created_at,
        actions: [
          { id: 'keep', label: 'Keep it' },
          { id: 'drop', label: `Drop ${minutesPhrase(length)}` },
        ],
      };
    });
  },

  act(id, action, now) {
    const row = db
      .prepare("SELECT * FROM away_intervals WHERE id = ? AND status = 'pending'")
      .get(Number(id.slice('away:'.length))) as AwayRow | undefined;
    if (!row) throw conflict('That prompt is no longer current');
    if (action !== 'keep' && action !== 'drop') throw badRequest(`Unknown action: ${action}`);
    // The prompt is only marked once the time is off the block. The engine runs this in one
    // transaction, so a drop that fails leaves the interval pending and the block untouched.
    if (action === 'drop') dropInterval(row.session_id, row.started_at, row.ended_at);
    db.prepare('UPDATE away_intervals SET status = ?, resolved_at = ? WHERE id = ?').run(
      action === 'drop' ? 'dropped' : 'kept',
      now.toISOString(),
      row.id,
    );
  },
};
