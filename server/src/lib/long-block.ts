import { db } from '../db.js';
import { badRequest } from './http.js';
import { minutesPhrase, quoted } from './prompt-text.js';
import { promptStatesWithPrefix, setPromptState } from './prompt-state.js';
import type { PromptProvider } from './prompts.js';
import { reachedAt, toSpans, workedMs } from './segments.js';
import { getSessionRow, liveSessionRow } from './sessions.js';
import { getNumber } from './settings.js';

/**
 * A block left running for hours is usually a block that was left on. Once the running
 * focus block has worked `long_block_minutes` it asks whether you are still on it, and asks
 * again at each multiple of that: dismissing the question at two hours brings it back at
 * four, and only the latest multiple is ever asked, so a block that has gone untouched for
 * a whole afternoon shows one banner and not three.
 */
const prefixOf = (sessionId: number) => `long-block:${sessionId}:`;
const idOf = (sessionId: number, n: number) => `${prefixOf(sessionId)}${n}`;

export const longBlockProvider: PromptProvider = {
  kind: 'long-block',
  actionIds: ['finish', 'keep-going'],

  list(now) {
    const every = getNumber('long_block_minutes', 120) * 60_000;
    if (!(every > 0)) return [];
    const block = liveSessionRow();
    // A paused block is not running up the clock, and a break is meant to be short.
    if (!block || block.status !== 'running' || block.kind !== 'focus') return [];

    const spans = toSpans(
      db
        .prepare('SELECT started_at, ended_at FROM session_segments WHERE session_id = ?')
        .all(block.id) as { started_at: string; ended_at: string | null }[],
    );
    const worked = workedMs(spans, now.getTime());
    const n = Math.floor(worked / every);
    if (n < 1) return [];

    // Keeping going at a multiple answers every multiple below it as well, so a block that
    // dropped back down a mark (time taken off it as away) is not asked what it was told at
    // the higher one. Block ids can be handed out again once the newest block is deleted,
    // so a note that belongs to an earlier block with this id does not count as an answer
    // for this one.
    const prefix = prefixOf(block.id);
    for (const [key, note] of promptStatesWithPrefix(prefix)) {
      if (Number(key.slice(prefix.length)) >= n && note.data?.startedAt === block.started_at) {
        return [];
      }
    }

    return [
      {
        id: idOf(block.id, n),
        kind: 'long-block',
        title: `Still on ${quoted(block.title)}?`,
        body: `You have worked ${minutesPhrase(worked / 1000)} on this block.`,
        // The moment the clock passed the mark, which is the same whenever it is asked.
        createdAt: new Date(
          reachedAt(spans, n * every, now.getTime()) ?? now.getTime(),
        ).toISOString(),
        actions: [
          // The page is told which block it is about, so that it does not finish another.
          { id: 'finish', label: 'Finish block', open: `/?finish=${block.id}` },
          { id: 'keep-going', label: 'Keep going' },
        ],
      },
    ];
  },

  act(id, action) {
    if (action !== 'keep-going') throw badRequest(`Unknown action: ${action}`);
    // long-block:<block id>:<which multiple>
    const block = getSessionRow(Number(id.split(':')[1]));
    setPromptState(id, 'dismissed', { startedAt: block.started_at });
  },
};
