import { db } from '../db.js';
import { badRequest, conflict } from './http.js';
import { clockFor, minutesPhrase, quoted } from './prompt-text.js';
import type { Prompt, PromptProvider } from './prompts.js';
import { cutOut, gapsIn, toSpans, type Span } from './segments.js';
import { dropInterval, getSessionRow } from './sessions.js';
import { getNumber } from './settings.js';
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
 *
 * What has been answered is not asked again, so the part of a report that overlaps a stretch
 * kept or dropped already is cut away and only what is new is held (each piece at least a
 * minute). A report with nothing new in it holds nothing and the answer is null. Where
 * more than one piece is held, the one returned is the earliest.
 */
export function reportAway(sessionId: number, startedAt: string, endedAt: string): AwayView | null {
  const block = getSessionRow(sessionId);
  if (block.kind !== 'focus') throw badRequest('Away time is only kept for focus blocks');
  if (block.status === 'abandoned') throw badRequest('That block was discarded');

  const now = nowIso();
  const reportedFrom = Date.parse(startedAt);
  const reportedTo = Date.parse(endedAt);
  const blockStart = Date.parse(block.started_at);
  // A block still on the clock has no end yet.
  const blockEnd = block.ended_at == null ? Infinity : Date.parse(block.ended_at);
  if (!(reportedTo > reportedFrom)) throw badRequest('Away time has to end after it starts');
  if (reportedTo > Date.parse(now) + SKEW_MS) {
    throw badRequest('Away time cannot end in the future');
  }
  if (reportedTo <= blockStart) throw badRequest('Away time has to fall after the block started');
  if (reportedFrom >= blockEnd) throw badRequest('Away time has to fall before the block ended');
  // Nobody was away from a block before it began or after it ended, whatever the machine saw.
  const from = Math.max(reportedFrom, blockStart);
  const to = Math.min(reportedTo, blockEnd);
  if (to - from < MIN_AWAY_MS) throw badRequest('Away time has to be at least a minute');

  return db.transaction(() => {
    const answered = db
      .prepare(
        "SELECT started_at, ended_at FROM away_intervals WHERE session_id = ? AND status <> 'pending'",
      )
      .all(sessionId) as { started_at: string; ended_at: string }[];
    const news = gapsIn(toSpans(answered), from, to, Date.parse(now)).filter(
      (piece) => piece.end - piece.start >= MIN_AWAY_MS,
    );
    const held = news.map((piece) => holdPending(sessionId, piece.start, piece.end, now));
    return held[0] ?? null;
  })();
}

/** Hold a stretch as pending, folding it into the pending ones it overlaps or touches. */
function holdPending(sessionId: number, from: number, to: number, now: string): AwayView {
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
}

/** A stretch is asked about while it is pending, on a focus block that was not thrown away. */
const ASKED_ABOUT = "a.status = 'pending' AND s.kind = 'focus' AND s.status <> 'abandoned'";

/**
 * away:<row>:<when it was first reported, in ms>. Row ids are handed out again once the
 * newest row is gone (a block is deleted, or a report is folded into an earlier one), so a
 * banner left on screen for a row that no longer exists would otherwise name a different
 * stretch on a different block. The moment it was reported tells them apart.
 */
const idOf = (row: { id: number; created_at: string }) =>
  `away:${row.id}:${Date.parse(row.created_at)}`;

export const awayProvider: PromptProvider = {
  kind: 'away',
  actionIds: ['keep', 'drop'],

  list(now) {
    // 0 is the setting for no away detection, as it is for the other questions about time:
    // nothing is asked. What was reported before stays on record and is asked about again if
    // detection is turned back on.
    if (!(getNumber('away_minutes', 10) > 0)) return [];

    const rows = db
      .prepare(
        `SELECT a.id, a.session_id, a.started_at, a.ended_at, a.created_at, s.title AS block_title
         FROM away_intervals a JOIN sessions s ON s.id = a.session_id
         WHERE ${ASKED_ABOUT}
         ORDER BY a.created_at, a.id`,
      )
      .all() as (AwayRow & { block_title: string })[];
    if (!rows.length) return [];

    // The runs of every block that has something to ask about, read together and not once
    // for each stretch: a block can have hundreds of runs and a thousand stretches.
    const segments = db
      .prepare(
        `SELECT g.session_id, g.started_at, g.ended_at FROM session_segments g
         WHERE g.session_id IN (
           SELECT a.session_id FROM away_intervals a JOIN sessions s ON s.id = a.session_id
           WHERE ${ASKED_ABOUT})`,
      )
      .all() as { session_id: number; started_at: string; ended_at: string | null }[];
    const byBlock = new Map<number, { started_at: string; ended_at: string | null }[]>();
    for (const g of segments) {
      const own = byBlock.get(g.session_id) ?? [];
      own.push(g);
      byBlock.set(g.session_id, own);
    }
    const runs = new Map<number, Span[]>();
    for (const [blockId, own] of byBlock) runs.set(blockId, toSpans(own));

    const clock = clockFor(now);
    return rows.map((r): Prompt => {
      const length = secondsBetween(r.started_at, r.ended_at);
      // Dropping takes off only what the clock was counting, which is less than the whole
      // stretch when the block was paused through some of it, so say so.
      const counted = Math.round(
        cutOut(
          runs.get(r.session_id) ?? [],
          Date.parse(r.started_at),
          Date.parse(r.ended_at),
          now.getTime(),
        ).removedMs / 1000,
      );
      const during = clock.range(r.started_at, r.ended_at);
      const block = quoted(r.block_title);
      const body =
        counted === 0
          ? `${during}, during ${block}, but none of it was on the clock.`
          : minutesPhrase(counted) === minutesPhrase(length)
            ? `${during}, while ${block} was on the clock.`
            : `${during}, during ${block}, of which ${minutesPhrase(counted)} was on the clock.`;
      return {
        id: idOf(r),
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
    const [, rowId] = /^away:(\d+):\d+$/.exec(id) ?? [];
    const row =
      rowId === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT a.* FROM away_intervals a JOIN sessions s ON s.id = a.session_id
               WHERE a.id = ? AND ${ASKED_ABOUT}`,
            )
            .get(Number(rowId)) as AwayRow | undefined);
    // The row has to be the very one the id was made for, not whatever has its number now.
    if (!row || idOf(row) !== id) throw conflict('That prompt is no longer current');
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
