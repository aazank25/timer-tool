import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import { INTERRUPTION_REASONS, type InterruptionReason } from '../src/lib/interruptions.js';
import { freshDb } from './setup.js';

const dbMod = () => import('../src/db.js');
const settingsMod = () => import('../src/lib/settings.js');
const tasksMod = () => import('../src/lib/tasks.js');

const NOON = '2026-10-12T12:00:00.000Z';

/** A clean database, with the user's day pinned to UTC and rolling over at 04:00. */
async function reset() {
  await freshDb();
  const { setSettings } = await settingsMod();
  setSettings({ timezone: 'UTC', day_start_hour: 4 });
}

/** Stop the wall clock at an instant, so "today" and every default window are exact. */
function freeze(iso: string) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}

/** The API on a loopback port of its own, so a route's validation and wiring are tested too. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text && res.headers.get('content-type')?.includes('json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (json ? JSON.parse(text) : text || undefined) as any };
  };

  return {
    call,
    status: async (method: string, url: string, body?: unknown) =>
      (await call(method, url, body)).status,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function makeProject(name: string, color = '#0ea5e9'): Promise<number> {
  const { db } = await dbMod();
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, color, now, now);
  return Number(info.lastInsertRowid);
}

interface BlockSeed {
  day: string;
  kind?: 'focus' | 'break';
  status?: 'completed' | 'abandoned' | 'running';
  projectId?: number | null;
  taskId?: number | null;
  seconds?: number;
  estimatedMinutes?: number | null;
  /** What each interruption that has a row was; null is one logged with "No reason". */
  reasons?: (InterruptionReason | null)[];
  /** The block's count, when that is not the number of rows: a block from before reasons has no rows. */
  interruptions?: number;
}

/**
 * A block exactly as described, written straight to the tables, so a test can put it on any
 * day and in any state, with a count that does or does not agree with its rows.
 */
