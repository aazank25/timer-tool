import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { SessionRow } from '../src/lib/sessions.js';
import { cutOut, gapsIn, reachedAt, type Span } from '../src/lib/segments.js';
import {
  advance,
  at,
  awayPromptId,
  type Api,
  failOnLoggedErrors,
  freeze,
  goTo,
  MINUTE,
  reset,
  serve,
} from './prompt-helpers.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const promptsMod = () => import('../src/lib/prompts.js');
const dbMod = () => import('../src/db.js');
const settingsMod = () => import('../src/lib/settings.js');

/** Start a stopwatch block on the frozen clock. */
async function startBlock(title = 'Deep work') {
  const { startSession } = await sessionsMod();
  return startSession({ title });
}

/** A block's segments as stored, in time order. */
async function segmentsOf(id: number) {
  const { db } = await dbMod();
  return db
    .prepare(
      'SELECT started_at, ended_at FROM session_segments WHERE session_id = ? ORDER BY started_at, id',
    )
    .all(id) as { started_at: string; ended_at: string | null }[];
}

/** Every column of the block and every one of its segments, so "unchanged" means all of it. */
async function stored(id: number) {
  const { db } = await dbMod();
  return {
    block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow,
    segments: db.prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id').all(id),
  };
}

async function awayRow(id: number) {
  const { db } = await dbMod();
  return db.prepare('SELECT * FROM away_intervals WHERE id = ?').get(id) as
    | {
        status: string;
        resolved_at: string | null;
        started_at: string;
        ended_at: string;
        created_at: string;
      }
    | undefined;
}

async function awayCount() {
  const { db } = await dbMod();
  return (db.prepare('SELECT COUNT(*) AS n FROM away_intervals').get() as { n: number }).n;
}

/**
 * A block worked in three sittings, 10:00-10:20, 10:30-10:50 and 11:00-11:20, ended at 11:20:
 * an hour of work across an hour and twenty minutes, and two pauses to cut through.
 */
async function threeSittings() {
  const { pauseSession, resumeSession, stopSession } = await sessionsMod();
  freeze(at('10:00'));
  const block = await startBlock();
  goTo(at('10:20'));
  pauseSession(block.id);
  goTo(at('10:30'));
  resumeSession(block.id);
  goTo(at('10:50'));
  pauseSession(block.id);
  goTo(at('11:00'));
  resumeSession(block.id);
  goTo(at('11:20'));
  stopSession(block.id, 'completed');
  return block.id;
}

describe('reporting away time', () => {
  let api: Api;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const report = (id: number, startedAt: string, endedAt: string) =>
    api.call('POST', `/sessions/${id}/away`, { startedAt, endedAt });

  it('keeps a stretch as a pending interval and answers 201 with it', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    const res = await report(block.id, at('10:10'), at('10:40'));

    assert.equal(res.status, 201);
    assert.deepEqual(res.body, {
      away: {
        id: res.body.away.id,
        sessionId: block.id,
        startedAt: at('10:10'),
        endedAt: at('10:40'),
        seconds: 1800,
        status: 'pending',
      },
    });
    assert.equal((await awayRow(res.body.away.id))?.status, 'pending');
  });

  it('writes times given with an offset as the instants they are', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    const res = await report(block.id, '2026-10-12T12:10:00+02:00', '2026-10-12T12:40:00+02:00');

    assert.equal(res.status, 201);
    assert.equal(res.body.away.startedAt, at('10:10'));
    assert.equal(res.body.away.endedAt, at('10:40'));
  });

  it('refuses a stretch that ends before it starts, or the moment it starts', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    assert.equal((await report(block.id, at('10:40'), at('10:10'))).status, 400);
    assert.equal((await report(block.id, at('10:10'), at('10:10'))).status, 400);
    assert.equal(await awayCount(), 0);
  });

  it('refuses less than a minute, and takes exactly a minute', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    assert.equal((await report(block.id, at('10:30:01'), at('10:31:00'))).status, 400);
    assert.equal(await awayCount(), 0);
    const exactly = await report(block.id, at('10:30:00'), at('10:31:00'));
    assert.equal(exactly.status, 201);
    assert.equal(exactly.body.away.seconds, 60);
  });

  it('refuses a stretch that ends in the future, allowing five seconds for clock skew', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    assert.equal((await report(block.id, at('10:40'), at('10:50:06'))).status, 400);
    assert.equal(await awayCount(), 0);
    assert.equal((await report(block.id, at('10:40'), at('10:50:05'))).status, 201);
  });

  it('refuses a break and a discarded block, and 404s a block that is not there', async () => {
    const { startSession, stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const rest = startSession({ title: 'Stretch', kind: 'break' });
    goTo(at('10:20'));
    assert.equal((await report(rest.id, at('10:05'), at('10:15'))).status, 400);
    stopSession(rest.id, 'completed');

    const block = startSession({ title: 'Thrown away' });
    goTo(at('10:50'));
    stopSession(block.id, 'abandoned');
    assert.equal((await report(block.id, at('10:30'), at('10:40'))).status, 400);

    assert.equal((await report(999_999, at('10:30'), at('10:40'))).status, 404);
    assert.equal(await awayCount(), 0);
  });

  it('starts a stretch no earlier than the block began', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    const res = await report(block.id, at('09:30'), at('10:20'));

    assert.equal(res.status, 201);
    assert.equal(res.body.away.startedAt, at('10:00'));
    assert.equal(res.body.away.seconds, 1200);
  });

  it('refuses a stretch from before the block began, and one that is under a minute once clamped', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    assert.equal((await report(block.id, at('09:00'), at('09:50'))).status, 400);
    assert.equal((await report(block.id, at('09:00'), at('10:00:30'))).status, 400);
    assert.equal(await awayCount(), 0);
  });

  it('refuses a body that is not two times, and a block id that is not a number', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    assert.equal((await api.call('POST', `/sessions/${block.id}/away`, {})).status, 400);
    assert.equal(
      (await api.call('POST', `/sessions/${block.id}/away`, { startedAt: at('10:10') })).status,
      400,
    );
    assert.equal(
      (
        await api.call('POST', `/sessions/${block.id}/away`, {
          startedAt: 'yesterday',
          endedAt: at('10:20'),
        })
      ).status,
      400,
    );
    assert.equal((await report('abc' as unknown as number, at('10:10'), at('10:20'))).status, 400);
    assert.equal(await awayCount(), 0);
  });

  it('takes a report for a paused block and for a finished one', async () => {
    const { pauseSession, stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:30'));
    pauseSession(block.id);
    goTo(at('10:40'));
    assert.equal((await report(block.id, at('10:10'), at('10:20'))).status, 201);

    stopSession(block.id, 'completed');
    assert.equal((await report(block.id, at('10:25'), at('10:35'))).status, 201);
  });

  it('refuses a stretch that falls wholly after a finished block ended', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:30'));
    stopSession(block.id, 'completed');
    goTo(at('11:30'));

    const after = await report(block.id, at('10:40'), at('11:20'));
    assert.equal(after.status, 400);
    // It says why: not that the stretch was too short, which it was not.
    assert.equal(after.body.error, 'Away time has to fall before the block ended');
    // Beginning at the very moment it ended is after it as well.
    const touching = await report(block.id, at('10:30'), at('11:00'));
    assert.equal(touching.status, 400);
    assert.equal(touching.body.error, 'Away time has to fall before the block ended');
    assert.equal(await awayCount(), 0);
  });

  it('cuts a stretch that runs past the end of a finished block off at that end', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:30'));
    stopSession(block.id, 'completed');
    goTo(at('11:30'));

    const res = await report(block.id, at('10:20'), at('10:50'));

    assert.equal(res.status, 201);
    assert.equal(res.body.away.startedAt, at('10:20'));
    assert.equal(res.body.away.endedAt, at('10:30'));
    assert.equal(res.body.away.seconds, 600);
    // With less than a minute left of it once cut, it is refused like any other.
    assert.equal((await report(block.id, at('10:29:30'), at('10:50'))).status, 400);
  });
});

