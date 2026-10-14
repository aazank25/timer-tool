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
  /** What a limit that is not a number of rows at all is: a word, a fraction, one too big to be. */
  const NOT_A_NUMBER = ['abc', '1.5', '0.5', '1e400', 'Infinity', '1,5', '1 2'];

  /**
   * Completed blocks, written straight into the table: a test cannot be made to log thousands one
   * request at a time. A minute apart, so that the order they are listed in is known.
   */
  async function insertBlocks(count: number, title: (i: number) => string) {
    const { db } = await dbMod();
    const insert = db.prepare(
      `INSERT INTO sessions
         (title, kind, planned_minutes, started_at, ended_at, local_day, active_seconds, status,
          created_at, updated_at)
       VALUES (?, 'focus', 25, ?, ?, '2026-10-12', 1500, 'completed', ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const at = new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString();
        insert.run(title(i), at, at, NOW, NOW);
      }
    })();
  }

  const titles = (blocks: { title: string }[]) => blocks.map((block) => block.title);

  it('is a whole number of blocks, and a word or a fraction is a 400', async () => {
    for (const limit of NOT_A_NUMBER) {
      const res = await api.call('GET', `/sessions?limit=${limit}`);
      assert.equal(res.status, 400, limit);
    }
  });

  it('is held to 1 to 2000 when it is a whole number outside them, and is never no limit at all', async () => {
    for (const hour of ['09', '10', '11']) {
      const res = await api.call('POST', '/sessions/manual', {
        title: `Block at ${hour}`,
        startedAt: `2026-10-12T${hour}:00:00.000Z`,
        minutes: 30,
      });
      assert.equal(res.status, 201);
    }
    // Minus one is SQLite's "no limit", and would list every block there is. It is raised to 1
    // with the rest, so that no whole number gets as far as SQLite as anything but a number of rows.
    for (const limit of ['0', '-0', '-1', '-5', '-1000000']) {
      const res = await api.call('GET', `/sessions?limit=${limit}`);
      assert.equal(res.status, 200, limit);
      assert.deepEqual(titles(res.body), ['Block at 11'], limit);
    }
    const two = await api.call('GET', '/sessions?limit=2');
    assert.deepEqual(titles(two.body), ['Block at 11', 'Block at 10']);
    // Above 2000 is 2000, which is every block there is here.
    for (const limit of ['2000', '2001', '5000']) {
      assert.equal((await api.call('GET', `/sessions?limit=${limit}`)).body.length, 3, limit);
    }
    assert.equal((await api.call('GET', '/sessions')).body.length, 3);
  });

  it('is held to 2000 at the top, where there are more blocks than that', async () => {
    await insertBlocks(2005, (i) => `Block ${i}`);
    for (const limit of ['2000', '2001', '5000', '1e21']) {
      const res = await api.call('GET', `/sessions?limit=${limit}`);
      assert.equal(res.status, 200, limit);
      assert.equal(res.body.length, 2000, limit);
    }
    // Newest first, so what is cut off is the oldest.
    const all = await api.call('GET', '/sessions?limit=5000');
    assert.equal(all.body[0].title, 'Block 2004');
    assert.equal(all.body[1999].title, 'Block 5');
    assert.equal((await api.call('GET', '/sessions?limit=3')).body.length, 3);
    // With none said there is a smaller one of its own.
    assert.equal((await api.call('GET', '/sessions')).body.length, 500);
  });

  it('is a whole number of timers, and a word or a fraction is a 400', async () => {
    for (const limit of NOT_A_NUMBER) {
      const res = await api.call('GET', `/timers?limit=${limit}`);
      assert.equal(res.status, 400, limit);
    }
  });

  it('is held to 1 to 60 timers when it is a whole number outside them, and never none or all', async () => {
    // What is suggested comes from what has been done: seventy different titles, once each.
    await insertBlocks(70, (i) => `Title ${String(i).padStart(2, '0')}`);
    const listed = async (limit: string) => {
      const res = await api.call('GET', `/timers?limit=${limit}`);
      assert.equal(res.status, 200, limit);
      return res.body.length as number;
    };
    for (const limit of ['0', '-0', '-1', '-3', '-1000000']) assert.equal(await listed(limit), 1, limit);
    assert.equal(await listed('1'), 1);
    assert.equal(await listed('2'), 2);
    assert.equal(await listed('60'), 60);
    for (const limit of ['61', '1000', '1e21']) assert.equal(await listed(limit), 60, limit);
    // With none said there are eighteen.
    assert.equal((await api.call('GET', '/timers')).body.length, 18);
  });

  it('lists every pinned timer whatever the limit, which holds the suggestions after them to it', async () => {
    for (const title of ['Standup', 'Review']) {
      assert.equal((await api.call('POST', '/timers', { title })).status, 201);
    }
    for (const limit of ['-1', '0', '1', '60', '61']) {
      assert.equal((await api.call('GET', `/timers?limit=${limit}`)).body.length, 2, limit);
    }
    assert.equal((await api.call('GET', '/timers')).body.length, 2);
  });
});