async function seed(b: BlockSeed): Promise<number> {
  const { db } = await dbMod();
  const reasons = b.reasons ?? [];
  const startedAt = `${b.day}T10:00:00.000Z`;
  const status = b.status ?? 'completed';
  const info = db
    .prepare(
      `INSERT INTO sessions
        (project_id, task_id, title, kind, planned_minutes, estimated_minutes, started_at,
         ended_at, local_day, active_seconds, interruptions, status, created_at, updated_at)
       VALUES (?, ?, 'Seeded block', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.projectId ?? null,
      b.taskId ?? null,
      b.kind ?? 'focus',
      b.estimatedMinutes ?? null,
      startedAt,
      status === 'running' ? null : startedAt,
      b.day,
      b.seconds ?? 0,
      b.interruptions ?? reasons.length,
      status,
      startedAt,
      startedAt,
    );
  const id = Number(info.lastInsertRowid);
  const row = db.prepare('INSERT INTO interruptions (session_id, at, reason) VALUES (?, ?, ?)');
  for (const reason of reasons) row.run(id, startedAt, reason);
  return id;
}

/** The rows of `interruptions` for a block, oldest first, as the reasons they carry. */
async function reasonsOf(sessionId: number): Promise<(string | null)[]> {
  const { db } = await dbMod();
  return (
    db.prepare('SELECT reason FROM interruptions WHERE session_id = ? ORDER BY id').all(sessionId) as {
      reason: string | null;
    }[]
  ).map((r) => r.reason);
}

async function countOf(sessionId: number): Promise<number> {
  const { db } = await dbMod();
  return (
    db.prepare('SELECT interruptions AS n FROM sessions WHERE id = ?').get(sessionId) as {
      n: number;
    }
  ).n;
}

async function everyRow(table: 'interruptions' | 'sessions') {
  const { db } = await dbMod();
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

/* ------------------------------------------------------------ the reason list */

describe('the interruption reasons', () => {
  it('are these six, with these labels, in this order', () => {
    assert.deepEqual(
      INTERRUPTION_REASONS.map((r) => [r.key, r.label]),
      [
        ['chat', 'Slack / chat'],
        ['meeting', 'Meeting'],
        ['person', 'Someone stopped by'],
        ['phone', 'Phone call'],
        ['email', 'Email'],
        ['other', 'Something else'],
      ],
    );
  });

  it('are the ones the table accepts, and nothing else', async () => {
    await reset();
    const { db } = await dbMod();
    const id = await seed({ day: '2026-10-12' });
    const add = db.prepare('INSERT INTO interruptions (session_id, at, reason) VALUES (?, ?, ?)');
    for (const { key } of INTERRUPTION_REASONS) add.run(id, NOON, key);
    add.run(id, NOON, null);
    assert.equal((await reasonsOf(id)).length, INTERRUPTION_REASONS.length + 1);
    for (const bad of ['bogus', '', 'CHAT', 'Slack / chat']) {
      assert.throws(() => add.run(id, NOON, bad), /CHECK/, `reason ${bad}`);
    }
  });
});

/* ------------------------------------------------- logging one over the API */

describe('logging an interruption with a reason', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });
  beforeEach(reset);
  after(() => api.close());

  /** A block on the clock, and its id. */
  async function startBlock(title = 'Deep work') {
    const res = await api.call('POST', '/sessions', { title });
    assert.equal(res.status, 201);
    return res.body.id as number;
  }
  const log = (id: number, body?: unknown) => api.call('POST', `/sessions/${id}/interruption`, body);

  it('stores a row for each reason, beside the count', async () => {
    const id = await startBlock();
    let count = 0;
    for (const { key } of INTERRUPTION_REASONS) {
      const res = await log(id, { reason: key });
      assert.equal(res.status, 200);
      count += 1;
      // The answer is still the block, with the count the Focus screen shows.
      assert.equal(res.body.id, id);
      assert.equal(res.body.interruptions, count);
    }
    assert.deepEqual(
      await reasonsOf(id),
      INTERRUPTION_REASONS.map((r) => r.key),
    );
    assert.equal(await countOf(id), INTERRUPTION_REASONS.length);
  });

  it('stores a row with no reason when none is given, however it is asked', async () => {
    const id = await startBlock();
    // Nothing at all, an empty body, and a body with only a delta: the old ways of asking.
    assert.equal((await log(id)).body.interruptions, 1);
    assert.equal((await log(id, {})).body.interruptions, 2);
    assert.equal((await log(id, { delta: 1 })).body.interruptions, 3);
    assert.deepEqual(await reasonsOf(id), [null, null, null]);
  });

  it('gives each of several added at once a row of its own, with the reason', async () => {
    const id = await startBlock();
    const res = await log(id, { delta: 3, reason: 'meeting' });
    assert.equal(res.body.interruptions, 3);
    assert.deepEqual(await reasonsOf(id), ['meeting', 'meeting', 'meeting']);
  });

  it('refuses a reason that is not on the list, and writes nothing', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    const rows = await everyRow('interruptions');
    const blocks = await everyRow('sessions');

    const bad: unknown[] = ['bogus', '', 'CHAT', 'Slack / chat', ' chat', 5, null, true, ['chat']];
    for (const reason of bad) {
      const res = await log(id, { reason });
      assert.equal(res.status, 400, `reason ${JSON.stringify(reason)}`);
      assert.equal(res.body.error, 'Invalid request');
    }
    // A good delta beside a bad reason is refused whole: not even the count moves.
    assert.equal(await api.status('POST', `/sessions/${id}/interruption`, { delta: 2, reason: 'nope' }), 400);

    assert.deepEqual(await everyRow('interruptions'), rows);
    assert.deepEqual(await everyRow('sessions'), blocks);
    assert.equal(await countOf(id), 1);
  });

  it('refuses a delta outside -10 to 10 or that is not a whole number, as it always has', async () => {
    const id = await startBlock();
    for (const delta of [11, -11, 1.5, '1', null]) {
      assert.equal(await api.status('POST', `/sessions/${id}/interruption`, { delta }), 400);
    }
    assert.equal(await countOf(id), 0);
    assert.deepEqual(await reasonsOf(id), []);
  });

  it('takes the latest row back with a delta of -1, and never goes below zero', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    await log(id, { reason: 'phone' });
    await log(id, { reason: 'email' });

    const one = await log(id, { delta: -1 });
    assert.equal(one.status, 200);
    assert.equal(one.body.interruptions, 2);
    // The latest is the one that goes, not the first or the most common.
    assert.deepEqual(await reasonsOf(id), ['chat', 'phone']);

    // More than there are: the count stops at zero and so do the rows, with no error.
    const many = await log(id, { delta: -5 });
    assert.equal(many.status, 200);
    assert.equal(many.body.interruptions, 0);
    assert.deepEqual(await reasonsOf(id), []);

    const nothing = await log(id, { delta: -1 });
    assert.equal(nothing.status, 200);
    assert.equal(nothing.body.interruptions, 0);
    assert.deepEqual(await reasonsOf(id), []);
  });

  it("takes back only the block's own rows", async () => {
    const first = await startBlock('First');
    await log(first, { reason: 'chat' });
    await api.call('POST', `/sessions/${first}/complete`, {});
    const second = await startBlock('Second');
    await log(second, { reason: 'phone' });
    await log(second, { reason: 'email' });

    await log(second, { delta: -2 });
    assert.deepEqual(await reasonsOf(second), []);
    assert.deepEqual(await reasonsOf(first), ['chat']);
    assert.equal(await countOf(first), 1);
  });

  it('only lowers the count of a block from before reasons, which has no rows to take', async () => {
    const id = await startBlock();
    const { db } = await dbMod();
    // As it would be on a database from before: a count that no row stands behind.
    db.prepare('UPDATE sessions SET interruptions = 2 WHERE id = ?').run(id);

    const res = await log(id, { delta: -1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.interruptions, 1);
    assert.deepEqual(await reasonsOf(id), []);

    // And one added now has a row, beside the one that does not.
    assert.equal((await log(id, { reason: 'person' })).body.interruptions, 2);
    assert.deepEqual(await reasonsOf(id), ['person']);
  });

  it('means nothing by a reason that comes with a negative or zero delta', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    await log(id, { reason: 'phone' });

    // Nothing is added, so there is no interruption for the reason to describe.
    assert.equal((await log(id, { delta: -1, reason: 'email' })).body.interruptions, 1);
    assert.deepEqual(await reasonsOf(id), ['chat']);
    assert.equal((await log(id, { delta: 0, reason: 'email' })).body.interruptions, 1);
    assert.deepEqual(await reasonsOf(id), ['chat']);
  });

  it('takes the newest rows down with a count that is lowered in the block editor, so the next reason is its own', async () => {
    const id = await startBlock();
    for (const reason of ['chat', 'phone', 'email', 'chat']) await log(id, { reason });
    await api.call('POST', `/sessions/${id}/pause`);

    // Four down to two: the two newest rows go, the two oldest are what the block still has.
    const lowered = await api.call('PATCH', `/sessions/${id}`, { interruptions: 2 });
    assert.equal(lowered.status, 200);
    assert.equal(lowered.body.interruptions, 2);
    assert.deepEqual(await reasonsOf(id), ['chat', 'phone']);

    // And the next one logged is the newest, not a row behind the ones that were left.
    assert.equal((await log(id, { reason: 'meeting' })).body.interruptions, 3);
    assert.deepEqual(await reasonsOf(id), ['chat', 'phone', 'meeting']);

    // To nothing at all, and the same again.
    await api.call('PATCH', `/sessions/${id}`, { interruptions: 0 });
    assert.deepEqual(await reasonsOf(id), []);
    assert.equal((await log(id, { reason: 'email' })).body.interruptions, 1);
    assert.deepEqual(await reasonsOf(id), ['email']);
  });

  it('reports the reason of an interruption logged after the count was set to zero as itself', async () => {
    const id = await startBlock();
    for (let n = 0; n < 3; n++) await log(id, { reason: 'chat' });
    await api.call('POST', `/sessions/${id}/pause`);
    assert.equal((await api.call('PATCH', `/sessions/${id}`, { interruptions: 0 })).status, 200);
    await log(id, { reason: 'meeting' });

    const day = (await api.call('GET', '/stats/today')).body.today;
    const res = await api.call('GET', `/stats/interruptions?from=${day}&to=${day}`);
    // One interruption, and it was a meeting: the chats that were taken back are not in it.
    assert.deepEqual(res.body.byReason, [{ reason: 'meeting', label: 'Meeting', count: 1 }]);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.unspecified, 0);
  });

  it('leaves the rows of a block alone when the count is raised or set to what it is, or something else is edited', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    await log(id, { reason: 'phone' });

    for (const interruptions of [2, 5, 999]) {
      assert.equal((await api.call('PATCH', `/sessions/${id}`, { interruptions })).status, 200);
      assert.deepEqual(await reasonsOf(id), ['chat', 'phone'], `count ${interruptions}`);
    }
    // The ones that were added have no reason: the stats call them unspecified.
    await api.call('PATCH', `/sessions/${id}`, { interruptions: 5 });
    const day = (await api.call('GET', '/stats/today')).body.today;
    const res = await api.call('GET', `/stats/interruptions?from=${day}&to=${day}`);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.unspecified, 3);

    // A count is not in the request: no row is touched, whatever else is.
    await api.call('PATCH', `/sessions/${id}`, { title: 'Renamed', notes: 'Fine' });
    assert.deepEqual(await reasonsOf(id), ['chat', 'phone']);
  });

  it('only takes down the rows of the block that was edited, and only lowers the count of a block with none', async () => {
    const first = await startBlock('First');
    await log(first, { reason: 'chat' });
    await log(first, { reason: 'phone' });
    await api.call('POST', `/sessions/${first}/complete`, {});
    const second = await startBlock('Second');
    await log(second, { reason: 'email' });
    await api.call('POST', `/sessions/${second}/pause`);

    await api.call('PATCH', `/sessions/${second}`, { interruptions: 0 });
    assert.deepEqual(await reasonsOf(second), []);
    // The finished block is as it was, rows and count.
    assert.deepEqual(await reasonsOf(first), ['chat', 'phone']);
    assert.equal(await countOf(first), 2);

    // From before reasons: a count and no rows, and lowering it has nothing to take down.
    const { db } = await dbMod();
    db.prepare('UPDATE sessions SET interruptions = 3 WHERE id = ?').run(second);
    const res = await api.call('PATCH', `/sessions/${second}`, { interruptions: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.interruptions, 1);
    assert.deepEqual(await reasonsOf(second), []);
  });

  it('lowers the count and the rows together, or neither', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    await log(id, { reason: 'phone' });
    await api.call('POST', `/sessions/${id}/pause`);
    const { db } = await dbMod();
    const blocks = await everyRow('sessions');
    const rows = await everyRow('interruptions');
    // The count is written first and the rows after it, so a row that cannot be taken down has to
    // take the count back with it. The failure is made by a TEMP trigger, dropped again below.
    db.exec(`CREATE TEMP TRIGGER refuse_the_delete BEFORE DELETE ON interruptions
             BEGIN SELECT RAISE(ABORT, 'the delete was refused'); END`);
    const quiet = mock.method(console, 'error', () => {});
    let failed;
    try {
      failed = await api.call('PATCH', `/sessions/${id}`, { interruptions: 0 });
    } finally {
      quiet.mock.restore();
      db.exec('DROP TRIGGER IF EXISTS refuse_the_delete');
    }
    assert.equal(failed.status, 500);
    assert.match(failed.body.details, /the delete was refused/);
    assert.deepEqual(await everyRow('sessions'), blocks);
    assert.deepEqual(await everyRow('interruptions'), rows);

    // With nothing in the way the same request goes through.
    assert.equal((await api.call('PATCH', `/sessions/${id}`, { interruptions: 0 })).status, 200);
    assert.deepEqual(await reasonsOf(id), []);
    assert.equal(await countOf(id), 0);
  });

  it('writes the count and the row together, or neither', async () => {
    const id = await startBlock();
    const { db } = await dbMod();
    const blocks = await everyRow('sessions');
    // The count is written first and the row after it, so a row that cannot be written has to
    // take the count back with it. The failure is made by a TEMP trigger, dropped again below.
    db.exec(`CREATE TEMP TRIGGER refuse_the_row BEFORE INSERT ON interruptions
             BEGIN SELECT RAISE(ABORT, 'the row was refused'); END`);
    // The server logs the failure it answers with; keep that stack trace out of the report.
    const quiet = mock.method(console, 'error', () => {});
    let failed;
    try {
      failed = await log(id, { reason: 'chat' });
    } finally {
      quiet.mock.restore();
      db.exec('DROP TRIGGER IF EXISTS refuse_the_row');
    }
    assert.equal(failed.status, 500);
    assert.match(failed.body.details, /the row was refused/);
    assert.deepEqual(await everyRow('sessions'), blocks);
    assert.equal(await countOf(id), 0);

    // Nothing is left in the way: with the trigger gone the same request goes through.
    assert.equal((await log(id, { reason: 'chat' })).body.interruptions, 1);
    assert.deepEqual(await reasonsOf(id), ['chat']);
  });

  it('answers 404 to a block that is not there and 400 to an id that is not one, writing nothing', async () => {
    const id = await startBlock();
    await log(id, { reason: 'chat' });
    const rows = await everyRow('interruptions');

    assert.equal(await api.status('POST', '/sessions/999999/interruption', { reason: 'chat' }), 404);
    assert.equal(await api.status('POST', '/sessions/abc/interruption', { reason: 'chat' }), 400);
    assert.equal(await api.status('POST', '/sessions/0/interruption', { reason: 'chat' }), 400);
    assert.deepEqual(await everyRow('interruptions'), rows);
  });

  it("goes with the block when the block is deleted, and leaves other blocks' rows", async () => {
    const first = await startBlock('First');
    await log(first, { reason: 'chat' });
    await api.call('POST', `/sessions/${first}/complete`, {});
    const second = await startBlock('Second');
    await log(second, { reason: 'phone' });
    await api.call('POST', `/sessions/${second}/complete`, {});

    assert.equal(await api.status('DELETE', `/sessions/${first}`), 200);
    assert.deepEqual(await reasonsOf(first), []);
    assert.deepEqual(await reasonsOf(second), ['phone']);
  });
});

/* ------------------------------------------------- the interruption stats */

describe('what interrupted you', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const stats = async (query = '') => {
    const res = await api.call('GET', `/stats/interruptions${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const WEEK = '?from=2026-10-06&to=2026-10-12';

  it('counts each reason, most often first, and leaves out the ones nobody gave', async () => {
    await seed({ day: '2026-10-12', reasons: ['phone', 'chat', 'chat'] });
    await seed({ day: '2026-10-10', reasons: ['chat', 'email', 'phone'] });

    const res = await stats(WEEK);
    assert.deepEqual(res, {
      from: '2026-10-06',
      to: '2026-10-12',
      total: 6,
      byReason: [
        { reason: 'chat', label: 'Slack / chat', count: 3 },
        { reason: 'phone', label: 'Phone call', count: 2 },
        { reason: 'email', label: 'Email', count: 1 },
      ],
      unspecified: 0,
    });
  });

  it('puts two reasons with the same count in the order the reasons are listed in', async () => {
    await seed({ day: '2026-10-12', reasons: ['other', 'email', 'person', 'meeting', 'chat', 'phone'] });
    const res = await stats(WEEK);
    assert.deepEqual(
      res.byReason.map((r: { reason: string }) => r.reason),
      INTERRUPTION_REASONS.map((r) => r.key),
    );
  });

  it('leaves out interruptions on breaks, which are not what it is about', async () => {
    await seed({ day: '2026-10-12', reasons: ['chat'] });
    await seed({ day: '2026-10-12', kind: 'break', reasons: ['chat', 'phone', 'phone'] });
    await seed({ day: '2026-10-12', kind: 'break', interruptions: 4 });

    const res = await stats(WEEK);
    assert.equal(res.total, 1);
    assert.deepEqual(res.byReason, [{ reason: 'chat', label: 'Slack / chat', count: 1 }]);
    assert.equal(res.unspecified, 0);
  });

  it('counts a focus block whatever state it is in', async () => {
    await seed({ day: '2026-10-12', status: 'completed', reasons: ['chat'] });
    await seed({ day: '2026-10-12', status: 'abandoned', reasons: ['chat', 'phone'] });
    await seed({ day: '2026-10-12', status: 'running', reasons: ['email'] });

    const res = await stats(WEEK);
    assert.equal(res.total, 4);
    assert.deepEqual(
      res.byReason.map((r: { reason: string; count: number }) => [r.reason, r.count]),
      [
        ['chat', 2],
        ['phone', 1],
        ['email', 1],
      ],
    );
  });

  it('counts the interruptions with no reason, and those from before reasons, as unspecified', async () => {
    // A block from before reasons: a count and no rows at all.
    await seed({ day: '2026-10-11', interruptions: 3 });
    // One logged with "No reason" has a row, with nothing in it, and one beside it that has one.
    await seed({ day: '2026-10-12', reasons: [null, 'chat'] });
    // And a count that is only partly backed by rows: two legacy, then one with a reason.
    await seed({ day: '2026-10-12', interruptions: 3, reasons: ['phone'] });

    const res = await stats(WEEK);
    assert.equal(res.total, 8);
    assert.deepEqual(res.byReason, [
      { reason: 'chat', label: 'Slack / chat', count: 1 },
      { reason: 'phone', label: 'Phone call', count: 1 },
    ]);
    // 3 from before, 1 with no reason, and 2 of the last block's 3 that no row stands behind.
    assert.equal(res.unspecified, 6);
    // However it is made up, every interruption is either a reason given or unspecified.
    const given = res.byReason.reduce((n: number, r: { count: number }) => n + r.count, 0);
    assert.equal(res.total, given + res.unspecified);
  });

  it('has nothing to say about a window with no interruptions in it', async () => {
    await seed({ day: '2026-10-12', seconds: 1800 });
    assert.deepEqual(await stats(WEEK), {
      from: '2026-10-06',
      to: '2026-10-12',
      total: 0,
      byReason: [],
      unspecified: 0,
    });
  });

  it('never counts more of a block than its own count says, whatever its rows hold', async () => {
    // The count was lowered by hand, to 1, and the three rows were left as they were: the count
    // is what every other screen shows, so it is what this one has to add up to as well.
    await seed({ day: '2026-10-12', interruptions: 1, reasons: ['chat', 'phone', 'email'] });
    const res = await stats(WEEK);
    assert.equal(res.total, 1);
    assert.deepEqual(res.byReason, [{ reason: 'chat', label: 'Slack / chat', count: 1 }]);
    assert.equal(res.unspecified, 0);
  });

  it('counts only the days asked for, both ends included', async () => {
    await seed({ day: '2026-10-05', reasons: ['chat'] }); // the day before
    await seed({ day: '2026-10-06', reasons: ['phone'] }); // the first day
    await seed({ day: '2026-10-12', reasons: ['email', 'email'] }); // the last day
    await seed({ day: '2026-10-13', reasons: ['person'] }); // the day after

    const res = await stats(WEEK);
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.byReason.map((r: { reason: string; count: number }) => [r.reason, r.count]),
      [
        ['email', 2],
        ['phone', 1],
      ],
    );
    // A single day is a window too.
    assert.equal((await stats('?from=2026-10-13&to=2026-10-13')).total, 1);
  });

  it('defaults to the 7 days ending today', async () => {
    freeze(NOON);
    await seed({ day: '2026-10-05', reasons: ['chat'] }); // 7 days back: just outside
    await seed({ day: '2026-10-06', reasons: ['phone'] }); // 6 days back: the first day
    await seed({ day: '2026-10-12', reasons: ['email'] });

    const res = await stats();
    assert.equal(res.from, '2026-10-06');
    assert.equal(res.to, '2026-10-12');
    assert.equal(res.total, 2);

    // Only `to` given: the 7 days ending then, which takes in the 5th as well. Only `from` given:
    // through today.
    const early = await stats('?to=2026-10-06');
    assert.deepEqual([early.from, early.to, early.total], ['2026-09-30', '2026-10-06', 2]);
    const late = await stats('?from=2026-10-12');
    assert.deepEqual([late.from, late.to, late.total], ['2026-10-12', '2026-10-12', 1]);
  });

  it('goes by the day the user is in when it works out today', async () => {
    // 02:00 UTC on the 12th is still the 11th for someone whose day starts at 04:00.
    freeze('2026-10-12T02:00:00.000Z');
    const res = await stats();
    assert.deepEqual([res.from, res.to], ['2026-10-05', '2026-10-11']);
  });

  it('refuses a window that is not days in order, as the other stats do', async () => {
    const bad = [
      '?from=yesterday',
      '?to=tomorrow',
      '?from=2026-10-1',
      '?from=2026-10-01T00:00:00Z',
      '?from=',
      '?from=2026-10-12&to=2026-10-06',
      '?from=2026-10-01&from=2026-10-02',
      // The pattern fits and the date does not: 2026-02-30 would be read as March 2nd.
      '?from=2026-02-30',
      '?to=2026-13-01',
    ];
    for (const query of bad) {
      const res = await api.call('GET', `/stats/interruptions${query}`);
      assert.equal(res.status, 400, query);
      assert.ok(res.body.error, query);
    }
    assert.equal((await stats('?from=2026-10-12&to=2026-10-12')).total, 0);
  });

  it('follows what is logged through the API, from a click to the Review page', async () => {
    freeze(NOON);
    const started = await api.call('POST', '/sessions', { title: 'Deep work' });
    const id = started.body.id;
    const log = (body: unknown) => api.call('POST', `/sessions/${id}/interruption`, body);
    await log({ reason: 'chat' });
    await log({ reason: 'chat' });
    await log({});
    await log({ reason: 'meeting' });
    await log({ delta: -1 }); // takes the meeting back

    const res = await stats();
    assert.equal(res.total, 3);
    assert.deepEqual(res.byReason, [{ reason: 'chat', label: 'Slack / chat', count: 2 }]);
    assert.equal(res.unspecified, 1);
  });

  it('leaves the existing day and range stats exactly as they were', async () => {
    await seed({ day: '2026-10-12', seconds: 1800, reasons: ['chat', 'phone'] });
    const day = (await api.call('GET', '/stats/day?day=2026-10-12')).body;
    assert.equal(day.interruptions, 2);
    assert.ok(!('byReason' in day));
    const range = (await api.call('GET', '/stats/range?from=2026-10-06&to=2026-10-12')).body;
    assert.ok(!('byReason' in range));
    assert.ok(!('interruptions' in range));
  });
});

