import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { type Api, freeze, goTo, makeProject, reset, serve } from './prompt-helpers.js';

/*
 * A request that names something that is not there, or sends a value that is not one, is the
 * caller's mistake: a 400 that says so, with nothing written. Left to SQLite or to Date, the
 * same requests were a 500, and the one that mattered most could not finish a block at all.
 */

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

async function count(table: string): Promise<number> {
  const { db } = await dbMod();
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('a project that is not there', () => {
  it('is a 400 when a block is finished, and the block is left on the clock as it was', async () => {
    const { db } = await dbMod();
    const project = await makeProject('Billing');
    const started = await api.call('POST', '/sessions', { title: 'Deep work', projectId: project });
    assert.equal(started.status, 201);
    const id = started.body.id as number;
    // Deleted for good from another window, while the dialog to finish the block still has it.
    assert.equal((await api.call('DELETE', `/projects/${project}?hard=true`)).status, 200);
    goTo('2026-10-12T14:25:00.000Z');

    const stored = () => ({
      block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
      runs: db.prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id').all(id),
    });
    const before = stored();
    for (const action of ['complete', 'abandon']) {
      const res = await api.call('POST', `/sessions/${id}/${action}`, {
        projectId: project,
        focusRating: 4,
        notes: 'Done',
      });
      assert.equal(res.status, 400, action);
      assert.equal(res.body.error, 'Unknown project');
      assert.deepEqual(stored(), before, action);
    }
    const active = await api.call('GET', '/sessions/active');
    assert.equal(active.body.session?.id, id);
    assert.equal(active.body.session?.status, 'running');
    assert.equal(active.body.session?.elapsedSeconds, 25 * 60);

    // Sent again without it, the block finishes.
    const done = await api.call('POST', `/sessions/${id}/complete`, { focusRating: 4 });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'completed');
    assert.equal(done.body.elapsedSeconds, 25 * 60);
  });

  it('is a 400 when a block is logged by hand, and nothing is logged', async () => {
    const res = await api.call('POST', '/sessions/manual', {
      title: 'Call',
      startedAt: '2026-10-12T09:00:00.000Z',
      minutes: 30,
      projectId: 4242,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown project');
    assert.equal(await count('sessions'), 0);
    assert.equal(await count('session_segments'), 0);
  });

  it('is a 400 when a plan item is added or moved to it, and the plan is left alone', async () => {
    const added = await api.call('POST', '/plan', {
      day: '2026-10-12',
      title: 'Draft',
      projectId: 4242,
    });
    assert.equal(added.status, 400);
    assert.equal(added.body.error, 'Unknown project');
    assert.equal(await count('plan_items'), 0);

    const item = await api.call('POST', '/plan', { day: '2026-10-12', title: 'Draft' });
    assert.equal(item.status, 201);
    const moved = await api.call('PATCH', `/plan/${item.body.id}`, {
      title: 'Renamed',
      projectId: 4242,
    });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.error, 'Unknown project');
    const [listed] = (await api.call('GET', '/plan?day=2026-10-12')).body;
    assert.equal(listed.title, 'Draft');
    assert.equal(listed.projectId, null);

    // One that is there is taken, and null still takes it off again.
    const project = await makeProject('Billing');
    const onIt = await api.call('PATCH', `/plan/${item.body.id}`, { projectId: project });
    assert.equal(onIt.status, 200);
    assert.equal(onIt.body.projectId, project);
    const offIt = await api.call('PATCH', `/plan/${item.body.id}`, { projectId: null });
    assert.equal(offIt.status, 200);
    assert.equal(offIt.body.projectId, null);
  });

  it('is a 400 when a timer is pinned to it, and nothing is pinned', async () => {
    const res = await api.call('POST', '/timers', { title: 'Standup', projectId: 4242 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown project');
    assert.equal(await count('saved_timers'), 0);

    const project = await makeProject('Billing');
    const pinned = await api.call('POST', '/timers', { title: 'Standup', projectId: project });
    assert.equal(pinned.status, 201);
    assert.equal(pinned.body[0]?.projectId, project);
  });
});

describe('a timezone that does not exist', () => {
  it('is a 400, and nothing in the request is saved', async () => {
    const was = (await api.call('GET', '/settings')).body;
    for (const timezone of ['invalid/zone', 'Z', 'UTC+5', ' UTC']) {
      const res = await api.call('PATCH', '/settings', { timezone, daily_target_minutes: 120 });
      assert.equal(res.status, 400, timezone);
      assert.equal(res.body.error, `Unknown timezone: ${timezone}`);
    }
    const now = (await api.call('GET', '/settings')).body;
    assert.equal(now.timezone, was.timezone);
    assert.equal(now.daily_target_minutes, was.daily_target_minutes);

    // A zone that is there is taken.
    const res = await api.call('PATCH', '/settings', { timezone: 'Asia/Kathmandu' });
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, 'Asia/Kathmandu');
  });
});

describe('how many to list', () => {
  it('is a whole number of blocks from 1 to 2000, and anything else is a 400', async () => {
    for (const hour of ['09', '10', '11']) {
      const res = await api.call('POST', '/sessions/manual', {
        title: `Block at ${hour}`,
        startedAt: `2026-10-12T${hour}:00:00.000Z`,
        minutes: 30,
      });
      assert.equal(res.status, 201);
    }
    // Minus one was SQLite's "no limit", and gave every block there is.
    for (const limit of ['abc', '1.5', '-1', '0', '2001', '1e400']) {
      const res = await api.call('GET', `/sessions?limit=${limit}`);
      assert.equal(res.status, 400, limit);
    }
    const one = await api.call('GET', '/sessions?limit=1');
    assert.equal(one.status, 200);
    assert.deepEqual(
      one.body.map((s: { title: string }) => s.title),
      ['Block at 11'],
    );
    assert.equal((await api.call('GET', '/sessions?limit=2000')).body.length, 3);
    assert.equal((await api.call('GET', '/sessions')).body.length, 3);
  });

  it('is a whole number of timers from 1 to 60, and anything else is a 400', async () => {
    for (const title of ['Standup', 'Review']) {
      assert.equal((await api.call('POST', '/timers', { title })).status, 201);
    }
    for (const limit of ['abc', '1.5', '-1', '0', '61']) {
      const res = await api.call('GET', `/timers?limit=${limit}`);
      assert.equal(res.status, 400, limit);
    }
    // Every pinned timer is listed whatever the limit, which caps the suggestions after them.
    assert.equal((await api.call('GET', '/timers?limit=1')).body.length, 2);
    assert.equal((await api.call('GET', '/timers?limit=60')).body.length, 2);
    assert.equal((await api.call('GET', '/timers')).body.length, 2);
  });
});
