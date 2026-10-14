import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { type Api, freeze, makeProject, reset, serve } from './prompt-helpers.js';

const dbMod = () => import('../src/db.js');

/** A Monday afternoon, and the clock every test here starts at. */
const NOW = '2026-10-12T14:00:00.000Z';

let api: Api;

before(async () => {
  api = await serve();
});

after(async () => {
  await api.close();
});

beforeEach(async () => {
  await reset();
  freeze(NOW);
});

afterEach(() => {
  mock.timers.reset();
});

/** Log a block by hand, half an hour long unless it says otherwise. */
const manual = (startedAt: string, rest: Record<string, unknown> = {}) =>
  api.call('POST', '/sessions/manual', { title: 'Logged', startedAt, minutes: 30, ...rest });

async function blockCount(): Promise<number> {
  const { db } = await dbMod();
  return (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
}

/** A block's times as they are in the tables, its runs of the clock with them. */
async function stored(id: number) {
  const { db } = await dbMod();
  return {
    block: db.prepare('SELECT started_at, ended_at, local_day FROM sessions WHERE id = ?').get(id),
    runs: db
      .prepare('SELECT started_at, ended_at FROM session_segments WHERE session_id = ?')
      .all(id),
  };
}

describe('the start of a block logged by hand', () => {
  it('is stored as the instant it names, in UTC to the millisecond', async () => {
    // Ten hours ahead of UTC, so 09:00 there.
    const res = await manual('2025-03-10T19:00:00+10:00');
    assert.equal(res.status, 201);
    assert.equal(res.body.startedAt, '2025-03-10T09:00:00.000Z');
    assert.equal(res.body.endedAt, '2025-03-10T09:30:00.000Z');
    assert.deepEqual(await stored(res.body.id), {
      block: {
        started_at: '2025-03-10T09:00:00.000Z',
        ended_at: '2025-03-10T09:30:00.000Z',
        local_day: '2025-03-10',
      },
      runs: [{ started_at: '2025-03-10T09:00:00.000Z', ended_at: '2025-03-10T09:30:00.000Z' }],
    });

    // Digits past the millisecond go, as they always did from the end.
    const fine = await manual('2025-03-10T08:00:00.123456789Z');
    assert.equal(fine.status, 201);
    assert.equal(fine.body.startedAt, '2025-03-10T08:00:00.123Z');
  });

  it('lists blocks by when they were, whatever offset each was given in', async () => {
    assert.equal((await manual('2025-03-10T19:00:00+10:00', { title: 'Nine' })).status, 201);
    assert.equal((await manual('2025-03-10T10:00:00Z', { title: 'Ten' })).status, 201);
    assert.equal((await manual('2025-03-10T08:00:00.123456789Z', { title: 'Eight' })).status, 201);
    const listed = await api.call('GET', '/sessions?day=2025-03-10');
    assert.deepEqual(
      listed.body.map((s: { title: string }) => s.title),
      ['Ten', 'Nine', 'Eight'],
    );
  });

  it('is the last time its project was worked on only when it is the latest', async () => {
    const project = await makeProject('Billing');
    assert.equal((await manual('2025-03-10T09:30:00Z', { projectId: project })).status, 201);
    // Twelve hours ahead, 20:00 is 08:00 UTC: earlier, for all its digits are later.
    assert.equal((await manual('2025-03-10T20:00:00+12:00', { projectId: project })).status, 201);
    const projects = await api.call('GET', '/projects');
    const billing = projects.body.find((p: { id: number }) => p.id === project);
    assert.equal(billing.lastWorkedAt, '2025-03-10T09:30:00.000Z');
  });
});

describe('a block moved to another start', () => {
  it('is stored as the instant it names, in UTC to the millisecond, and so is its run', async () => {
    const logged = await manual('2025-03-10T09:00:00Z');
    const moved = await api.call('POST', `/sessions/${logged.body.id}/reschedule`, {
      startedAt: '2025-03-11T19:00:00+10:00',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.startedAt, '2025-03-11T09:00:00.000Z');
    assert.equal(moved.body.day, '2025-03-11');
    assert.deepEqual(await stored(logged.body.id), {
      block: {
        started_at: '2025-03-11T09:00:00.000Z',
        ended_at: '2025-03-11T09:30:00.000Z',
        local_day: '2025-03-11',
      },
      runs: [{ started_at: '2025-03-11T09:00:00.000Z', ended_at: '2025-03-11T09:30:00.000Z' }],
    });
  });
});

describe('a block logged by hand that starts ahead of the clock', () => {
  it('is refused past the few seconds two clocks can differ by, and nothing is logged', async () => {
    for (const startedAt of [
      '2026-10-12T14:00:05.001Z',
      // Two hours ahead of UTC, 16:00:06 is six seconds after 14:00 UTC.
      '2026-10-12T16:00:06+02:00',
      // The year typed wrong.
      '2062-10-12T10:00:00Z',
    ]) {
      const res = await manual(startedAt);
      assert.equal(res.status, 400, startedAt);
      assert.equal(res.body.error, 'A block cannot be logged before it starts');
    }
    assert.equal(await blockCount(), 0);

    // Up to five seconds ahead is two clocks that differ, and is logged.
    assert.equal((await manual('2026-10-12T14:00:05.000Z')).status, 201);
    // And a block that began before now may run on past it.
    assert.equal((await manual('2026-10-12T13:50:00Z', { minutes: 30 })).status, 201);
    assert.equal(await blockCount(), 2);
  });
});

describe('the nothing-on-the-clock nudge, with a block dated ahead of the clock', () => {
  const nudges = async () =>
    ((await api.call('GET', '/prompts')).body as { id: string; kind: string }[])
      .filter((p) => p.kind === 'idle')
      .map((p) => p.id);

  it('is still asked: a block that has not ended by now does not put it off', async () => {
    // A server that has been up all day, so the quiet runs from when work started.
    (await import('../src/lib/reminders.js')).setServerStartedAt(0);
    assert.deepEqual(await nudges(), ['idle:2026-10-12T09:00:00.000Z']);

    // A block that ended at 12:30 starts the quiet there.
    assert.equal((await manual('2026-10-12T12:00:00Z')).status, 201);
    assert.deepEqual(await nudges(), ['idle:2026-10-12T12:30:00.000Z']);

    // Another moved decades on by the year typed wrong. It has not ended, so the quiet still
    // runs from 12:30, and the nudge is not put off until then.
    const slip = await manual('2026-10-12T10:00:00Z');
    const moved = await api.call('POST', `/sessions/${slip.body.id}/reschedule`, {
      startedAt: '2062-10-12T10:00:00Z',
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(await nudges(), ['idle:2026-10-12T12:30:00.000Z']);
  });
});