/* ------------------------------------------------------ the words for a ratio */

/*
 * The wording is a plain function in a plain file, and the web app has no test runner of its
 * own, so it is loaded here by its path, as the wrap-up's text is.
 */
interface Words {
  accuracyWords(subject: string, a: { count: number; medianRatio: number | null }): string;
}
const wordsLib = () =>
  import(new URL('../../web/src/lib/accuracyWords.ts', import.meta.url).href) as Promise<Words>;

describe('how an estimate ratio is put into words', () => {
  const said = async (medianRatio: number | null, count = 5) =>
    (await wordsLib()).accuracyWords('Blocks', { count, medianRatio });

  it('says there is not enough yet when there is no median, with how many there are', async () => {
    assert.equal(await said(null, 2), 'Blocks: not enough yet (2)');
    assert.equal(await said(null, 0), 'Blocks: not enough yet (0)');
  });

  it('says "about right" for every ratio that rounds to a tenth between 0.9 and 1.1, the ends too', async () => {
    // On the edge, and over it by a hair: a ratio of exactly 1.1 is 66 s against a 60 s guess, and
    // floating point puts it a hair above 1.1 as often as not.
    for (const ratio of [
      0.9,
      0.895,
      0.86,
      0.95,
      1,
      1.05,
      1.1,
      66 / 60,
      1.1000000000000001,
      1.14,
      1.149,
    ]) {
      assert.equal(await said(ratio), 'Blocks are about right (5)', String(ratio));
    }
  });

  it('says how many times the guess above that, in the tenth that is printed, and never as 1.0 or 1.1', async () => {
    assert.equal(await said(1.16), 'Blocks run 1.2× your guess (5)');
    assert.equal(await said(1.151), 'Blocks run 1.2× your guess (5)');
    assert.equal(await said(1.6), 'Blocks run 1.6× your guess (5)');
    assert.equal(await said(2.04), 'Blocks run 2.0× your guess (5)');
    assert.equal(await said(10), 'Blocks run 10.0× your guess (5)');
  });

  it('says the share of the guess in whole percent below that, and never 85 or more of it', async () => {
    assert.equal(await said(0.84), 'Blocks finish in 84% of your guess (5)');
    assert.equal(await said(0.7), 'Blocks finish in 70% of your guess (5)');
    assert.equal(await said(0.5), 'Blocks finish in 50% of your guess (5)');
    assert.equal(await said(0.333), 'Blocks finish in 33% of your guess (5)');
  });

  it('never prints a figure that contradicts the words round it, for any ratio', async () => {
    for (let n = 0; n <= 4000; n++) {
      const ratio = n / 1000;
      const words = await said(ratio);
      const times = words.match(/run (\d+\.\d)×/);
      const percent = words.match(/finish in (\d+)%/);
      if (times) {
        // Printed as a multiple, so it is a multiple that is out of "about right".
        assert.ok(Number(times[1]) >= 1.2, `${ratio}: ${words}`);
        assert.ok(Math.abs(Number(times[1]) - ratio) <= 0.05 + 1e-9, `${ratio}: ${words}`);
      } else if (percent) {
        assert.ok(Number(percent[1]) <= 85, `${ratio}: ${words}`);
        assert.ok(Math.abs(Number(percent[1]) / 100 - ratio) <= 0.005 + 1e-9, `${ratio}: ${words}`);
      } else {
        assert.match(words, /are about right/, `${ratio}: ${words}`);
        assert.ok(ratio >= 0.85 - 1e-9 && ratio <= 1.15 + 1e-9, `${ratio}: ${words}`);
      }
    }
  });
});