describe('reports of the same absence', () => {
  let api: Api;
  failOnLoggedErrors();
  let blockId = 0;

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    freeze(at('10:00'));
    blockId = (await startBlock()).id;
    goTo(at('11:00'));
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const report = async (start: string, end: string) =>
    (
      await api.call('POST', `/sessions/${blockId}/away`, {
        startedAt: at(start),
        endedAt: at(end),
      })
    ).body.away;

  it('become one when they overlap, and the first keeps its id', async () => {
    const first = await report('10:10', '10:20');
    advance(MINUTE);
    const second = await report('10:15', '10:30');

    assert.equal(second.id, first.id);
    assert.equal(second.startedAt, at('10:10'));
    assert.equal(second.endedAt, at('10:30'));
    assert.equal(second.seconds, 1200);
    assert.equal(await awayCount(), 1);
    // It has been waiting since the first report, not since the latest.
    assert.equal((await awayRow(first.id))?.created_at, at('11:00'));
  });

  it('become one when they touch', async () => {
    const first = await report('10:10', '10:20');
    const second = await report('10:20', '10:30');

    assert.equal(second.id, first.id);
    assert.equal(second.startedAt, at('10:10'));
    assert.equal(second.endedAt, at('10:30'));
    assert.equal(await awayCount(), 1);
  });

  it('are folded into the earliest when one report joins two', async () => {
    const early = await report('10:05', '10:10');
    const late = await report('10:20', '10:25');
    assert.notEqual(early.id, late.id);

    const joined = await report('10:09', '10:21');

    assert.equal(joined.id, early.id);
    assert.equal(joined.startedAt, at('10:05'));
    assert.equal(joined.endedAt, at('10:25'));
    assert.equal(await awayCount(), 1);
  });

  it('change nothing when one lies inside another', async () => {
    const first = await report('10:10', '10:30');
    const inside = await report('10:15', '10:20');

    assert.equal(inside.id, first.id);
    assert.equal(inside.startedAt, at('10:10'));
    assert.equal(inside.endedAt, at('10:30'));
    assert.equal(await awayCount(), 1);
  });

  it('stay apart when there is a gap between them, even of a second', async () => {
    const first = await report('10:05', '10:10');
    const second = (
      await api.call('POST', `/sessions/${blockId}/away`, {
        startedAt: at('10:10:01'),
        endedAt: at('10:15'),
      })
    ).body.away;

    assert.notEqual(second.id, first.id);
    assert.equal(await awayCount(), 2);
  });

  it('do not merge into a stretch that has been kept or dropped already', async () => {
    const { actOnPrompt } = await promptsMod();
    const first = await report('10:10', '10:20');
    actOnPrompt(await awayPromptId(first.id), 'keep');

    // It touches the kept stretch, so there is nothing to merge into: it is a stretch of its own.
    const second = await report('10:20', '10:30');

    assert.notEqual(second.id, first.id);
    assert.equal(second.startedAt, at('10:20'));
    const old = await awayRow(first.id);
    assert.equal(old?.status, 'kept');
    assert.equal(old?.ended_at, at('10:20'));
    assert.equal(await awayCount(), 2);
  });

  /** Every stretch on the block as stored, in time order. */
  async function stretches() {
    const { db } = await dbMod();
    return db
      .prepare('SELECT started_at, ended_at, status FROM away_intervals ORDER BY started_at')
      .all() as { started_at: string; ended_at: string; status: string }[];
  }

  it('hold only what is new when they overlap a stretch that was kept, so that Drop takes off only that', async () => {
    const { actOnPrompt } = await promptsMod();
    const { getSessionRow, toView } = await sessionsMod();
    const kept = await report('10:10', '10:20');
    actOnPrompt(await awayPromptId(kept.id), 'keep');

    // Five of these fifteen minutes were kept already.
    const again = await report('10:15', '10:30');

    assert.notEqual(again.id, kept.id);
    assert.equal(again.startedAt, at('10:20'));
    assert.equal(again.endedAt, at('10:30'));
    assert.equal(again.seconds, 600);
    assert.deepEqual(await stretches(), [
      { started_at: at('10:10'), ended_at: at('10:20'), status: 'kept' },
      { started_at: at('10:20'), ended_at: at('10:30'), status: 'pending' },
    ]);

    actOnPrompt(await awayPromptId(again.id), 'drop');

    // An hour on the clock and the ten new minutes off it: the kept five are still there.
    assert.equal(toView(getSessionRow(blockId)).elapsedSeconds, 3600 - 600);
    assert.deepEqual(await segmentsOf(blockId), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('10:30'), ended_at: null },
    ]);
  });

  it('hold nothing, and answer 200 with no stretch, when all of it was kept or dropped already', async () => {
    const { actOnPrompt } = await promptsMod();
    const kept = await report('10:10', '10:30');
    actOnPrompt(await awayPromptId(kept.id), 'keep');
    const dropped = await report('10:40', '10:50');
    actOnPrompt(await awayPromptId(dropped.id), 'drop');
    const before = await stretches();

    for (const [start, end] of [
      ['10:15', '10:25'],
      ['10:10', '10:30'],
      ['10:42', '10:48'],
      ['10:40', '10:50'],
    ] as const) {
      const res = await api.call('POST', `/sessions/${blockId}/away`, {
        startedAt: at(start),
        endedAt: at(end),
      });
      assert.equal(res.status, 200, `${start} to ${end}`);
      assert.deepEqual(res.body, { away: null });
    }

    assert.deepEqual(await stretches(), before);
    const prompts = (await api.call('GET', '/prompts')).body as { kind: string }[];
    assert.deepEqual(
      prompts.filter((p) => p.kind === 'away'),
      [],
    );
  });

  it('hold each piece that is new when they run across a stretch that was kept, and answer with the earliest', async () => {
    const { actOnPrompt } = await promptsMod();
    const kept = await report('10:20', '10:30');
    actOnPrompt(await awayPromptId(kept.id), 'keep');

    const res = await api.call('POST', `/sessions/${blockId}/away`, {
      startedAt: at('10:10'),
      endedAt: at('10:40'),
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.away.startedAt, at('10:10'));
    assert.equal(res.body.away.endedAt, at('10:20'));
    assert.deepEqual(await stretches(), [
      { started_at: at('10:10'), ended_at: at('10:20'), status: 'pending' },
      { started_at: at('10:20'), ended_at: at('10:30'), status: 'kept' },
      { started_at: at('10:30'), ended_at: at('10:40'), status: 'pending' },
    ]);
  });

  it('leave out a piece that is under a minute once what was kept is taken away', async () => {
    const { actOnPrompt } = await promptsMod();
    const kept = await report('10:10', '10:20');
    actOnPrompt(await awayPromptId(kept.id), 'keep');

    // A minute as reported, but half of it is the kept stretch.
    const res = await api.call('POST', `/sessions/${blockId}/away`, {
      startedAt: at('10:19:30'),
      endedAt: at('10:20:30'),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { away: null });
    assert.equal(await awayCount(), 1);
  });

  it('merge the new part into the pending stretch it touches, as any report is', async () => {
    const { actOnPrompt } = await promptsMod();
    const kept = await report('10:10', '10:20');
    actOnPrompt(await awayPromptId(kept.id), 'keep');
    const pending = await report('10:20', '10:25');

    const again = await report('10:15', '10:30');

    assert.equal(again.id, pending.id);
    assert.deepEqual(await stretches(), [
      { started_at: at('10:10'), ended_at: at('10:20'), status: 'kept' },
      { started_at: at('10:20'), ended_at: at('10:30'), status: 'pending' },
    ]);
  });

  it('do not come back over a stretch that was dropped either', async () => {
    const { actOnPrompt } = await promptsMod();
    const dropped = await report('10:10', '10:20');
    actOnPrompt(await awayPromptId(dropped.id), 'drop');

    const again = await report('10:15', '10:30');

    assert.equal(again.startedAt, at('10:20'));
    assert.deepEqual(await stretches(), [
      { started_at: at('10:10'), ended_at: at('10:20'), status: 'dropped' },
      { started_at: at('10:20'), ended_at: at('10:30'), status: 'pending' },
    ]);
  });

  it('are kept apart between blocks', async () => {
    const { stopSession, startSession } = await sessionsMod();
    const first = await report('10:10', '10:20');
    stopSession(blockId, 'completed');
    const next = startSession({ title: 'Second block' });
    advance(10 * MINUTE);
    const there = await api.call('POST', `/sessions/${next.id}/away`, {
      startedAt: at('11:02'),
      endedAt: at('11:08'),
    });
    // Different block and different time, so nothing to merge; and the first is left alone.
    assert.equal(there.status, 201);
    assert.notEqual(there.body.away.id, first.id);
    assert.equal(await awayCount(), 2);
  });
});

describe('the away prompt', () => {
  let api: Api;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  /** The stretch as the route answers it, and the id its prompt is asked under. */
  async function reported(blockId: number, start: string, end: string) {
    const { id } = (
      await api.call('POST', `/sessions/${blockId}/away`, {
        startedAt: at(start),
        endedAt: at(end),
      })
    ).body.away as { id: number };
    return { id, promptId: await awayPromptId(id) };
  }

  it('is listed while the interval is pending, naming the block and the times', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock('Deep work');
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');

    const [prompt, ...others] = listPrompts();

    assert.equal(others.length, 0);
    assert.ok(prompt);
    assert.equal(prompt.id, away.promptId);
    assert.equal(prompt.kind, 'away');
    assert.equal(prompt.title, 'You were away 40 min');
    assert.match(prompt.body, /“Deep work”/);
    assert.match(prompt.body, /10:10/);
    assert.match(prompt.body, /10:50/);
    assert.equal(prompt.createdAt, at('11:00'));
    assert.deepEqual(prompt.actions, [
      { id: 'keep', label: 'Keep it' },
      { id: 'drop', label: 'Drop 40 min' },
    ]);
    // The same list over HTTP.
    assert.deepEqual((await api.call('GET', '/prompts')).body, [prompt]);
  });

  it('says a stretch of an hour or more in hours and minutes', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('12:30'));
    await reported(block.id, '10:05', '11:25');
    await reported(block.id, '11:30', '12:00');

    // Two and a half hours in, the block has a long-block question of its own as well.
    const [long, short] = listPrompts().filter((p) => p.kind === 'away');

    assert.equal(long?.title, 'You were away 1 h 20 min');
    assert.equal(long?.actions[1]?.label, 'Drop 1 h 20 min');
    assert.equal(short?.title, 'You were away 30 min');
  });

  it('is gone after Keep, which marks the interval kept and leaves the block as it was', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');

    const res = await api.call('POST', '/prompts/act', { id: away.promptId, action: 'keep' });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { prompts: [] });
    const row = await awayRow(away.id);
    assert.equal(row?.status, 'kept');
    assert.equal(row?.resolved_at, at('11:00'));
    assert.deepEqual((await api.call('GET', '/prompts')).body, []);
    const { toView, getSessionRow } = await sessionsMod();
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 3600);
    // A resolved interval is never asked about again.
    assert.equal(
      await api.status('POST', '/prompts/act', { id: away.promptId, action: 'keep' }),
      409,
    );
    assert.equal(
      await api.status('POST', '/prompts/act', { id: away.promptId, action: 'drop' }),
      409,
    );
  });

  it('is gone after Drop, which takes those minutes off the block', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');

    const res = await api.call('POST', '/prompts/act', { id: away.promptId, action: 'drop' });

    assert.deepEqual(res.body, { prompts: [] });
    const row = await awayRow(away.id);
    assert.equal(row?.status, 'dropped');
    assert.equal(row?.resolved_at, at('11:00'));
    const { toView, getSessionRow } = await sessionsMod();
    // An hour on the clock, forty minutes of it away.
    const after = toView(getSessionRow(block.id));
    assert.equal(after.elapsedSeconds, 1200);
    assert.equal(after.status, 'running');
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:10') },
      { started_at: at('10:50'), ended_at: null },
    ]);
  });

  it('says how much of the stretch the clock was counting when the block was paused through part of it', async () => {
    const { listPrompts } = await promptsMod();
    const { pauseSession, resumeSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:20'));
    pauseSession(block.id);
    goTo(at('10:40'));
    resumeSession(block.id);
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');

    const [prompt] = listPrompts();

    // The title and the button stay what was reported: the stretch you were away.
    assert.equal(prompt?.title, 'You were away 40 min');
    assert.equal(prompt?.actions[1]?.label, 'Drop 40 min');
    assert.match(prompt!.body, /of which 20 min was on the clock/);

    await api.call('POST', '/prompts/act', { id: away.promptId, action: 'drop' });
    const { toView, getSessionRow } = await sessionsMod();
    // 40 minutes were worked and 20 of them came off, not 40.
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 1200);
  });

  it('says so when none of the stretch was on the clock', async () => {
    const { listPrompts } = await promptsMod();
    const { pauseSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:20'));
    pauseSession(block.id);
    goTo(at('11:00'));
    await reported(block.id, '10:30', '10:50');

    assert.match(listPrompts()[0]!.body, /none of it was on the clock/);
  });

  it('asks about each stretch on its own, oldest first', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const first = await reported(block.id, '10:10', '10:20');
    goTo(at('11:05'));
    const second = await reported(block.id, '10:30', '10:40');

    assert.deepEqual(
      listPrompts().map((p) => p.id),
      [first.promptId, second.promptId],
    );
    await api.call('POST', '/prompts/act', { id: first.promptId, action: 'keep' });
    assert.deepEqual(
      listPrompts().map((p) => p.id),
      [second.promptId],
    );
  });

  it('stops asking once the block is discarded', async () => {
    const { listPrompts } = await promptsMod();
    const { stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    await reported(block.id, '10:10', '10:50');
    assert.equal(listPrompts().length, 1);

    stopSession(block.id, 'abandoned');

    assert.equal(listPrompts().length, 0);
  });

  it('goes with the block when the block is deleted', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    await reported(block.id, '10:10', '10:50');

    const { db } = await dbMod();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(block.id);

    assert.equal(await awayCount(), 0);
    assert.equal(listPrompts().length, 0);
  });

  it('is still asked after the block is finished, and Drop takes the time off a finished block', async () => {
    const { stopSession, getSessionRow, toView } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');
    stopSession(block.id, 'completed');

    const listed = await api.call('GET', '/prompts');
    assert.deepEqual(
      listed.body.map((p: { id: string }) => p.id),
      [away.promptId],
    );
    await api.call('POST', '/prompts/act', { id: away.promptId, action: 'drop' });

    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 1200);
  });

  it('is left pending, and the block untouched, when the drop fails partway', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:50');
    const { db } = await dbMod();
    const before = await stored(block.id);

    // The segments are rewritten and the total updated first, and the interval is marked
    // last: failing the mark must undo the rest.
    db.exec(`CREATE TEMP TRIGGER fail_the_mark BEFORE UPDATE OF status ON away_intervals
             WHEN NEW.status = 'dropped' BEGIN SELECT RAISE(ABORT, 'tripwire'); END`);
    const quiet = mock.method(console, 'error', () => {});
    let failed;
    try {
      failed = await api.call('POST', '/prompts/act', { id: away.promptId, action: 'drop' });
    } finally {
      quiet.mock.restore();
      db.exec('DROP TRIGGER IF EXISTS fail_the_mark');
    }

    assert.equal(failed.status, 500);
    assert.match(failed.body.details, /tripwire/);
    assert.deepEqual(await stored(block.id), before);
    assert.equal((await awayRow(away.id))?.status, 'pending');
    assert.equal((await api.call('GET', '/prompts')).body.length, 1);

    // Without the failure the same answer goes through, all of it.
    const ok = await api.call('POST', '/prompts/act', { id: away.promptId, action: 'drop' });
    assert.equal(ok.status, 200);
    assert.equal((await awayRow(away.id))?.status, 'dropped');
  });

  /** The block's time as the clock now reads it. */
  async function elapsed(blockId: number) {
    const { toView, getSessionRow } = await sessionsMod();
    return toView(getSessionRow(blockId)).elapsedSeconds;
  }

  it('cannot be answered from a banner that was made for a stretch that is gone, once its row has been given to another', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('09:30'));
    const first = await startBlock('Block A');
    goTo(at('10:30'));
    await reported(first.id, '09:40', '09:50');
    const folded = await reported(first.id, '10:00', '10:05');
    // What a banner on screen for the second stretch carries.
    assert.ok(
      (await api.call('GET', '/prompts')).body.some(
        (p: { id: string }) => p.id === folded.promptId,
      ),
    );
    // A report that joins the two folds the later row into the earlier and deletes it.
    await reported(first.id, '09:45', '10:02');
    stopSession(first.id, 'completed');
    const second = await startBlock('Block B');
    goTo(at('12:00'));
    const other = await reported(second.id, '10:40', '11:40');
    assert.equal(other.id, folded.id, 'the row was handed out again');
    const before = await elapsed(second.id);

    const res = await api.call('POST', '/prompts/act', { id: folded.promptId, action: 'drop' });

    assert.equal(res.status, 409);
    assert.equal(await elapsed(second.id), before);
    assert.equal((await awayRow(other.id))?.status, 'pending');
    // The new stretch has its own id, and that one still works.
    assert.notEqual(other.promptId, folded.promptId);
    assert.equal(
      await api.status('POST', '/prompts/act', { id: other.promptId, action: 'drop' }),
      200,
    );
    assert.equal(await elapsed(second.id), before - 3600);
  });

  it('cannot be answered from a banner that was made for a stretch on a block that has since been deleted, once its row has been given to another', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('09:30'));
    const first = await startBlock('Block A');
    goTo(at('10:30'));
    const gone = await reported(first.id, '09:40', '09:45');
    stopSession(first.id, 'completed');
    assert.equal(await api.status('DELETE', `/sessions/${first.id}`), 200);
    const second = await startBlock('Block B');
    goTo(at('12:00'));
    const other = await reported(second.id, '10:40', '11:40');
    assert.equal(other.id, gone.id, 'the row was handed out again');
    const before = await elapsed(second.id);

    const res = await api.call('POST', '/prompts/act', { id: gone.promptId, action: 'drop' });

    assert.equal(res.status, 409);
    assert.equal(await elapsed(second.id), before);
    assert.equal((await awayRow(other.id))?.status, 'pending');
  });

  it('is refused by the provider itself unless the id is exactly the stretch it was made for', async () => {
    const { awayProvider } = await import('../src/lib/away.js');
    const { stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = await reported(block.id, '10:10', '10:30');
    const [, row, created] = /^away:(\d+):(\d+)$/.exec(away.promptId) ?? [];
    const before = await elapsed(block.id);

    for (const id of [
      `away:${row}`,
      `away:${row}:`,
      `away:${row}:${Number(created) + 1}`,
      `away:${row}:${created}x`,
      `away:${Number(row) + 1}:${created}`,
      `away:x:${created}`,
      'nonsense',
    ]) {
      assert.throws(() => awayProvider.act(id, 'drop', new Date()), { status: 409 }, id);
    }
    assert.equal(await elapsed(block.id), before);

    // A stretch whose block was thrown away has nothing left to keep or drop.
    stopSession(block.id, 'abandoned');
    assert.throws(() => awayProvider.act(away.promptId, 'drop', new Date()), { status: 409 });
    assert.equal((await awayRow(away.id))?.status, 'pending');
  });

  it('says the day when the stretch is not today, and both days when it crosses midnight', async () => {
    const { listPrompts } = await promptsMod();
    // The same way of writing a time the prompt uses, so that this holds in whatever style the machine has.
    const style = { timeZone: 'UTC' } as const;
    const dayStyle = { weekday: 'short', month: 'short', day: 'numeric' } as const;
    const timeStyle = { hour: 'numeric', minute: '2-digit' } as const;
    const day = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { ...dayStyle, ...style }).format(new Date(iso));
    const time = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { ...timeStyle, ...style }).format(new Date(iso));
    const dayAndTime = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { ...dayStyle, ...timeStyle, ...style }).format(
        new Date(iso),
      );

    freeze('2026-10-09T09:00:00.000Z');
    const block = await startBlock('Marathon');
    goTo('2026-10-12T12:00:00.000Z');
    const report = async (startedAt: string, endedAt: string) =>
      (await api.call('POST', `/sessions/${block.id}/away`, { startedAt, endedAt })).body.away
        .id as number;
    const crossing = await report('2026-10-09T12:00:00.000Z', '2026-10-11T12:00:00.000Z');
    const earlier = await report('2026-10-11T14:00:00.000Z', '2026-10-11T14:30:00.000Z');
    const today = await report('2026-10-12T11:00:00.000Z', '2026-10-12T11:30:00.000Z');
    const bodyOf = (row: number) =>
      listPrompts().find((p) => p.id.startsWith(`away:${row}:`))!.body;

    // Not "12:00 PM to 12:00 PM": both ends are named, with their days.
    assert.ok(
      bodyOf(crossing).startsWith(
        `${dayAndTime('2026-10-09T12:00:00.000Z')} to ${dayAndTime('2026-10-11T12:00:00.000Z')}`,
      ),
      bodyOf(crossing),
    );
    // On another day, the day once and then the two times.
    assert.ok(
      bodyOf(earlier).startsWith(
        `${day('2026-10-11T14:00:00.000Z')}, ${time('2026-10-11T14:00:00.000Z')} to ${time('2026-10-11T14:30:00.000Z')}`,
      ),
      bodyOf(earlier),
    );
    // Today it is the times alone, as it always was.
    assert.ok(
      bodyOf(today).startsWith(
        `${time('2026-10-12T11:00:00.000Z')} to ${time('2026-10-12T11:30:00.000Z')}`,
      ),
      bodyOf(today),
    );
    assert.ok(!bodyOf(today).includes(day('2026-10-12T11:00:00.000Z')));
  });

  it('lists no away prompts while away detection is off, and holds what is reported meanwhile', async () => {
    const { setSettings } = await settingsMod();
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const before = await reported(block.id, '10:10', '10:30');
    assert.deepEqual(
      listPrompts().map((p) => p.id),
      [before.promptId],
    );

    setSettings({ away_minutes: 0 });
    const during = await reported(block.id, '10:40', '10:50');

    // What was reported is still on record, but nothing is asked, and nothing can be answered.
    assert.equal(await awayCount(), 2);
    assert.deepEqual(listPrompts(), []);
    assert.deepEqual((await api.call('GET', '/prompts')).body, []);
    assert.equal(
      await api.status('POST', '/prompts/act', { id: before.promptId, action: 'keep' }),
      409,
    );
    assert.equal((await awayRow(before.id))?.status, 'pending');

    // Turned back on, it asks about both.
    setSettings({ away_minutes: 10 });
    assert.deepEqual(
      listPrompts().map((p) => p.id),
      [before.promptId, during.promptId],
    );
  });
});