/* --------------------------------------------------------- estimate accuracy */

describe('how your estimates hold up', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const stats = async (query = '?from=2026-10-01&to=2026-10-31') => {
    const res = await api.call('GET', `/stats/estimates${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const DAY = '2026-10-12';

  /** A completed focus block of `minutes` actual against a guess of `estimate`. */
  const block = (estimate: number | null, minutes: number, more: Partial<BlockSeed> = {}) =>
    seed({ day: DAY, estimatedMinutes: estimate, seconds: minutes * 60, ...more });

  /** A completed task with an estimate and one finished focus block of `minutes` logged on it. */
  async function finishedTask(
    title: string,
    estimate: number | null,
    minutes: number,
    more: { completedOn?: string; projectId?: number | null; status?: 'completed' | 'in_progress' } = {},
  ) {
    const { createTask } = await tasksMod();
    const status = more.status ?? 'completed';
    const t = createTask({
      title,
      estimatedMinutes: estimate,
      projectId: more.projectId ?? null,
      status,
      // A date named in the request wins over the status, so an open task can carry one.
      completedOn: more.completedOn ?? (status === 'completed' ? DAY : null),
      addedOn: '2026-10-05',
    });
    if (minutes > 0) await seed({ day: DAY, taskId: t.id, seconds: minutes * 60 });
    return t;
  }

  it('is the median of actual over estimate across three or more blocks', async () => {
    // Ratios 0.5, 1, 3: the middle one is 1, where an average would say 1.5.
    await block(60, 30);
    await block(60, 60);
    await block(20, 60);
    const res = await stats();
    assert.deepEqual(res.blocks, { count: 3, medianRatio: 1 });
  });

  it('is halfway between the two in the middle when there is an even number', async () => {
    // Ratios 0.5, 1, 1.5, 4: halfway between 1 and 1.5.
    await block(60, 30);
    await block(60, 60);
    await block(60, 90);
    await block(60, 240);
    assert.deepEqual((await stats()).blocks, { count: 4, medianRatio: 1.25 });
  });

  it('is the ratio of the seconds worked to the minutes guessed, not a rounded one', async () => {
    // 100 s against a 1 minute guess.
    await seed({ day: DAY, estimatedMinutes: 1, seconds: 100 });
    await seed({ day: DAY, estimatedMinutes: 1, seconds: 100 });
    await seed({ day: DAY, estimatedMinutes: 1, seconds: 100 });
    assert.equal((await stats()).blocks.medianRatio, 100 / 60);
  });

  it('has no median under three, only how many there are', async () => {
    assert.deepEqual((await stats()).blocks, { count: 0, medianRatio: null });
    await block(60, 90);
    assert.deepEqual((await stats()).blocks, { count: 1, medianRatio: null });
    await block(60, 30);
    assert.deepEqual((await stats()).blocks, { count: 2, medianRatio: null });
    await block(60, 60);
    assert.deepEqual((await stats()).blocks, { count: 3, medianRatio: 1 });
  });

  it('leaves out abandoned blocks, breaks, running blocks and blocks with no estimate', async () => {
    await block(60, 60); // the one that counts
    await block(60, 600, { status: 'abandoned' });
    await block(60, 600, { kind: 'break' });
    await block(60, 600, { status: 'running' });
    await block(null, 600); // no guess to compare against
    await seed({ day: DAY, seconds: 600 }); // likewise, however it was made

    assert.deepEqual((await stats()).blocks, { count: 1, medianRatio: null });
    // Three more that do, so the median is of those and not dragged by the ones left out.
    await block(60, 30);
    await block(60, 90);
    await block(60, 60);
    assert.deepEqual((await stats()).blocks, { count: 4, medianRatio: 1 });
  });

  it('leaves out a finished block that holds no time, as it does a task with nothing logged', async () => {
    // A guess against no seconds at all is a ratio of 0: there is no actual to compare, and
    // counted it would drag the median of the blocks that do have one down.
    await block(60, 60); // 1
    await block(60, 90); // 1.5
    await block(60, 120); // 2
    await block(60, 0); // stopped at once
    await block(30, 0);
    const res = await stats();
    assert.deepEqual(res.blocks, { count: 3, medianRatio: 1.5 });
    assert.deepEqual(
      res.byProject.map((p: { name: string; blocks: unknown }) => [p.name, p.blocks]),
      [['No project', { count: 3, medianRatio: 1.5 }]],
    );

    // Only blocks with no time: nothing to say at all, and no project is listed for them.
    await reset();
    await block(60, 0);
    const none = await stats();
    assert.deepEqual(none.blocks, { count: 0, medianRatio: null });
    assert.deepEqual(none.byProject, []);
  });

  it('counts a completed task with an estimate by the focus time logged on it, on the day it was completed', async () => {
    const { db } = await dbMod();
    // 120-minute guesses: 60, 120 and 240 minutes logged. The median is 120 / 120.
    await finishedTask('Half', 120, 60);
    await finishedTask('Right', 120, 120);
    await finishedTask('Double', 120, 240);
    const res = await stats();
    assert.deepEqual(res.tasks, { count: 3, medianRatio: 1 });

    // Logged time is finished focus blocks only: a break, a discarded block or a running one
    // on the task is not work on it, exactly as the Tasks tab counts it.
    const t = await finishedTask('Has other blocks', 60, 60);
    await seed({ day: DAY, taskId: t.id, kind: 'break', seconds: 3000 });
    await seed({ day: DAY, taskId: t.id, status: 'abandoned', seconds: 3000 });
    await seed({ day: DAY, taskId: t.id, status: 'running', seconds: 3000 });
    const after = await stats();
    assert.equal(after.tasks.count, 4);
    // Ratios 0.5, 1, 1, 2: halfway between 1 and 1.
    assert.equal(after.tasks.medianRatio, 1);

    // Two blocks on one task add up to the one actual.
    const split = await finishedTask('In two goes', 60, 30);
    await seed({ day: DAY, taskId: split.id, seconds: 30 * 60 });
    const sum = await stats();
    assert.equal(sum.tasks.count, 5);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?').get(split.id) as { n: number }).n,
      2,
    );
    assert.equal(sum.tasks.medianRatio, 1);
  });

  it('counts the day a task was completed, not the day the blocks were worked or it was added', async () => {
    // Worked on the 12th, completed on the 20th: it belongs to a window that has the 20th.
    await finishedTask('Late', 60, 60, { completedOn: '2026-10-20' });
    await finishedTask('Late too', 60, 60, { completedOn: '2026-10-20' });
    await finishedTask('Late three', 60, 60, { completedOn: '2026-10-20' });
    assert.equal((await stats('?from=2026-10-01&to=2026-10-15')).tasks.count, 0);
    assert.equal((await stats('?from=2026-10-16&to=2026-10-31')).tasks.count, 3);
  });

  it('leaves out tasks that are not completed, have no estimate, or have no time logged', async () => {
    await finishedTask('Counts', 60, 60);
    // Open, though it has a completion date typed in: the status is what says it is done.
    await finishedTask('Still going', 60, 60, { status: 'in_progress', completedOn: DAY });
    await finishedTask('No guess', null, 60);
    await finishedTask('Nothing logged', 60, 0);
    // A task whose only logged time is a discarded block has none logged either.
    const empty = await finishedTask('Only discarded', 60, 0);
    await seed({ day: DAY, taskId: empty.id, status: 'abandoned', seconds: 3600 });
    // And one with a finished block that holds no time has no actual to compare, not an actual of 0.
    const instant = await finishedTask('Stopped at once', 60, 0);
    await seed({ day: DAY, taskId: instant.id, seconds: 0 });

    assert.deepEqual((await stats()).tasks, { count: 1, medianRatio: null });
  });

  it('files blocks under their own project and tasks under theirs, with "No project" as its own entry', async () => {
    const roi = await makeProject('ROI Dashboard', '#2a78d6');
    const ops = await makeProject('Crew Mgmt Ops', '#eb6834');

    // ROI: three blocks, half again as long as guessed.
    for (let i = 0; i < 3; i++) await block(60, 90, { projectId: roi });
    // Ops: one block, and three tasks that finished in half the time.
    await block(60, 60, { projectId: ops });
    for (const title of ['A', 'B', 'C']) await finishedTask(title, 120, 60, { projectId: ops });
    // No project: two blocks and a task.
    await block(60, 30);
    await block(60, 30);
    await finishedTask('Misc', 60, 30);

    const res = await stats();
    // Six ratios, 0.5 0.5 1 1.5 1.5 1.5: halfway between the 1 and the first 1.5.
    assert.deepEqual(res.blocks, { count: 6, medianRatio: 1.25 });
    assert.deepEqual(res.tasks, { count: 4, medianRatio: 0.5 });
    assert.deepEqual(res.byProject, [
      {
        projectId: ops,
        name: 'Crew Mgmt Ops',
        color: '#eb6834',
        blocks: { count: 1, medianRatio: null },
        tasks: { count: 3, medianRatio: 0.5 },
      },
      {
        projectId: roi,
        name: 'ROI Dashboard',
        color: '#2a78d6',
        blocks: { count: 3, medianRatio: 1.5 },
        tasks: { count: 0, medianRatio: null },
      },
      {
        projectId: null,
        name: 'No project',
        color: '#94a3b8',
        blocks: { count: 2, medianRatio: null },
        tasks: { count: 1, medianRatio: null },
      },
    ]);
  });

  it('leaves out a project with nothing in either bucket, and shows one that has only tasks', async () => {
    const quiet = await makeProject('Quiet');
    const onlyTasks = await makeProject('Only tasks');
    // Work with nothing to compare: an unestimated block, a discarded one and a break.
    await seed({ day: DAY, projectId: quiet, seconds: 600 });
    await block(60, 60, { projectId: quiet, status: 'abandoned' });
    await block(60, 60, { projectId: quiet, kind: 'break' });
    await finishedTask('One task', 60, 60, { projectId: onlyTasks });

    const res = await stats();
    assert.deepEqual(
      res.byProject.map((p: { name: string }) => p.name),
      ['Only tasks'],
    );
    assert.deepEqual(res.byProject[0].blocks, { count: 0, medianRatio: null });
    assert.deepEqual(res.byProject[0].tasks, { count: 1, medianRatio: null });
  });

  it('puts the projects with the most to go on first, and a named project before "No project" on a tie', async () => {
    const b = await makeProject('Bravo');
    const a = await makeProject('Alpha');
    await block(60, 60);
    await block(60, 60, { projectId: b });
    await block(60, 60, { projectId: a });
    await block(60, 60, { projectId: a });

    const res = await stats();
    assert.deepEqual(
      res.byProject.map((p: { name: string }) => p.name),
      ['Alpha', 'Bravo', 'No project'],
    );
  });

  it('keeps a block with its own project when it is the work on a task of another', async () => {
    const roi = await makeProject('ROI Dashboard');
    const ops = await makeProject('Crew Mgmt Ops');
    const t = await finishedTask('On ROI', 60, 0, { projectId: roi });
    // Logged on the task, but billed to ops: the block is ops'; the task stays ROI's.
    await seed({ day: DAY, taskId: t.id, projectId: ops, seconds: 3600, estimatedMinutes: 60 });

    const res = await stats();
    const byName = Object.fromEntries(
      res.byProject.map((p: { name: string }) => [p.name, p]),
    ) as Record<string, { blocks: { count: number }; tasks: { count: number } }>;
    assert.equal(byName['Crew Mgmt Ops']!.blocks.count, 1);
    assert.equal(byName['Crew Mgmt Ops']!.tasks.count, 0);
    assert.equal(byName['ROI Dashboard']!.blocks.count, 0);
    assert.equal(byName['ROI Dashboard']!.tasks.count, 1);
  });

  it('counts only the days asked for, both ends included', async () => {
    for (const day of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']) {
      await seed({ day, estimatedMinutes: 60, seconds: 3600 });
    }
    await finishedTask('Before', 60, 60, { completedOn: '2026-09-30' });
    await finishedTask('First', 60, 60, { completedOn: '2026-10-01' });
    await finishedTask('Last', 60, 60, { completedOn: '2026-10-31' });
    await finishedTask('After', 60, 60, { completedOn: '2026-11-01' });

    const res = await stats('?from=2026-10-01&to=2026-10-31');
    assert.equal(res.blocks.count, 2);
    assert.equal(res.tasks.count, 2);
    assert.equal(res.from, '2026-10-01');
    assert.equal(res.to, '2026-10-31');
    // A single day is a window too.
    const one = await stats('?from=2026-11-01&to=2026-11-01');
    assert.deepEqual([one.blocks.count, one.tasks.count], [1, 1]);
  });

  it('defaults to the 90 days ending today', async () => {
    freeze(NOON);
    await seed({ day: '2026-07-14', estimatedMinutes: 60, seconds: 3600 }); // 90 days back: outside
    await seed({ day: '2026-07-15', estimatedMinutes: 60, seconds: 3600 }); // 89 days back: the first
    await seed({ day: '2026-10-12', estimatedMinutes: 60, seconds: 3600 });

    const res = await stats('');
    assert.equal(res.from, '2026-07-15');
    assert.equal(res.to, '2026-10-12');
    assert.equal(res.blocks.count, 2);
  });

  it('has nothing to say when there are no estimates at all', async () => {
    assert.deepEqual(await stats(), {
      from: '2026-10-01',
      to: '2026-10-31',
      blocks: { count: 0, medianRatio: null },
      tasks: { count: 0, medianRatio: null },
      byProject: [],
    });
  });

  it('refuses a window that is not days in order', async () => {
    for (const query of [
      '?from=last-week',
      '?to=2026-1-1',
      '?from=2026-10-31&to=2026-10-01',
      '?to=2026-02-30',
    ]) {
      assert.equal(await api.status('GET', `/stats/estimates${query}`), 400, query);
    }
  });
});

/* ------------------------------------------------------------- migration 5 */

describe('migration 5 on an existing database', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A database as it stood before migration `id`: every earlier one applied, nothing else. */
  async function databaseBefore(conn: Database.Database, id: number, appliedAt: string) {
    const { migrations } = await dbMod();
    conn.exec(`CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of migrations.filter((m) => m.id < id)) {
      conn.exec(m.up);
      conn
        .prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(m.id, m.name, appliedAt);
    }
  }

  it('keeps every block and its count, starts with no reasons, and ties them to the block from then on', async () => {
    const { runMigrations, migrations } = await dbMod();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-insights-migrate-'));
    dirs.push(dir);
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      const stamp = '2026-10-01T10:00:00.000Z';
      await databaseBefore(conn, 5, stamp);
      const add = conn.prepare(
        `INSERT INTO sessions (id, title, kind, started_at, ended_at, local_day, active_seconds,
           interruptions, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '2026-10-01', 1800, ?, 'completed', ?, ?)`,
      );
      add.run(7, 'Counted before', 'focus', stamp, stamp, 3, stamp, stamp);
      add.run(8, 'A break', 'break', stamp, stamp, 0, stamp, stamp);
      const before = conn.prepare('SELECT * FROM sessions ORDER BY id').all();

      runMigrations(conn, file);

      assert.deepEqual(
        conn.prepare('SELECT id, name FROM _migrations ORDER BY id').all(),
        migrations.map((m) => ({ id: m.id, name: m.name })),
      );
      assert.equal(migrations.find((m) => m.id === 5)?.name, 'interruption reasons');
      // Every block as it was, the count included: nothing was invented for the rows it lacks.
      assert.deepEqual(conn.prepare('SELECT * FROM sessions ORDER BY id').all(), before);
      assert.deepEqual(conn.prepare('SELECT * FROM interruptions').all(), []);

      const columns = (
        conn.prepare('PRAGMA table_info(interruptions)').all() as {
          name: string;
          notnull: number;
        }[]
      ).map((c) => [c.name, c.notnull]);
      assert.deepEqual(columns, [
        ['id', 0],
        ['session_id', 1],
        ['at', 1],
        ['reason', 0],
      ]);
      assert.deepEqual(
        conn.prepare("SELECT name FROM pragma_index_info('interruptions_session')").all(),
        [{ name: 'session_id' }],
      );

      // The constraints bite: a reason off the list, a block that is not there.
      const row = conn.prepare('INSERT INTO interruptions (session_id, at, reason) VALUES (?, ?, ?)');
      assert.throws(() => row.run(7, stamp, 'bogus'), /CHECK/);
      assert.throws(() => row.run(999, stamp, 'chat'), /FOREIGN KEY/);
      assert.throws(() => row.run(null, stamp, 'chat'), /NOT NULL/);
      row.run(7, stamp, 'chat');
      row.run(7, stamp, null);
      assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM interruptions').get() as { n: number }).n, 2);

      // A deleted block takes its rows with it, and only its own.
      row.run(8, stamp, 'phone');
      conn.prepare('DELETE FROM sessions WHERE id = 7').run();
      assert.deepEqual(conn.prepare('SELECT session_id, reason FROM interruptions').all(), [
        { session_id: 8, reason: 'phone' },
      ]);
      assert.deepEqual(conn.pragma('foreign_key_check'), []);
    } finally {
      conn.close();
    }
  });
});