describe('dropping time from a block', () => {
  failOnLoggedErrors();
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('splits the open run of a running block, takes off exactly the stretch, and keeps it ticking', async () => {
    const { dropInterval, getSessionRow, toView } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 3000);

    const view = dropInterval(block.id, at('10:10'), at('10:40'));

    assert.equal(view.status, 'running');
    assert.equal(view.elapsedSeconds, 3000 - 1800);
    // The run before the stretch is closed and the clock goes on from where it ended.
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:10') },
      { started_at: at('10:40'), ended_at: null },
    ]);
    // The total on the block is the closed runs, as it is for any block on the clock.
    assert.equal(getSessionRow(block.id).active_seconds, 600);
    // Still ticking.
    advance(5 * MINUTE);
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 1200 + 300);
  });

  it('trims the start of the open run when the stretch ends inside it', async () => {
    const { dropInterval, pauseSession, resumeSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:20'));
    pauseSession(block.id);
    goTo(at('10:30'));
    resumeSession(block.id);
    goTo(at('10:50'));

    // From a moment the block was paused to ten minutes into the second sitting.
    const view = dropInterval(block.id, at('10:25'), at('10:40'));

    assert.equal(view.elapsedSeconds, 2400 - 600);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('10:40'), ended_at: null },
    ]);
  });

  it('cannot take more than has run so far off a running block', async () => {
    const { dropInterval, getSessionRow, toView } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    // The stretch runs to 11:30, forty minutes beyond the clock: only what has run comes off.
    const view = dropInterval(block.id, at('10:40'), at('11:30'));

    assert.equal(view.elapsedSeconds, 2400);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:40') },
      { started_at: at('10:50'), ended_at: null },
    ]);
    advance(5 * MINUTE);
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 2700);
  });

  it('removes only the part of the stretch that was ticking on a paused block', async () => {
    const { dropInterval, pauseSession, resumeSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:20'));
    pauseSession(block.id);
    goTo(at('10:40'));
    resumeSession(block.id);
    goTo(at('11:00'));
    pauseSession(block.id);

    // 10:10 to 10:50 is forty minutes of wall-clock, twenty of them spent paused.
    const view = dropInterval(block.id, at('10:10'), at('10:50'));

    assert.equal(view.status, 'paused');
    assert.equal(view.elapsedSeconds, 2400 - 1200);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:10') },
      { started_at: at('10:50'), ended_at: at('11:00') },
    ]);
  });

  it('takes time off a finished block, and leaves when it started and ended alone', async () => {
    const { dropInterval, getSessionRow, stopSession } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    stopSession(block.id, 'completed');
    const before = getSessionRow(block.id);

    const view = dropInterval(block.id, at('10:20'), at('10:50'));

    assert.equal(view.status, 'completed');
    assert.equal(view.elapsedSeconds, 3600 - 1800);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('10:50'), ended_at: at('11:00') },
    ]);
    const after = getSessionRow(block.id);
    assert.equal(after.started_at, before.started_at);
    assert.equal(after.ended_at, before.ended_at);
  });

  it('cuts through several runs at once: the end of one, the whole of another, the start of the next', async () => {
    const { dropInterval } = await sessionsMod();
    const id = await threeSittings();

    // 10:15 to 11:10 takes the last five minutes of the first sitting, all of the second and
    // the first ten minutes of the third: 300 + 1200 + 600 seconds.
    const view = dropInterval(id, at('10:15'), at('11:10'));

    assert.equal(view.elapsedSeconds, 3600 - 2100);
    assert.deepEqual(await segmentsOf(id), [
      { started_at: at('10:00'), ended_at: at('10:15') },
      { started_at: at('11:10'), ended_at: at('11:20') },
    ]);
  });

  it('leaves no empty run when the stretch begins or ends exactly where a run does', async () => {
    const { dropInterval } = await sessionsMod();
    const id = await threeSittings();

    // From the very start of the second run to part-way through it.
    dropInterval(id, at('10:30'), at('10:40'));
    assert.deepEqual(await segmentsOf(id), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('10:40'), ended_at: at('10:50') },
      { started_at: at('11:00'), ended_at: at('11:20') },
    ]);

    // From part-way through the third to the very end of it.
    dropInterval(id, at('11:10'), at('11:20'));
    assert.deepEqual(await segmentsOf(id), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('10:40'), ended_at: at('10:50') },
      { started_at: at('11:00'), ended_at: at('11:10') },
    ]);

    // The whole of a run, from its start to its end: nothing is left of it, not even an instant.
    dropInterval(id, at('10:40'), at('10:50'));
    const runs = await segmentsOf(id);
    assert.deepEqual(runs, [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('11:00'), ended_at: at('11:10') },
    ]);
    for (const run of runs) assert.ok(Date.parse(run.ended_at!) > Date.parse(run.started_at));
  });

  it('leaves no empty run behind a running block either, when the stretch begins where its run began', async () => {
    const { dropInterval } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));

    dropInterval(block.id, at('10:00'), at('10:20'));

    assert.deepEqual(await segmentsOf(block.id), [{ started_at: at('10:20'), ended_at: null }]);
  });

  it('removes a run altogether when the stretch covers it', async () => {
    const { dropInterval } = await sessionsMod();
    const id = await threeSittings();

    const view = dropInterval(id, at('10:25'), at('10:55'));

    assert.equal(view.elapsedSeconds, 3600 - 1200);
    assert.deepEqual(await segmentsOf(id), [
      { started_at: at('10:00'), ended_at: at('10:20') },
      { started_at: at('11:00'), ended_at: at('11:20') },
    ]);
  });

  it('can take a block down to nothing', async () => {
    const { dropInterval } = await sessionsMod();
    const id = await threeSittings();

    const view = dropInterval(id, at('09:00'), at('12:00'));

    assert.equal(view.elapsedSeconds, 0);
    assert.deepEqual(await segmentsOf(id), []);
  });

  it('changes nothing for a stretch that falls where the clock was not running', async () => {
    const { dropInterval } = await sessionsMod();
    const id = await threeSittings();
    const before = await stored(id);
    // Later, so that a block that was written to would show it in when it was last touched.
    advance(5 * MINUTE);

    // The gap between two sittings, and a stretch wholly after the block ended.
    dropInterval(id, at('10:20'), at('10:30'));
    dropInterval(id, at('12:00'), at('13:00'));

    assert.deepEqual(await stored(id), before);
  });

  it('refuses a stretch that ends before it starts, and a block that is not there', async () => {
    const { dropInterval } = await sessionsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('10:50'));
    const before = await stored(block.id);

    assert.throws(() => dropInterval(block.id, at('10:40'), at('10:10')), { status: 400 });
    assert.throws(() => dropInterval(block.id, at('10:10'), at('10:10')), { status: 400 });
    assert.throws(() => dropInterval(999_999, at('10:10'), at('10:40')), { status: 404 });
    assert.deepEqual(await stored(block.id), before);
  });

  it('applies whole or not at all', async () => {
    const { dropInterval } = await sessionsMod();
    const { db } = await dbMod();
    const id = await threeSittings();
    const before = await stored(id);
    assert.equal(before.block.active_seconds, 3600);
    assert.equal(before.segments.length, 3);

    // The runs are rewritten first and the total is written last, so failing the total must
    // put the runs back. The failure is made by a TEMP trigger that is dropped again below.
    db.exec(`CREATE TEMP TRIGGER fail_the_total BEFORE UPDATE OF active_seconds ON sessions
             BEGIN SELECT RAISE(ABORT, 'tripwire'); END`);
    try {
      assert.throws(() => dropInterval(id, at('10:15'), at('11:10')), /tripwire/);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_the_total');
    }
    assert.deepEqual(await stored(id), before);

    // Without the failure the same call goes through, all of it.
    assert.equal(dropInterval(id, at('10:15'), at('11:10')).elapsedSeconds, 1500);
    assert.equal((await stored(id)).segments.length, 2);
  });
});

describe('cutting a stretch out of spans', () => {
  const S = (start: number, end: number | null): Span => ({ start, end });
  const NOW = 1000;

  it('splits a span that holds the stretch, trims one it crosses, and drops one it covers', () => {
    assert.deepEqual(cutOut([S(0, 100)], 20, 40, NOW), {
      spans: [S(0, 20), S(40, 100)],
      removedMs: 20,
    });
    assert.deepEqual(cutOut([S(0, 100)], 50, 150, NOW), { spans: [S(0, 50)], removedMs: 50 });
    assert.deepEqual(cutOut([S(0, 100)], -50, 30, NOW), { spans: [S(30, 100)], removedMs: 30 });
    assert.deepEqual(cutOut([S(10, 20)], 0, 100, NOW), { spans: [], removedMs: 10 });
  });

  it('leaves a span the stretch only touches, and spans it misses', () => {
    const spans = [S(0, 10), S(20, 30)];
    assert.deepEqual(cutOut(spans, 10, 20, NOW), { spans, removedMs: 0 });
    assert.deepEqual(cutOut(spans, 40, 50, NOW), { spans, removedMs: 0 });
  });

  it('never leaves an empty span when the stretch begins or ends exactly where a span does', () => {
    assert.deepEqual(cutOut([S(0, 100)], 0, 40, NOW), { spans: [S(40, 100)], removedMs: 40 });
    assert.deepEqual(cutOut([S(0, 100)], 60, 100, NOW), { spans: [S(0, 60)], removedMs: 40 });
    assert.deepEqual(cutOut([S(0, 100)], 0, 100, NOW), { spans: [], removedMs: 100 });
    assert.deepEqual(cutOut([S(0, null)], 0, 300, NOW), { spans: [S(300, null)], removedMs: 300 });
  });

  it('puts the spans out in time order whatever order they came in', () => {
    assert.deepEqual(cutOut([S(50, 60), S(0, 10)], 5, 55, NOW), {
      spans: [S(0, 5), S(55, 60)],
      removedMs: 10,
    });
  });

  it('keeps an open span open, carrying on from the end of the stretch', () => {
    assert.deepEqual(cutOut([S(0, null)], 100, 300, NOW), {
      spans: [S(0, 100), S(300, null)],
      removedMs: 200,
    });
    // A stretch that reaches past now can only take out what has happened already.
    assert.deepEqual(cutOut([S(0, null)], 900, 5000, NOW), {
      spans: [S(0, 900), S(NOW, null)],
      removedMs: 100,
    });
    // One that has not started yet takes nothing.
    assert.deepEqual(cutOut([S(0, null)], 2000, 3000, NOW), { spans: [S(0, null)], removedMs: 0 });
  });

  it('finds the moment the running total reached a length', () => {
    const spans = [S(100, 110), S(200, null)];
    assert.equal(reachedAt(spans, 4, NOW), 104);
    assert.equal(reachedAt(spans, 10, NOW), 110);
    assert.equal(reachedAt(spans, 15, NOW), 205);
    assert.equal(reachedAt(spans, 10 + (NOW - 200), NOW), NOW);
    assert.equal(reachedAt(spans, 10 + (NOW - 200) + 1, NOW), null);
  });
});

describe('finding the time that spans leave free', () => {
  const S = (start: number, end: number | null): Span => ({ start, end });
  const G = (start: number, end: number) => ({ start, end });
  const NOW = 1000;

  it('is the whole stretch when nothing is in it', () => {
    assert.deepEqual(gapsIn([], 10, 50, NOW), [G(10, 50)]);
    assert.deepEqual(gapsIn([S(60, 70), S(0, 5), S(0, 10)], 10, 50, NOW), [G(10, 50)]);
  });

  it('is what lies between the spans, in time order whatever order they came in', () => {
    assert.deepEqual(gapsIn([S(30, 40), S(10, 20)], 0, 50, NOW), [G(0, 10), G(20, 30), G(40, 50)]);
  });

  it('takes spans that overlap, touch or reach outside the stretch as one covered stretch', () => {
    assert.deepEqual(gapsIn([S(0, 25), S(20, 30), S(30, 35), S(45, 90)], 10, 50, NOW), [G(35, 45)]);
  });

  it('is nothing when the stretch is covered, or is not a stretch', () => {
    assert.deepEqual(gapsIn([S(0, 100)], 10, 50, NOW), []);
    assert.deepEqual(gapsIn([S(0, 30), S(30, 60)], 10, 50, NOW), []);
    assert.deepEqual(gapsIn([], 50, 50, NOW), []);
    assert.deepEqual(gapsIn([], 50, 10, NOW), []);
  });

  it('counts a span that is open as ticking up to now, and a span with no length as nothing', () => {
    assert.deepEqual(gapsIn([S(20, null)], 10, 50, 30), [G(10, 20), G(30, 50)]);
    // One that is said to have begun after now has not run at all.
    assert.deepEqual(gapsIn([S(40, null)], 10, 50, 30), [G(10, 50)]);
    assert.deepEqual(gapsIn([S(20, 20)], 10, 50, NOW), [G(10, 50)]);
  });
});

describe('time that is set by hand while a stretch is waiting to be answered', () => {
  let api: Api;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  /** A block on the clock since 10:00, and at 11:00 the machine says it was away from 10:20 to 10:40. */
  async function withAStretchWaiting() {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const res = await api.call('POST', `/sessions/${block.id}/away`, {
      startedAt: at('10:20'),
      endedAt: at('10:40'),
    });
    const away = res.body.away.id as number;
    return { block, away, promptId: await awayPromptId(away) };
  }

  const awayPrompts = async () =>
    ((await api.call('GET', '/prompts')).body as { kind: string }[]).filter(
      (p) => p.kind === 'away',
    );
  const elapsed = async (id: number) => {
    const { toView, getSessionRow } = await sessionsMod();
    return toView(getSessionRow(id)).elapsedSeconds;
  };

  /** What has to be true once the person has said what the time was. */
  async function assertSettled(away: number, promptId: string, blockId: number, seconds: number) {
    const row = await awayRow(away);
    assert.equal(row?.status, 'kept');
    assert.equal(row?.resolved_at, at('11:00'));
    assert.deepEqual(await awayPrompts(), []);
    // The Drop button of a banner that is still on screen: it is out of date, and does nothing.
    assert.equal(await api.status('POST', '/prompts/act', { id: promptId, action: 'drop' }), 409);
    assert.equal(await elapsed(blockId), seconds);
  }

  it('answers the stretch as kept when the time of a finished block is typed in', async () => {
    const { stopSession } = await sessionsMod();
    const { block, away, promptId } = await withAStretchWaiting();
    stopSession(block.id, 'completed');

    // The twenty minutes away have been taken off by hand: forty are left.
    const res = await api.call('PATCH', `/sessions/${block.id}`, { activeSeconds: 2400 });

    assert.equal(res.status, 200);
    await assertSettled(away, promptId, block.id, 2400);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:00'), ended_at: at('10:40') },
    ]);
  });

  it('answers the stretch as kept when a block is finished with its time given', async () => {
    const { block, away, promptId } = await withAStretchWaiting();

    const res = await api.call('POST', `/sessions/${block.id}/complete`, { activeSeconds: 2400 });

    assert.equal(res.status, 200);
    await assertSettled(away, promptId, block.id, 2400);
  });

  it('answers the stretch as kept when a finished block is moved to another time', async () => {
    const { stopSession } = await sessionsMod();
    const { block, away, promptId } = await withAStretchWaiting();
    stopSession(block.id, 'completed');

    // It really happened half an hour later: the stretch no longer lines up with it.
    const res = await api.call('POST', `/sessions/${block.id}/reschedule`, {
      startedAt: at('10:30'),
    });

    assert.equal(res.status, 200);
    await assertSettled(away, promptId, block.id, 3600);
    assert.deepEqual(await segmentsOf(block.id), [
      { started_at: at('10:30'), ended_at: at('11:30') },
    ]);
  });

  it('leaves a stretch waiting when something else about the block is edited, and one on another block', async () => {
    const { stopSession } = await sessionsMod();
    const { block, away } = await withAStretchWaiting();
    stopSession(block.id, 'completed');
    const second = await startBlock('Second block');
    goTo(at('11:30'));
    const other = await api.call('POST', `/sessions/${second.id}/away`, {
      startedAt: at('11:10'),
      endedAt: at('11:20'),
    });

    // Not the time: the stretch is still the person's to answer.
    await api.call('PATCH', `/sessions/${block.id}`, { title: 'Renamed', focusRating: 4 });
    assert.equal((await awayRow(away))?.status, 'pending');

    // The time of one block settles that block's stretches and no other's.
    await api.call('PATCH', `/sessions/${block.id}`, { activeSeconds: 2400 });
    assert.equal((await awayRow(away))?.status, 'kept');
    assert.equal((await awayRow(other.body.away.id))?.status, 'pending');
    assert.equal((await awayPrompts()).length, 1);
  });
});
