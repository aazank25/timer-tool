import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import type { SessionRow } from '../src/lib/sessions.js';
import type { TaskInput } from '../src/lib/tasks.js';
import { weekStart } from '../src/lib/time.js';
import { freshDb } from './setup.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const tasksMod = () => import('../src/lib/tasks.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A clean database, with the user's day pinned to UTC and rolling over at 04:00. */
async function reset() {
  await freshDb();
  const { setSettings } = await settingsMod();
  setSettings({ timezone: 'UTC', day_start_hour: 4 });
}

/** Stop the wall clock at an instant, so "today" and a running block's elapsed time are exact. */
function freeze(iso: string) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}
const advance = (ms: number) => mock.timers.tick(ms);

async function makeProject(name: string, color = '#0ea5e9'): Promise<number> {
  const { db } = await dbMod();
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, color, now, now);
  return Number(info.lastInsertRowid);
}

async function task(title: string, rest: Partial<TaskInput> = {}) {
  const { createTask } = await tasksMod();
  return createTask({ title, ...rest });
}

async function reread(id: number) {
  const { getTask } = await tasksMod();
  return getTask(id);
}

/** A task's row exactly as stored, every column, so "untouched" means all of it. */
async function storedTask(id: number) {
  const { db } = await dbMod();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

/** How many rows a table holds, straight from the database. */
async function countRows(table: 'sessions' | 'session_segments') {
  const { db } = await dbMod();
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A finished block with exactly this much time on it, whatever the clock says. */
async function loggedBlock(
  taskId: number | null,
  seconds: number,
  opts: { kind?: 'focus' | 'break'; status?: 'completed' | 'abandoned' } = {},
) {
  const { startSession, stopSession } = await sessionsMod();
  const started = startSession({ title: 'Logged work', taskId, kind: opts.kind });
  return stopSession(started.id, opts.status ?? 'completed', { activeSeconds: seconds });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
  };

  return {
    call,
    /** For the cases where only the refusal matters. */
    status: async (method: string, url: string, body?: unknown) =>
      (await call(method, url, body)).status,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

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

/* ------------------------------------------------------------------ defaults */

describe('a new task', () => {
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('is medium priority, not started and added today, with nothing else filled in', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const t = await task('Draft the QBR deck');
    assert.deepEqual(t, {
      id: t.id,
      projectId: null,
      projectName: null,
      projectColor: null,
      title: 'Draft the QBR deck',
      priority: 'medium',
      status: 'not_started',
      estimatedMinutes: null,
      addedOn: '2026-10-08',
      weekOf: '2026-10-05',
      startDate: null,
      targetDate: null,
      completedOn: null,
      notes: null,
      results: null,
      position: 0,
      loggedSeconds: 0,
      blockCount: 0,
      lastWorkedAt: null,
      overdue: false,
    });
  });

  it('is filed under the Monday of the week it was added', async () => {
    const cases: [string, string][] = [
      ['2026-10-05', '2026-10-05'], // a Monday is its own week
      ['2026-10-08', '2026-10-05'],
      ['2026-10-11', '2026-10-05'], // a Sunday still belongs to the week before it
      ['2026-10-12', '2026-10-12'],
      ['2026-03-01', '2026-02-23'],
      ['2027-01-01', '2026-12-28'], // across the new year
    ];
    for (const [addedOn, weekOf] of cases) {
      const t = await task(`Added ${addedOn}`, { addedOn });
      assert.equal(t.addedOn, addedOn);
      assert.equal(t.weekOf, weekOf, `added ${addedOn}`);
    }
  });

  it('is added on the day the user is in, not the UTC date', async () => {
    const { setSettings } = await settingsMod();
    // 02:30 UTC is still the 7th for someone whose day starts at 04:00.
    freeze('2026-10-08T02:30:00.000Z');
    assert.equal((await task('Before the day starts')).addedOn, '2026-10-07');

    // 03:00 UTC is mid-afternoon on the 8th in Auckland (UTC+13 that week), where UTC still says the 7th.
    setSettings({ timezone: 'Pacific/Auckland' });
    freeze('2026-10-08T03:00:00.000Z');
    const t = await task('Auckland afternoon');
    assert.equal(t.addedOn, '2026-10-08');
    assert.equal(t.weekOf, '2026-10-05');
  });

  it('takes every field it is given', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const roi = await makeProject('ROI Dashboard', '#2a78d6');
    const t = await task('Automate people ops', {
      projectId: roi,
      priority: 'high',
      status: 'held_up',
      estimatedMinutes: 90,
      addedOn: '2026-10-01',
      startDate: '2026-10-02',
      targetDate: '2026-10-09',
      notes: 'Waiting on legal',
      results: 'Not yet',
    });
    assert.deepEqual(t, {
      id: t.id,
      projectId: roi,
      projectName: 'ROI Dashboard',
      projectColor: '#2a78d6',
      title: 'Automate people ops',
      priority: 'high',
      status: 'held_up',
      estimatedMinutes: 90,
      addedOn: '2026-10-01',
      weekOf: '2026-09-28',
      startDate: '2026-10-02',
      targetDate: '2026-10-09',
      completedOn: null,
      notes: 'Waiting on legal',
      results: 'Not yet',
      position: 0,
      loggedSeconds: 0,
      blockCount: 0,
      lastWorkedAt: null,
      overdue: false,
    });
  });
});

/* -------------------------------------------------------------- misc tasks */

describe('tasks with no project', () => {
  let roi = 0;

  beforeEach(async () => {
    await reset();
    roi = await makeProject('ROI Dashboard', '#0ea5e9');
  });

  const titles = async (f?: Parameters<Awaited<ReturnType<typeof tasksMod>>['listTasks']>[0]) => {
    const { listTasks } = await tasksMod();
    return listTasks(f).map((t) => t.title);
  };

  it('lists beside the project ones and filters out on its own', async () => {
    await task('Ask Robin to order the cocktail set');
    await task('Build the tickets view', { projectId: roi });

    assert.deepEqual(await titles(), [
      'Ask Robin to order the cocktail set',
      'Build the tickets view',
    ]);
    assert.deepEqual(await titles({ projectId: 'none' }), ['Ask Robin to order the cocktail set']);
    assert.deepEqual(await titles({ projectId: roi }), ['Build the tickets view']);
  });

  it('reads back with no project name or colour, where a project task carries both', async () => {
    const misc = await task('Renew the domain');
    const owned = await task('Build the tickets view', { projectId: roi });
    assert.deepEqual([misc.projectId, misc.projectName, misc.projectColor], [null, null, null]);
    assert.deepEqual(
      [owned.projectId, owned.projectName, owned.projectColor],
      [roi, 'ROI Dashboard', '#0ea5e9'],
    );
  });

  it('is told apart from a project task within a view as well', async () => {
    await task('Open misc');
    await task('Done misc', { status: 'completed' });
    await task('Open project', { projectId: roi });
    await task('Done project', { projectId: roi, status: 'completed' });

    assert.deepEqual(await titles({ view: 'open', projectId: 'none' }), ['Open misc']);
    assert.deepEqual(await titles({ view: 'completed', projectId: 'none' }), ['Done misc']);
    assert.deepEqual(await titles({ view: 'all', projectId: roi }), [
      'Open project',
      'Done project',
    ]);
  });
});

/* ------------------------------------------------------------ status dates */

describe('a task moving between statuses', () => {
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('is started on the first move to in progress, and never restarted', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const t = await task('Write the pricing memo');

    const started = updateTask(t.id, { status: 'in_progress' });
    assert.equal(started.status, 'in_progress');
    assert.equal(started.startDate, '2026-10-08');
    assert.equal(started.completedOn, null);

    advance(DAY);
    assert.equal(updateTask(t.id, { status: 'held_up' }).startDate, '2026-10-08');
    advance(DAY);
    assert.equal(updateTask(t.id, { status: 'in_progress' }).startDate, '2026-10-08');
  });

  it('keeps a start date it already has when it moves to in progress', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const t = await task('Already underway', { startDate: '2026-09-30' });
    assert.equal(updateTask(t.id, { status: 'in_progress' }).startDate, '2026-09-30');
  });

  it('is stamped completed today, and loses the stamp when it is reopened', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const t = await task('Send the invoice');

    const done = updateTask(t.id, { status: 'completed' });
    assert.equal(done.status, 'completed');
    assert.equal(done.completedOn, '2026-10-08');
    // Completing a task says nothing about when it was started.
    assert.equal(done.startDate, null);

    const reopened = updateTask(t.id, { status: 'not_started' });
    assert.equal(reopened.status, 'not_started');
    assert.equal(reopened.completedOn, null);

    // Finishing it again stamps the day it really happened this time.
    advance(2 * DAY);
    assert.equal(updateTask(t.id, { status: 'completed' }).completedOn, '2026-10-10');
  });

  it('keeps a completion date it already has when it is completed', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const done = await task('Finished earlier', { status: 'completed', completedOn: '2026-10-03' });
    advance(2 * DAY);
    // Saying it again is not finishing it again.
    assert.equal(updateTask(done.id, { status: 'completed' }).completedOn, '2026-10-03');

    // And a date entered ahead of time is not replaced by today's.
    const ahead = await task('Dated ahead', { completedOn: '2026-10-05' });
    assert.equal(updateTask(ahead.id, { status: 'completed' }).completedOn, '2026-10-05');
  });

  it('is stamped started as it is reopened to in progress, and loses its completed date', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const t = await task('Premature', { status: 'completed' });
    assert.equal(t.completedOn, '2026-10-08');

    advance(DAY);
    const back = updateTask(t.id, { status: 'in_progress' });
    assert.equal(back.completedOn, null);
    assert.equal(back.startDate, '2026-10-09');
  });

  it('lets a date written in the same request win over the one the status implies', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();

    const a = await task('Started last week');
    assert.equal(
      updateTask(a.id, { status: 'in_progress', startDate: '2026-10-01' }).startDate,
      '2026-10-01',
    );

    const b = await task('Finished on Saturday');
    const finished = updateTask(b.id, { status: 'completed', completedOn: '2026-10-03' });
    assert.equal(finished.completedOn, '2026-10-03');

    // Reopening and dating the completion in one go is taken at its word, too.
    const kept = updateTask(b.id, { status: 'held_up', completedOn: '2026-10-04' });
    assert.equal(kept.status, 'held_up');
    assert.equal(kept.completedOn, '2026-10-04');
  });

  it('treats a null date in the request as a deliberate blank, not as a gap to fill', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const a = await task('No start date, on purpose');
    assert.equal(updateTask(a.id, { status: 'in_progress', startDate: null }).startDate, null);
    const b = await task('No finish date, on purpose');
    assert.equal(updateTask(b.id, { status: 'completed', completedOn: null }).completedOn, null);
  });

  it('keeps its dates when only other fields change', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const started = await task('In flight', { status: 'in_progress' });
    const edited = updateTask(started.id, {
      title: 'In flight, renamed',
      targetDate: '2026-10-20',
    });
    assert.equal(edited.startDate, '2026-10-08');
    assert.equal(edited.completedOn, null);

    const done = await task('Done', { status: 'completed' });
    advance(DAY);
    const notes = updateTask(done.id, { notes: 'Went well', results: 'Signed' });
    assert.equal(notes.completedOn, '2026-10-08');
    assert.equal(notes.status, 'completed');
  });

  it('applies the same rules to a task created already in progress or completed', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const going = await task('Created going', { status: 'in_progress' });
    assert.equal(going.startDate, '2026-10-08');
    assert.equal(going.completedOn, null);

    const done = await task('Created done', { status: 'completed' });
    assert.equal(done.completedOn, '2026-10-08');
    assert.equal(done.startDate, null);

    const named = await task('Created with dates', {
      status: 'completed',
      startDate: '2026-09-29',
      completedOn: '2026-10-02',
    });
    assert.equal(named.startDate, '2026-09-29');
    assert.equal(named.completedOn, '2026-10-02');

    const waiting = await task('Created waiting', { status: 'held_up' });
    assert.equal(waiting.startDate, null);
    assert.equal(waiting.completedOn, null);
  });

  it('refuses to be pointed at a project that is not there, and changes nothing', async () => {
    const { updateTask, createTask } = await tasksMod();
    const t = await task('Stays put');
    assert.throws(() => updateTask(t.id, { projectId: 999_999, title: 'Renamed' }), {
      status: 400,
      message: 'Unknown project',
    });
    assert.equal((await reread(t.id)).title, 'Stays put');
    assert.throws(() => createTask({ title: 'Nowhere', projectId: 999_999 }), { status: 400 });
  });
});

/* -------------------------------------------------- starting a block on one */

describe('starting a block on a task', () => {
  let roi = 0;
  let ops = 0;

  beforeEach(async () => {
    await reset();
    roi = await makeProject('ROI Dashboard', '#0ea5e9');
    ops = await makeProject('Crew Mgmt Ops', '#f59e0b');
  });
  afterEach(() => mock.timers.reset());

  it('links the block to the task and moves a not-started task to in progress', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession } = await sessionsMod();
    const t = await task('Competitor teardown');

    const block = startSession({ title: 'Teardown, first pass', taskId: t.id });
    assert.equal(block.taskId, t.id);
    assert.equal(block.taskTitle, 'Competitor teardown');
    assert.equal(block.title, 'Teardown, first pass');

    const after = await reread(t.id);
    assert.equal(after.status, 'in_progress');
    assert.equal(after.startDate, '2026-10-08');
  });

  it('moves a held-up task to in progress and keeps the start date it already had', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession } = await sessionsMod();
    const stalled = await task('Waiting on legal', { status: 'held_up', startDate: '2026-10-01' });
    startSession({ title: 'Back at it', taskId: stalled.id });
    const after = await reread(stalled.id);
    assert.equal(after.status, 'in_progress');
    assert.equal(after.startDate, '2026-10-01');
  });

  it('starts a held-up task that never had a start date, today', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession } = await sessionsMod();
    const stalled = await task('Parked before it began', { status: 'held_up' });
    assert.equal(stalled.startDate, null);
    startSession({ title: 'First go', taskId: stalled.id });
    assert.equal((await reread(stalled.id)).startDate, '2026-10-08');
  });

  it('leaves an in-progress task alone', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession } = await sessionsMod();
    const going = await task('Mid-flight', { status: 'in_progress', startDate: '2026-10-02' });
    advance(DAY);
    startSession({ title: 'More of it', taskId: going.id });
    const after = await reread(going.id);
    assert.equal(after.status, 'in_progress');
    assert.equal(after.startDate, '2026-10-02');
  });

  it('keeps a completed task completed, and still links the block to it', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession } = await sessionsMod();
    const done = await task('Shipped', { status: 'completed', completedOn: '2026-10-06' });
    const block = startSession({ title: 'Follow-up polish', taskId: done.id });
    assert.equal(block.taskId, done.id);
    const after = await reread(done.id);
    assert.equal(after.status, 'completed');
    assert.equal(after.completedOn, '2026-10-06');
    assert.equal(after.startDate, null);
  });

  it('does not move a task for a break, which is a rest and not work on it', async () => {
    const { startSession } = await sessionsMod();
    const t = await task('Not started');
    const rest = startSession({ title: 'Stretch', kind: 'break', taskId: t.id });
    assert.equal(rest.taskId, t.id);
    assert.equal((await reread(t.id)).status, 'not_started');
  });

  it("puts the block in the task's project when no project is given", async () => {
    const { startSession } = await sessionsMod();
    const t = await task('Competitor teardown', { projectId: roi });
    const block = startSession({ title: 'Teardown', taskId: t.id });
    assert.equal(block.projectId, roi);
    assert.equal(block.projectName, 'ROI Dashboard');
    assert.equal(block.projectColor, '#0ea5e9');
  });

  it('lets a project named in the request win, null for none included', async () => {
    const { startSession, stopSession } = await sessionsMod();
    const t = await task('Competitor teardown', { projectId: roi });

    const elsewhere = startSession({ title: 'Billed to ops', taskId: t.id, projectId: ops });
    assert.equal(elsewhere.projectId, ops);
    assert.equal(elsewhere.projectName, 'Crew Mgmt Ops');
    stopSession(elsewhere.id, 'abandoned');

    const none = startSession({ title: 'Billed to nobody', taskId: t.id, projectId: null });
    assert.equal(none.projectId, null);
    assert.equal(none.projectName, null);
    assert.equal(none.taskId, t.id);
  });

  it('leaves a block on a misc task without a project', async () => {
    const { startSession } = await sessionsMod();
    const t = await task('Renew the domain');
    const block = startSession({ title: 'Renewing', taskId: t.id });
    assert.equal(block.projectId, null);
    assert.equal(block.taskId, t.id);
  });

  it('refuses a task that is not there, and starts nothing', async () => {
    const { startSession, liveSessionRow } = await sessionsMod();
    const { db } = await dbMod();
    const bystander = await task('Bystander');
    assert.throws(() => startSession({ title: 'Ghost work', taskId: 999_999 }), {
      status: 400,
      message: 'Unknown task',
    });
    assert.equal(liveSessionRow(), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0);
    assert.equal((await reread(bystander.id)).status, 'not_started');
  });

  it('starts nothing and leaves the task as it was when the project is not there', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, liveSessionRow } = await sessionsMod();
    const t = await task('Wants a block');
    // A later clock than the task was made at, so a touched row would differ in updated_at too.
    advance(MINUTE);
    const before = await storedTask(t.id);

    assert.throws(() => startSession({ title: 'Nowhere', taskId: t.id, projectId: 999_999 }), {
      status: 400,
      message: 'Unknown project',
    });

    // Moving the task to in progress is part of the block's own transaction: a start that
    // is refused must not have made it, in status, start date or updated_at.
    assert.deepEqual(await storedTask(t.id), before);
    assert.equal(await countRows('sessions'), 0);
    assert.equal(await countRows('session_segments'), 0);
    assert.equal(liveSessionRow(), undefined);
  });

  it('starts nothing and leaves the task as it was when the insert itself is refused', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, liveSessionRow } = await sessionsMod();
    const t = await task('Wants a block');
    advance(MINUTE);
    const before = await storedTask(t.id);

    // The unknown-project test above only sees the task's move while that check runs inside
    // the transaction. A guess outside the column's 1-480 fails at the insert itself, so this
    // holds wherever any check sits.
    assert.throws(
      () => startSession({ title: 'Too long a guess', taskId: t.id, estimatedMinutes: 100_000 }),
      /CHECK constraint failed/,
    );

    assert.deepEqual(await storedTask(t.id), before);
    assert.equal(await countRows('sessions'), 0);
    assert.equal(await countRows('session_segments'), 0);
    assert.equal(liveSessionRow(), undefined);
  });

  it('starts nothing when the task cannot be moved along, so the two never part', async () => {
    const { startSession, liveSessionRow } = await sessionsMod();
    const { db } = await dbMod();
    const t = await task('Cannot be moved');
    const before = await storedTask(t.id);

    // Make the move to in progress fail, as a locked row or a full disk would. The trigger
    // is TEMP, so it lives and dies with this connection, and it is dropped below as well.
    db.exec(`CREATE TEMP TRIGGER refuse_the_move BEFORE UPDATE ON tasks WHEN OLD.id = ${t.id}
             BEGIN SELECT RAISE(ABORT, 'the move was refused'); END`);
    try {
      assert.throws(() => startSession({ title: 'Doomed', taskId: t.id }), /the move was refused/);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS refuse_the_move');
    }

    // The block was inserted before the move, so it has to be taken back with it.
    assert.equal(await countRows('sessions'), 0);
    assert.equal(await countRows('session_segments'), 0);
    assert.equal(liveSessionRow(), undefined);
    assert.deepEqual(await storedTask(t.id), before);

    // Nothing is left in the way: with the trigger gone the same start goes through.
    const block = startSession({ title: 'Second try', taskId: t.id });
    assert.equal(block.taskId, t.id);
    assert.equal((await reread(t.id)).status, 'in_progress');
  });

  it('refuses before looking at the clock, like any other bad request', async () => {
    const { startSession, stopSession } = await sessionsMod();
    const first = startSession({ title: 'Already running' });
    assert.throws(() => startSession({ title: 'Second', taskId: 999_999 }), { status: 400 });
    stopSession(first.id, 'abandoned');
  });

  it('does not touch the task when the clock is busy', async () => {
    const { startSession, stopSession } = await sessionsMod();
    const t = await task('Wants a block');
    const first = startSession({ title: 'Already running' });
    assert.throws(() => startSession({ title: 'Second', taskId: t.id }), /still on the clock/);
    const after = await reread(t.id);
    assert.equal(after.status, 'not_started');
    assert.equal(after.startDate, null);
    stopSession(first.id, 'abandoned');
  });

  it('does not touch the task when a stopwatch is asked for a length', async () => {
    const { startSession, liveSessionRow } = await sessionsMod();
    const t = await task('Wants a block');
    assert.throws(
      () => startSession({ title: 'Mixed', taskId: t.id, mode: 'stopwatch', plannedMinutes: 45 }),
      { status: 400, message: 'A stopwatch has no planned length' },
    );
    assert.equal(liveSessionRow(), undefined);
    assert.equal((await reread(t.id)).status, 'not_started');
  });

  it('still starts a stopwatch by default, a countdown on request, and breaks as countdowns', async () => {
    const { startSession, stopSession } = await sessionsMod();
    const t = await task('Competitor teardown', { estimatedMinutes: 120 });

    const plain = startSession({ title: 'Default', taskId: t.id });
    assert.equal(plain.mode, 'stopwatch');
    assert.equal(plain.plannedMinutes, null);
    stopSession(plain.id, 'abandoned');

    const timed = startSession({ title: 'Sprint', taskId: t.id, plannedMinutes: 30 });
    assert.equal(timed.mode, 'pomodoro');
    assert.equal(timed.plannedMinutes, 30);
    stopSession(timed.id, 'abandoned');

    const pomodoro = startSession({ title: 'Asked for it', taskId: t.id, mode: 'pomodoro' });
    assert.equal(pomodoro.mode, 'pomodoro');
    assert.equal(pomodoro.plannedMinutes, 45);
    stopSession(pomodoro.id, 'abandoned');

    const rest = startSession({ title: 'Stretch', taskId: t.id, kind: 'break' });
    assert.equal(rest.mode, 'pomodoro');
    assert.equal(rest.plannedMinutes, 10);
    stopSession(rest.id, 'abandoned');
  });

  it("never copies the task's estimate onto the block", async () => {
    const { startSession, stopSession } = await sessionsMod();
    // Two hours is the whole task, across however many blocks it takes.
    const t = await task('Competitor teardown', { estimatedMinutes: 120 });

    const block = startSession({ title: 'First pass', taskId: t.id });
    assert.equal(block.estimatedMinutes, null);
    assert.equal(block.plannedMinutes, null);
    stopSession(block.id, 'abandoned');

    // A guess made for the block itself is still the block's own.
    const guessed = startSession({ title: 'Second pass', taskId: t.id, estimatedMinutes: 20 });
    assert.equal(guessed.estimatedMinutes, 20);
  });
});

/* ------------------------------------------------------------ logged time */

describe('time logged on a task', () => {
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('adds up finished blocks, leaving out breaks, discarded blocks and other work', async () => {
    freeze('2026-10-08T09:00:00.000Z');
    const a = await task('Task A');
    const b = await task('Task B');

    await loggedBlock(a.id, 1800);
    advance(HOUR); // 10:00
    await loggedBlock(b.id, 900);
    await loggedBlock(null, 1200);
    advance(HOUR); // 11:00
    await loggedBlock(a.id, 2400);
    // The latest blocks of all, so they would show up in lastWorkedAt if they were counted.
    advance(HOUR); // 12:00
    await loggedBlock(a.id, 600, { status: 'abandoned' });
    advance(HOUR); // 13:00
    await loggedBlock(a.id, 300, { kind: 'break' });

    const { listTasks } = await tasksMod();
    const byTitle = new Map(listTasks({ view: 'all' }).map((t) => [t.title, t]));
    const viewA = byTitle.get('Task A')!;
    assert.equal(viewA.loggedSeconds, 4200);
    assert.equal(viewA.blockCount, 2);
    assert.equal(viewA.lastWorkedAt, '2026-10-08T11:00:00.000Z');

    const viewB = byTitle.get('Task B')!;
    assert.equal(viewB.loggedSeconds, 900);
    assert.equal(viewB.blockCount, 1);
    assert.equal(viewB.lastWorkedAt, '2026-10-08T10:00:00.000Z');
  });

  it('reads a task nothing was logged on as zero blocks and no last-worked time', async () => {
    const t = await task('Untouched');
    assert.deepEqual([t.loggedSeconds, t.blockCount, t.lastWorkedAt], [0, 0, null]);
  });

  it('counts the running block by what the clock says, and only once', async () => {
    freeze('2026-10-08T09:00:00.000Z');
    const { startSession, pauseSession, resumeSession, stopSession } = await sessionsMod();
    const { db } = await dbMod();
    const t = await task('Long task');
    await loggedBlock(t.id, 1800);

    advance(HOUR); // 10:00
    const live = startSession({ title: 'Deep work', taskId: t.id });
    // Just started: no time yet, but it is already a block on the task.
    let view = await reread(t.id);
    assert.equal(view.loggedSeconds, 1800);
    assert.equal(view.blockCount, 2);
    assert.equal(view.lastWorkedAt, '2026-10-08T10:00:00.000Z');

    advance(10 * MINUTE);
    view = await reread(t.id);
    assert.equal(view.loggedSeconds, 2400);
    // The proof that the clock, not the stored column, is what is read: it is still zero there.
    const stored = () =>
      (
        db.prepare('SELECT active_seconds AS s FROM sessions WHERE id = ?').get(live.id) as {
          s: number;
        }
      ).s;
    assert.equal(stored(), 0);

    // Paused, the ten minutes are flushed to the block: counted once, not twice.
    pauseSession(live.id);
    assert.equal(stored(), 600);
    assert.equal((await reread(t.id)).loggedSeconds, 2400);
    assert.equal((await reread(t.id)).blockCount, 2);

    // Paused time is never worked time.
    advance(HOUR);
    assert.equal((await reread(t.id)).loggedSeconds, 2400);

    // Running again: the segment worked before the pause plus the one that is open now.
    resumeSession(live.id);
    advance(5 * MINUTE);
    view = await reread(t.id);
    assert.equal(view.loggedSeconds, 2700);
    assert.equal(view.blockCount, 2);

    // And finished, it still adds up to the same.
    stopSession(live.id, 'completed');
    view = await reread(t.id);
    assert.equal(view.loggedSeconds, 2700);
    assert.equal(view.blockCount, 2);
  });

  it('shows the running block on the list as well as on a single task', async () => {
    freeze('2026-10-08T09:00:00.000Z');
    const { startSession } = await sessionsMod();
    const { listTasks } = await tasksMod();
    const t = await task('On the clock');
    await task('Not on the clock');
    startSession({ title: 'Working', taskId: t.id });
    advance(25 * MINUTE);

    const [on, off] = listTasks();
    assert.equal(on!.title, 'On the clock');
    assert.equal(on!.loggedSeconds, 1500);
    assert.equal(off!.title, 'Not on the clock');
    assert.equal(off!.loggedSeconds, 0);
  });

  it('does not count a running block that is a break, or that is on no task', async () => {
    freeze('2026-10-08T09:00:00.000Z');
    const { startSession, stopSession } = await sessionsMod();
    const t = await task('Bystander');

    const free = startSession({ title: 'Unfiled work' });
    advance(10 * MINUTE);
    assert.deepEqual([(await reread(t.id)).loggedSeconds, (await reread(t.id)).blockCount], [0, 0]);
    stopSession(free.id, 'abandoned');

    startSession({ title: 'Stretch', kind: 'break', taskId: t.id });
    advance(5 * MINUTE);
    assert.deepEqual([(await reread(t.id)).loggedSeconds, (await reread(t.id)).blockCount], [0, 0]);
  });

  it('does not count a running block for a task it is not on', async () => {
    freeze('2026-10-08T09:00:00.000Z');
    const { startSession } = await sessionsMod();
    const mine = await task('Mine');
    const theirs = await task('Theirs');
    startSession({ title: 'Mine, now', taskId: mine.id });
    advance(20 * MINUTE);
    assert.equal((await reread(mine.id)).loggedSeconds, 1200);
    assert.equal((await reread(theirs.id)).loggedSeconds, 0);
  });
});

/* --------------------------------------------------------------- deleting */

describe('deleting a task', () => {
  beforeEach(reset);

  it('keeps the blocks logged on it, unlinked, with every minute', async () => {
    const { toView, getSessionRow } = await sessionsMod();
    const { deleteTask, listTasks } = await tasksMod();
    const { db } = await dbMod();
    const roi = await makeProject('ROI Dashboard');
    const t = await task('Doomed', { projectId: roi });
    const first = await loggedBlock(t.id, 900);
    const second = await loggedBlock(t.id, 600);
    assert.equal(toView(getSessionRow(first.id)).taskTitle, 'Doomed');

    deleteTask(t.id);

    assert.deepEqual(listTasks({ view: 'all' }), []);
    assert.throws(() => deleteTask(t.id), { status: 404 });
    assert.deepEqual(
      db
        .prepare('SELECT id, task_id, active_seconds, status, project_id FROM sessions ORDER BY id')
        .all(),
      [
        { id: first.id, task_id: null, active_seconds: 900, status: 'completed', project_id: roi },
        { id: second.id, task_id: null, active_seconds: 600, status: 'completed', project_id: roi },
      ],
    );
    const view = toView(getSessionRow(first.id));
    assert.equal(view.taskId, null);
    assert.equal(view.taskTitle, null);
    assert.equal(view.elapsedSeconds, 900);
  });

  it('keeps a block that is still on the clock, and the clock keeps running', async () => {
    const { startSession, liveSessionRow, toView } = await sessionsMod();
    const { deleteTask } = await tasksMod();
    const t = await task('Deleted mid-block');
    const live = startSession({ title: 'Mid-block', taskId: t.id });
    deleteTask(t.id);
    const after = liveSessionRow();
    assert.equal(after?.id, live.id);
    assert.equal(toView(after!).status, 'running');
    assert.equal(toView(after!).taskId, null);
  });

  it('does not touch the other tasks, or the blocks on them', async () => {
    const { deleteTask } = await tasksMod();
    const gone = await task('Gone');
    const kept = await task('Kept');
    await loggedBlock(kept.id, 1200);
    deleteTask(gone.id);
    const view = await reread(kept.id);
    assert.equal(view.loggedSeconds, 1200);
    assert.equal(view.blockCount, 1);
  });

  it('leaves the tasks of a deleted project as misc tasks', async () => {
    const { db } = await dbMod();
    const { listTasks } = await tasksMod();
    const doomed = await makeProject('Doomed project', '#e34948');
    const owned = await task('Belonged to it', { projectId: doomed });
    const misc = await task('Always misc');

    db.prepare('DELETE FROM projects WHERE id = ?').run(doomed);

    const after = await reread(owned.id);
    assert.equal(after.title, 'Belonged to it');
    assert.equal(after.projectId, null);
    assert.equal(after.projectName, null);
    assert.equal(after.projectColor, null);
    assert.deepEqual(
      listTasks({ projectId: 'none' }).map((t) => t.id),
      [owned.id, misc.id],
    );
  });
});

/* ----------------------------------------------------------------- overdue */

describe('an overdue task', () => {
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('is past its target day and not completed', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const past = '2026-10-07';
    const cases: [string, Partial<TaskInput>, boolean][] = [
      ['not started', { targetDate: past }, true],
      ['in progress', { targetDate: past, status: 'in_progress' }, true],
      ['held up', { targetDate: past, status: 'held_up' }, true],
      ['completed', { targetDate: past, status: 'completed' }, false],
      ['due today', { targetDate: '2026-10-08' }, false],
      ['due tomorrow', { targetDate: '2026-10-09' }, false],
      ['with no target', {}, false],
    ];
    for (const [label, input, overdue] of cases) {
      assert.equal((await task(label, input)).overdue, overdue, label);
    }
  });

  it('stops being overdue when it is completed, and is again when it is reopened', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { updateTask } = await tasksMod();
    const t = await task('Late', { targetDate: '2026-10-01' });
    assert.equal(t.overdue, true);
    assert.equal(updateTask(t.id, { status: 'completed' }).overdue, false);
    assert.equal(updateTask(t.id, { status: 'in_progress' }).overdue, true);
    assert.equal(updateTask(t.id, { targetDate: '2026-10-08' }).overdue, false);
  });

  it('goes by the day the user is in, so it is not overdue before the day rolls over', async () => {
    // 02:00 UTC on the 8th is still the 7th for someone whose day starts at 04:00.
    freeze('2026-10-08T02:00:00.000Z');
    const dueYesterday = await task('Due the 7th', { targetDate: '2026-10-07' });
    const dueBefore = await task('Due the 6th', { targetDate: '2026-10-06' });
    assert.equal(dueYesterday.overdue, false);
    assert.equal(dueBefore.overdue, true);

    advance(3 * HOUR); // 05:00 UTC: the 8th has begun
    assert.equal((await reread(dueYesterday.id)).overdue, true);
  });

  it('shows up in the list the same way', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { listTasks } = await tasksMod();
    await task('Late', { targetDate: '2026-10-01' });
    await task('Fine', { targetDate: '2026-10-30' });
    assert.deepEqual(
      listTasks().map((t) => [t.title, t.overdue]),
      [
        ['Late', true],
        ['Fine', false],
      ],
    );
  });
});

/* ----------------------------------------------------------------- listing */

describe('listing tasks', () => {
  beforeEach(reset);

  async function mixed() {
    await task('Not started one');
    await task('In progress one', { status: 'in_progress' });
    await task('Held up one', { status: 'held_up' });
    await task('Completed one', { status: 'completed' });
  }
  const titles = async (f?: Parameters<Awaited<ReturnType<typeof tasksMod>>['listTasks']>[0]) => {
    const { listTasks } = await tasksMod();
    return listTasks(f).map((t) => t.title);
  };

  it('shows every status but completed by default, and as the open view', async () => {
    await mixed();
    const open = ['Not started one', 'In progress one', 'Held up one'];
    assert.deepEqual(await titles(), open);
    assert.deepEqual(await titles({}), open);
    assert.deepEqual(await titles({ view: 'open' }), open);
  });

  it('shows only the completed ones in the completed view', async () => {
    await mixed();
    assert.deepEqual(await titles({ view: 'completed' }), ['Completed one']);
  });

  it('shows everything in the all view', async () => {
    await mixed();
    assert.deepEqual(await titles({ view: 'all' }), [
      'Not started one',
      'In progress one',
      'Held up one',
      'Completed one',
    ]);
  });

  it('moves a task between the open and completed views as its status changes', async () => {
    const { updateTask } = await tasksMod();
    const t = await task('Wanders');
    assert.deepEqual(await titles({ view: 'open' }), ['Wanders']);
    updateTask(t.id, { status: 'completed' });
    assert.deepEqual(await titles({ view: 'open' }), []);
    assert.deepEqual(await titles({ view: 'completed' }), ['Wanders']);
    updateTask(t.id, { status: 'held_up' });
    assert.deepEqual(await titles({ view: 'open' }), ['Wanders']);
    assert.deepEqual(await titles({ view: 'completed' }), []);
  });

  it('puts the newest week first, then high before medium before low, then the given order', async () => {
    await task('L1', { priority: 'low', addedOn: '2026-10-05' });
    await task('H1', { priority: 'high', addedOn: '2026-10-05' });
    await task('M1', { priority: 'medium', addedOn: '2026-10-05' });
    await task('H2', { priority: 'high', addedOn: '2026-10-05' });
    await task('N1', { priority: 'low', addedOn: '2026-10-12' });
    await task('O1', { priority: 'high', addedOn: '2026-09-28' });
    // Priority ranks within a week, not across them: the 12th starts a new week, so its low
    // outranks the 5th's high.
    assert.deepEqual(await titles({ view: 'all' }), ['N1', 'H1', 'H2', 'M1', 'L1', 'O1']);
  });

  it('puts the most pressing first within a week, whatever day each was added', async () => {
    // Made in the opposite order, so neither the ids nor the positions help.
    await task('Low on Friday', { priority: 'low', addedOn: '2026-10-09' });
    await task('Medium on Tuesday', { priority: 'medium', addedOn: '2026-10-06' });
    await task('High on Monday', { priority: 'high', addedOn: '2026-10-05' });
    assert.deepEqual(await titles({ view: 'all' }), [
      'High on Monday',
      'Medium on Tuesday',
      'Low on Friday',
    ]);
  });

  it('puts the newer day first among tasks of the same week and priority', async () => {
    await task('High on Monday', { priority: 'high', addedOn: '2026-10-05' });
    await task('High on Thursday', { priority: 'high', addedOn: '2026-10-08' });
    await task('High on Wednesday', { priority: 'high', addedOn: '2026-10-07' });
    assert.deepEqual(await titles({ view: 'all' }), [
      'High on Thursday',
      'High on Wednesday',
      'High on Monday',
    ]);
  });

  it('still puts a newer week above an older one, whatever the priorities', async () => {
    await task('High, older week', { priority: 'high', addedOn: '2026-10-09' });
    await task('Low, newer week', { priority: 'low', addedOn: '2026-10-12' });
    await task('Medium, oldest week', { priority: 'medium', addedOn: '2026-09-30' });
    assert.deepEqual(await titles({ view: 'all' }), [
      'Low, newer week',
      'High, older week',
      'Medium, oldest week',
    ]);
  });

  it('keeps a Sunday with the week it ends, and a Monday with the week it starts', async () => {
    // Sunday the 11th closes the week of the 5th; Monday the 12th opens the next one.
    await task('Medium on Monday the 5th', { priority: 'medium', addedOn: '2026-10-05' });
    await task('High on Sunday the 11th', { priority: 'high', addedOn: '2026-10-11' });
    await task('Low on Monday the 12th', { priority: 'low', addedOn: '2026-10-12' });
    await task('High on Sunday the 4th', { priority: 'high', addedOn: '2026-10-04' });
    assert.deepEqual(await titles({ view: 'all' }), [
      'Low on Monday the 12th',
      'High on Sunday the 11th',
      'Medium on Monday the 5th',
      'High on Sunday the 4th',
    ]);
  });

  it('files every weekday under the same Monday the view reports as its week', async () => {
    const { listTasks } = await tasksMod();
    // Sunday the 4th through Sunday the 18th: three weeks' worth of edges, every weekday twice.
    const days = Array.from({ length: 15 }, (_, i) =>
      new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10),
    );
    const priorities = ['high', 'medium', 'low'] as const;
    const made = days.flatMap((day) => priorities.map((priority) => ({ day, priority })));
    // Made in a scrambled order (7 is coprime with 45, so each is made once), so neither ids
    // nor positions can stand in for the sort.
    for (let i = 0; i < made.length; i++) {
      const { day, priority } = made[(i * 7) % made.length]!;
      await task(`${day} ${priority}`, { priority, addedOn: day });
    }
    // The expected order, worked out in JS by the rule the view's own weekOf uses.
    const rank = { high: 0, medium: 1, low: 2 };
    const expected = [...made]
      .sort(
        (a, b) =>
          weekStart(b.day).localeCompare(weekStart(a.day)) ||
          rank[a.priority] - rank[b.priority] ||
          b.day.localeCompare(a.day),
      )
      .map((t) => `${t.day} ${t.priority}`);
    const listed = listTasks({ view: 'all' });
    assert.deepEqual(
      listed.map((t) => t.title),
      expected,
    );
    // The weeks themselves run newest to oldest, with none split in two.
    const weeks = listed.map((t) => t.weekOf);
    assert.deepEqual(weeks, [...weeks].sort().reverse());
    assert.equal(new Set(weeks).size, 3);
  });

  it('breaks a tie on the same day and priority by position, then by id', async () => {
    const { db } = await dbMod();
    const a = await task('First made');
    const b = await task('Second made');
    const c = await task('Third made');
    assert.deepEqual(await titles(), ['First made', 'Second made', 'Third made']);
    // Equal positions fall back to id, so the order is still settled.
    db.prepare('UPDATE tasks SET position = 7').run();
    assert.deepEqual(await titles(), ['First made', 'Second made', 'Third made']);
    db.prepare('UPDATE tasks SET position = 1 WHERE id = ?').run(c.id);
    db.prepare('UPDATE tasks SET position = 2 WHERE id = ?').run(a.id);
    db.prepare('UPDATE tasks SET position = 3 WHERE id = ?').run(b.id);
    assert.deepEqual(await titles(), ['Third made', 'First made', 'Second made']);
  });
});

/* ----------------------------------------------------------------- reorder */

describe('reordering tasks', () => {
  beforeEach(reset);

  it('sets positions in the order given', async () => {
    const { reorderTasks, listTasks } = await tasksMod();
    const a = await task('A');
    const b = await task('B');
    const c = await task('C');
    assert.deepEqual(
      listTasks().map((t) => [t.title, t.position]),
      [
        ['A', 0],
        ['B', 1],
        ['C', 2],
      ],
    );

    assert.equal(reorderTasks([c.id, a.id, b.id]), 3);
    assert.deepEqual(
      listTasks().map((t) => [t.title, t.position]),
      [
        ['C', 0],
        ['A', 1],
        ['B', 2],
      ],
    );

    reorderTasks([b.id, c.id, a.id]);
    assert.deepEqual(
      listTasks().map((t) => t.title),
      ['B', 'C', 'A'],
    );
  });

  it('puts a task made afterwards at the end', async () => {
    const { reorderTasks, listTasks } = await tasksMod();
    const a = await task('A');
    const b = await task('B');
    reorderTasks([b.id, a.id]);
    const c = await task('C');
    assert.equal(c.position, 2);
    assert.deepEqual(
      listTasks().map((t) => t.title),
      ['B', 'A', 'C'],
    );
  });

  it('never lifts a task out of its week or its priority', async () => {
    const { reorderTasks, listTasks } = await tasksMod();
    const late = await task('Late week', { addedOn: '2026-10-12' });
    const early = await task('Early week', { addedOn: '2026-10-05' });
    const low = await task('Low', { addedOn: '2026-10-05', priority: 'low' });
    reorderTasks([low.id, early.id, late.id]);
    assert.deepEqual(
      listTasks().map((t) => t.title),
      ['Late week', 'Early week', 'Low'],
    );
  });
});

/* -------------------------------------------------------------- over HTTP */

describe('tasks over the API', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    projectId = await makeProject('ROI Dashboard', '#0ea5e9');
    api = await serve();
  });

  beforeEach(async () => {
    const { db } = await dbMod();
    db.exec('DELETE FROM session_segments; DELETE FROM sessions; DELETE FROM tasks;');
  });

  after(() => api.close());

  const everything = async () => (await api.call('GET', '/tasks?view=all')).body;

  it('creates, edits, lists and deletes a task', async () => {
    const created = await api.call('POST', '/tasks', {
      title: '  Draft the plan  ',
      projectId,
      priority: 'high',
      estimatedMinutes: 120,
      targetDate: '2026-10-30',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Draft the plan');
    assert.equal(created.body.priority, 'high');
    assert.equal(created.body.status, 'not_started');
    assert.equal(created.body.projectName, 'ROI Dashboard');
    assert.equal(created.body.estimatedMinutes, 120);
    assert.equal(created.body.targetDate, '2026-10-30');
    const id = created.body.id;

    const patched = await api.call('PATCH', `/tasks/${id}`, {
      status: 'in_progress',
      notes: 'On it',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, 'in_progress');
    assert.equal(patched.body.notes, 'On it');
    assert.match(patched.body.startDate, /^\d{4}-\d{2}-\d{2}$/);

    const listed = await api.call('GET', '/tasks');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.map((t: { id: number }) => t.id),
      [id],
    );

    const cleared = await api.call('PATCH', `/tasks/${id}`, {
      estimatedMinutes: null,
      targetDate: null,
      projectId: null,
      notes: null,
    });
    assert.equal(cleared.body.estimatedMinutes, null);
    assert.equal(cleared.body.targetDate, null);
    assert.equal(cleared.body.projectId, null);
    assert.equal(cleared.body.projectName, null);
    assert.equal(cleared.body.notes, null);

    const unchanged = await api.call('PATCH', `/tasks/${id}`, {});
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.body, cleared.body);

    const gone = await api.call('DELETE', `/tasks/${id}`);
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body, { deleted: id });
    assert.deepEqual(await everything(), []);
  });

  it('lists by view and project through the query string', async () => {
    const misc = (await api.call('POST', '/tasks', { title: 'Misc open' })).body;
    const owned = (
      await api.call('POST', '/tasks', { title: 'Owned done', projectId, status: 'completed' })
    ).body;

    const ids = async (query: string) =>
      (await api.call('GET', `/tasks${query}`)).body.map((t: { id: number }) => t.id);
    assert.deepEqual(await ids(''), [misc.id]);
    assert.deepEqual(await ids('?view=open'), [misc.id]);
    assert.deepEqual(await ids('?view=completed'), [owned.id]);
    assert.deepEqual(await ids('?view=all'), [misc.id, owned.id]);
    assert.deepEqual(await ids('?view=all&projectId=none'), [misc.id]);
    assert.deepEqual(await ids(`?view=all&projectId=${projectId}`), [owned.id]);
    assert.deepEqual(await ids(`?projectId=${projectId}`), []);

    assert.equal(await api.status('GET', '/tasks?view=bogus'), 400);
    assert.equal(await api.status('GET', '/tasks?projectId=abc'), 400);
    assert.equal(await api.status('GET', '/tasks?projectId=0'), 400);
  });

  it('refuses a priority that is not high, medium or low', async () => {
    assert.equal(await api.status('POST', '/tasks', { title: 'x', priority: 'urgent' }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x', priority: 'HIGH' }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x', priority: null }), 400);

    const t = (await api.call('POST', '/tasks', { title: 'Keep me' })).body;
    assert.equal(await api.status('PATCH', `/tasks/${t.id}`, { priority: 'urgent' }), 400);
    assert.equal((await everything())[0].priority, 'medium');
  });

  it('refuses a status that is not one of the four', async () => {
    assert.equal(await api.status('POST', '/tasks', { title: 'x', status: 'done' }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x', status: 'In Progress' }), 400);

    const t = (await api.call('POST', '/tasks', { title: 'Keep me' })).body;
    assert.equal(await api.status('PATCH', `/tasks/${t.id}`, { status: 'done' }), 400);
    assert.equal((await everything())[0].status, 'not_started');
  });

  it('refuses a date that is not YYYY-MM-DD, whichever field it is in', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Keep me' })).body;
    for (const field of ['addedOn', 'startDate', 'targetDate', 'completedOn']) {
      for (const bad of [
        '2026-1-5',
        '10/08/2026',
        'tomorrow',
        '2026-10-08T00:00:00Z',
        '20261008',
        '',
      ]) {
        const body = { title: 'x', [field]: bad };
        assert.equal(await api.status('POST', '/tasks', body), 400, `POST ${field}=${bad}`);
        assert.equal(
          await api.status('PATCH', `/tasks/${t.id}`, { [field]: bad }),
          400,
          `PATCH ${field}=${bad}`,
        );
      }
    }
    assert.equal((await everything()).length, 1);
  });

  it('refuses a date that has the right shape but is not on the calendar', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-00']) {
      assert.equal(await api.status('POST', '/tasks', { title: 'x', addedOn: bad }), 400, bad);
      assert.equal(await api.status('POST', '/tasks', { title: 'x', targetDate: bad }), 400, bad);
    }
    // A leap day is a day.
    assert.equal(
      await api.status('POST', '/tasks', { title: 'Leap', targetDate: '2028-02-29' }),
      201,
    );
    // And nothing bad got in to break the list.
    assert.equal((await api.call('GET', '/tasks?view=all')).status, 200);
  });

  it('accepts null to clear a date, but not to blank the added-on day', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Dated', targetDate: '2026-10-30' })).body;
    const cleared = await api.call('PATCH', `/tasks/${t.id}`, {
      targetDate: null,
      startDate: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.targetDate, null);
    assert.equal(await api.status('PATCH', `/tasks/${t.id}`, { addedOn: null }), 400);
  });

  it('refuses an estimate outside 1-6000 whole minutes', async () => {
    for (const bad of [0, -5, 6001, 1.5, '30', true]) {
      assert.equal(
        await api.status('POST', '/tasks', { title: 'x', estimatedMinutes: bad }),
        400,
        `estimate ${String(bad)}`,
      );
    }
    assert.equal((await everything()).length, 0);

    // Both ends are in range, and null means none.
    assert.equal(
      (await api.call('POST', '/tasks', { title: 'One', estimatedMinutes: 1 })).status,
      201,
    );
    const top = await api.call('POST', '/tasks', { title: 'Max', estimatedMinutes: 6000 });
    assert.equal(top.status, 201);
    assert.equal(top.body.estimatedMinutes, 6000);
    assert.equal(
      await api.status('PATCH', `/tasks/${top.body.id}`, { estimatedMinutes: 6001 }),
      400,
    );
    assert.equal(
      (await api.call('PATCH', `/tasks/${top.body.id}`, { estimatedMinutes: null })).body
        .estimatedMinutes,
      null,
    );
  });

  it('refuses a missing, blank or oversized title, and notes that are too long', async () => {
    assert.equal(await api.status('POST', '/tasks', {}), 400);
    assert.equal(await api.status('POST', '/tasks', { title: '' }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: '   ' }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x'.repeat(301) }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x'.repeat(300) }), 201);
    assert.equal(
      await api.status('POST', '/tasks', { title: 'x', notes: 'n'.repeat(20_001) }),
      400,
    );
    assert.equal(
      await api.status('POST', '/tasks', { title: 'x', results: 'r'.repeat(20_001) }),
      400,
    );
    assert.equal(
      await api.status('POST', '/tasks', { title: 'x', notes: 'n'.repeat(20_000) }),
      201,
    );
  });

  it('refuses a project that is not there or is malformed', async () => {
    assert.equal(await api.status('POST', '/tasks', { title: 'x', projectId: 999_999 }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x', projectId: 0 }), 400);
    assert.equal(await api.status('POST', '/tasks', { title: 'x', projectId: 'roi' }), 400);
    const t = (await api.call('POST', '/tasks', { title: 'Stays', projectId })).body;
    const res = await api.call('PATCH', `/tasks/${t.id}`, { projectId: 999_999 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown project');
    assert.equal((await everything())[0].projectId, projectId);
  });

  it('answers 404 to an unknown id and 400 to a malformed one', async () => {
    const patch = await api.call('PATCH', '/tasks/999999', { title: 'Nobody' });
    assert.equal(patch.status, 404);
    assert.equal(patch.body.error, 'Task not found');
    assert.equal(await api.status('DELETE', '/tasks/999999'), 404);

    assert.equal(await api.status('PATCH', '/tasks/abc', { title: 'x' }), 400);
    assert.equal(await api.status('PATCH', '/tasks/0', { title: 'x' }), 400);
    assert.equal(await api.status('DELETE', '/tasks/-1'), 400);
  });

  it('leaves a task exactly as it was when an update is refused', async () => {
    const t = (
      await api.call('POST', '/tasks', { title: 'Original', priority: 'high', notes: 'keep' })
    ).body;
    const before = await everything();
    // The title alone would be fine; the status is what is wrong, so none of it may land.
    assert.equal(
      await api.status('PATCH', `/tasks/${t.id}`, { title: 'Changed', status: 'nope' }),
      400,
    );
    assert.deepEqual(await everything(), before);
  });

  it('puts tasks in the order given when they are reordered', async () => {
    const make = async (title: string) => (await api.call('POST', '/tasks', { title })).body.id;
    const a = await make('A');
    const b = await make('B');
    const c = await make('C');
    const order = async () => (await everything()).map((t: { title: string }) => t.title);
    assert.deepEqual(await order(), ['A', 'B', 'C']);

    const res = await api.call('POST', '/tasks/reorder', { ids: [c, a, b] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { reordered: 3 });
    assert.deepEqual(await order(), ['C', 'A', 'B']);

    assert.equal(await api.status('POST', '/tasks/reorder', {}), 400);
    assert.equal(await api.status('POST', '/tasks/reorder', { ids: 'abc' }), 400);
    assert.equal(await api.status('POST', '/tasks/reorder', { ids: [0] }), 400);
    assert.equal(await api.status('POST', '/tasks/reorder', { ids: [1.5] }), 400);
    assert.equal(await api.status('POST', '/tasks/reorder', { ids: ['x'] }), 400);
    assert.deepEqual(await order(), ['C', 'A', 'B']);
  });

  it("turns a hard-deleted project's tasks into misc ones", async () => {
    const doomed = (await api.call('POST', '/projects', { name: 'Doomed', color: '#e34948' })).body;
    const t = (await api.call('POST', '/tasks', { title: 'Orphan-to-be', projectId: doomed.id }))
      .body;
    assert.equal(t.projectName, 'Doomed');

    assert.equal(await api.status('DELETE', `/projects/${doomed.id}?hard=true`), 200);

    const after = (await everything()).find((x: { id: number }) => x.id === t.id);
    assert.equal(after.projectId, null);
    assert.equal(after.projectName, null);
    const misc = (await api.call('GET', '/tasks?projectId=none')).body;
    assert.deepEqual(
      misc.map((x: { id: number }) => x.id),
      [t.id],
    );
  });
});

describe('a block started on a task over the API', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    projectId = await makeProject('ROI Dashboard', '#0ea5e9');
    api = await serve();
  });

  beforeEach(async () => {
    const { db } = await dbMod();
    db.exec('DELETE FROM session_segments; DELETE FROM sessions; DELETE FROM tasks;');
  });

  after(() => api.close());

  it('links the block, moves the task along, and shows the time against its estimate', async () => {
    const made = (
      await api.call('POST', '/tasks', {
        title: 'Competitor teardown',
        projectId,
        estimatedMinutes: 120,
      })
    ).body;

    const started = await api.call('POST', '/sessions', {
      title: 'Teardown, first pass',
      taskId: made.id,
    });
    assert.equal(started.status, 201);
    assert.equal(started.body.taskId, made.id);
    assert.equal(started.body.taskTitle, 'Competitor teardown');
    assert.equal(started.body.projectId, projectId);
    assert.equal(started.body.mode, 'stopwatch');
    assert.equal(started.body.estimatedMinutes, null);

    const active = (await api.call('GET', '/sessions/active')).body.session;
    assert.equal(active.taskId, made.id);
    assert.equal(active.taskTitle, 'Competitor teardown');

    const running = (await api.call('GET', '/tasks')).body[0];
    assert.equal(running.status, 'in_progress');
    assert.equal(running.blockCount, 1);

    const done = await api.call('POST', `/sessions/${started.body.id}/complete`, {
      focusRating: 4,
      activeSeconds: 3600,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.taskId, made.id);

    const after = (await api.call('GET', '/tasks')).body[0];
    assert.equal(after.loggedSeconds, 3600);
    assert.equal(after.blockCount, 1);
    assert.equal(after.estimatedMinutes, 120);

    // The block carries its task into the day's rollup too.
    const day = (await api.call('GET', `/stats/day?day=${started.body.day}`)).body;
    assert.equal(day.sessions[0].taskId, made.id);
    assert.equal(day.sessions[0].taskTitle, 'Competitor teardown');
  });

  it('keeps an explicit project, and an explicit none, over the one the task has', async () => {
    const made = (await api.call('POST', '/tasks', { title: 'Has a project', projectId })).body;
    const none = await api.call('POST', '/sessions', {
      title: 'Billed to nobody',
      taskId: made.id,
      projectId: null,
    });
    assert.equal(none.status, 201);
    assert.equal(none.body.projectId, null);
    assert.equal(none.body.taskId, made.id);
  });

  it('refuses an unknown task with a 400, and starts nothing', async () => {
    const res = await api.call('POST', '/sessions', { title: 'Ghost', taskId: 999_999 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown task');
    assert.equal((await api.call('GET', '/sessions/active')).body.session, null);
  });

  it('refuses a task id that is not a positive whole number', async () => {
    for (const bad of [0, -1, 1.5, '1', true]) {
      assert.equal(
        await api.status('POST', '/sessions', { title: 'x', taskId: bad }),
        400,
        `taskId ${String(bad)}`,
      );
    }
    assert.equal((await api.call('GET', '/sessions/active')).body.session, null);
  });

  it('starts a block with no task exactly as before', async () => {
    const res = await api.call('POST', '/sessions', { title: 'Loose work', projectId });
    assert.equal(res.status, 201);
    assert.equal(res.body.taskId, null);
    assert.equal(res.body.taskTitle, null);
    assert.equal(res.body.projectId, projectId);
    assert.equal(res.body.mode, 'stopwatch');
  });
});

/* ------------------------------------------------ moving a logged block */

describe('moving a logged block between tasks', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    projectId = await makeProject('ROI Dashboard', '#0ea5e9');
    api = await serve();
  });

  beforeEach(async () => {
    const { db } = await dbMod();
    db.exec('DELETE FROM session_segments; DELETE FROM sessions; DELETE FROM tasks;');
  });

  after(() => api.close());

  /** Every column of the block and every one of its segments, so "unchanged" means all of it. */
  async function stored(id: number) {
    const { db } = await dbMod();
    return {
      block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow,
      segments: db
        .prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id')
        .all(id),
    };
  }

  /** A finished, unlinked ten-minute block. */
  async function looseBlock(title = 'Loose work') {
    const started = await api.call('POST', '/sessions', { title, projectId });
    const done = await api.call('POST', `/sessions/${started.body.id}/complete`, {
      activeSeconds: 600,
    });
    return done.body;
  }

  const logged = async (id: number) =>
    (await api.call('GET', '/tasks?view=all')).body.find((t: { id: number }) => t.id === id)
      .loggedSeconds;

  it('links a block to a task, moves it to another, and unlinks it, the time following', async () => {
    const a = (await api.call('POST', '/tasks', { title: 'Task A' })).body;
    const b = (await api.call('POST', '/tasks', { title: 'Task B' })).body;
    const block = await looseBlock();
    assert.equal(block.taskId, null);
    assert.equal(block.taskTitle, null);
    assert.deepEqual([await logged(a.id), await logged(b.id)], [0, 0]);

    const linked = await api.call('PATCH', `/sessions/${block.id}`, { taskId: a.id });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.taskId, a.id);
    assert.equal(linked.body.taskTitle, 'Task A');
    assert.deepEqual([await logged(a.id), await logged(b.id)], [600, 0]);

    const moved = await api.call('PATCH', `/sessions/${block.id}`, { taskId: b.id });
    assert.equal(moved.body.taskId, b.id);
    assert.equal(moved.body.taskTitle, 'Task B');
    assert.deepEqual([await logged(a.id), await logged(b.id)], [0, 600]);

    const unlinked = await api.call('PATCH', `/sessions/${block.id}`, { taskId: null });
    assert.equal(unlinked.status, 200);
    assert.equal(unlinked.body.taskId, null);
    assert.equal(unlinked.body.taskTitle, null);
    assert.equal(unlinked.body.elapsedSeconds, 600);
    assert.deepEqual([await logged(a.id), await logged(b.id)], [0, 0]);
  });

  it('can link a block that is still on the clock', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Picked late' })).body;
    const started = await api.call('POST', '/sessions', { title: 'Forgot to pick a task' });
    const res = await api.call('PATCH', `/sessions/${started.body.id}`, { taskId: t.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.taskId, t.id);
    assert.equal(res.body.status, 'running');
    const after = (await api.call('GET', '/tasks?view=all')).body[0];
    assert.equal(after.blockCount, 1);
  });

  it('refuses a task that is not there, and leaves the block exactly as it was', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Real task' })).body;
    const block = await looseBlock();
    await api.call('PATCH', `/sessions/${block.id}`, { taskId: t.id });
    const before = await stored(block.id);

    // The title and the time ride along to prove nothing is written before the refusal.
    const res = await api.call('PATCH', `/sessions/${block.id}`, {
      taskId: 999_999,
      title: 'Renamed',
      activeSeconds: 60,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown task');
    assert.deepEqual(await stored(block.id), before);
    assert.equal((await api.call('GET', `/sessions/${block.id}`)).body.taskId, t.id);
  });

  it('refuses a task id that is not a positive whole number', async () => {
    const block = await looseBlock();
    const before = await stored(block.id);
    for (const bad of [0, -3, 1.5, 'abc', true]) {
      assert.equal(
        await api.status('PATCH', `/sessions/${block.id}`, { taskId: bad }),
        400,
        `taskId ${String(bad)}`,
      );
    }
    assert.deepEqual(await stored(block.id), before);
  });

  it('applies a link together with the rest of the edit', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Alongside' })).body;
    const block = await looseBlock();
    const res = await api.call('PATCH', `/sessions/${block.id}`, {
      taskId: t.id,
      title: 'Retitled',
      activeSeconds: 1200,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Retitled');
    assert.equal(res.body.taskId, t.id);
    assert.equal(res.body.elapsedSeconds, 1200);
    assert.equal(await logged(t.id), 1200);
  });
});

/* --------------------------------------------------------------- migration */

describe('migration 4 on an existing database', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-tasks-migrate-'));
    dirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = (conn: Database.Database, table: string) =>
    (conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const backupsIn = (where: string) =>
    fs.readdirSync(where).filter((f) => /^focusdesk\.backup-before-\d+-.+\.sqlite$/.test(f));
  const names = (conn: Database.Database, sql: string) =>
    (conn.prepare(sql).all() as { name: string }[]).map((r) => r.name);

  it('keeps every row, leaves old blocks unlinked, and enforces the link from then on', async () => {
    const { runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      // The database as it stood before tasks shipped: migrations 1 to 3.
      const stamp = '2026-10-01T10:00:00.000Z';
      const end = '2026-10-01T10:45:00.000Z';
      await databaseBefore(conn, 4, stamp);
      conn
        .prepare(
          `INSERT INTO projects (id, name, color, created_at, updated_at)
           VALUES (1, 'ROI Dashboard', '#0ea5e9', ?, ?)`,
        )
        .run(stamp, stamp);
      const addSession = conn.prepare(
        `INSERT INTO sessions (id, project_id, title, planned_minutes, estimated_minutes,
           started_at, ended_at, local_day, active_seconds, focus_rating, status, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01', ?, ?, ?, ?, ?)`,
      );
      addSession.run(
        7,
        1,
        'Old pomodoro',
        45,
        null,
        stamp,
        end,
        2700,
        4,
        'completed',
        stamp,
        stamp,
      );
      addSession.run(
        8,
        1,
        'Old stopwatch',
        null,
        30,
        stamp,
        end,
        1800,
        5,
        'completed',
        stamp,
        stamp,
      );
      addSession.run(
        9,
        null,
        'Still running',
        null,
        null,
        stamp,
        null,
        0,
        null,
        'running',
        stamp,
        stamp,
      );
      const addSegment = conn.prepare(
        'INSERT INTO session_segments (id, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)',
      );
      addSegment.run(11, 7, stamp, end);
      addSegment.run(12, 8, stamp, end);
      addSegment.run(13, 9, stamp, null);
      conn
        .prepare(
          `INSERT INTO plan_items (plan_day, position, project_id, title, planned_minutes,
             session_id, done, created_at, updated_at)
           VALUES ('2026-10-01', 0, 1, 'Planned', 45, 7, 1, ?, ?)`,
        )
        .run(stamp, stamp);
      conn
        .prepare(
          `INSERT INTO saved_timers (project_id, title, planned_minutes, position, created_at)
           VALUES (1, 'Pinned before', 30, 0, ?)`,
        )
        .run(stamp);

      runMigrations(conn, file);

      assert.deepEqual(conn.prepare('SELECT id, name FROM _migrations ORDER BY id').all(), [
        { id: 1, name: 'initial schema' },
        { id: 2, name: 'saved timers' },
        { id: 3, name: 'stopwatch mode' },
        { id: 4, name: 'tasks' },
      ]);

      // Every old row is as it was, and none of the blocks points at a task.
      assert.deepEqual(
        conn
          .prepare(
            `SELECT id, project_id, title, planned_minutes, estimated_minutes, active_seconds,
                    focus_rating, status, task_id
             FROM sessions ORDER BY id`,
          )
          .all(),
        [
          {
            id: 7,
            project_id: 1,
            title: 'Old pomodoro',
            planned_minutes: 45,
            estimated_minutes: null,
            active_seconds: 2700,
            focus_rating: 4,
            status: 'completed',
            task_id: null,
          },
          {
            id: 8,
            project_id: 1,
            title: 'Old stopwatch',
            planned_minutes: null,
            estimated_minutes: 30,
            active_seconds: 1800,
            focus_rating: 5,
            status: 'completed',
            task_id: null,
          },
          {
            id: 9,
            project_id: null,
            title: 'Still running',
            planned_minutes: null,
            estimated_minutes: null,
            active_seconds: 0,
            focus_rating: null,
            status: 'running',
            task_id: null,
          },
        ],
      );
      assert.deepEqual(
        conn.prepare('SELECT id, session_id FROM session_segments ORDER BY id').all(),
        [
          { id: 11, session_id: 7 },
          { id: 12, session_id: 8 },
          { id: 13, session_id: 9 },
        ],
      );
      assert.deepEqual(conn.prepare('SELECT title, session_id, done FROM plan_items').all(), [
        { title: 'Planned', session_id: 7, done: 1 },
      ]);
      assert.deepEqual(conn.prepare('SELECT title, mode FROM saved_timers').all(), [
        { title: 'Pinned before', mode: 'pomodoro' },
      ]);

      // The new table, its indexes and the new column are there, in the shape that was asked for.
      assert.deepEqual(names(conn, 'PRAGMA table_info(tasks)'), [
        'id',
        'project_id',
        'title',
        'priority',
        'status',
        'estimated_minutes',
        'added_on',
        'start_date',
        'target_date',
        'completed_on',
        'notes',
        'results',
        'position',
        'created_at',
        'updated_at',
      ]);
      const col = (table: string, name: string) =>
        (
          conn.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
            notnull: number;
            dflt_value: string | null;
          }[]
        ).find((c) => c.name === name);
      assert.equal(col('tasks', 'priority')?.dflt_value, "'medium'");
      assert.equal(col('tasks', 'status')?.dflt_value, "'not_started'");
      assert.equal(col('tasks', 'position')?.dflt_value, '0');
      assert.equal(col('tasks', 'title')?.notnull, 1);
      assert.equal(col('tasks', 'estimated_minutes')?.notnull, 0);
      assert.equal(col('sessions', 'task_id')?.notnull, 0);
      assert.equal(col('sessions', 'task_id')?.dflt_value, null);
      assert.deepEqual(
        names(conn, "SELECT name FROM pragma_index_info('tasks_status') ORDER BY seqno"),
        ['status', 'position'],
      );
      assert.deepEqual(names(conn, "SELECT name FROM pragma_index_info('tasks_project')"), [
        'project_id',
      ]);
      assert.deepEqual(names(conn, "SELECT name FROM pragma_index_info('sessions_task')"), [
        'task_id',
      ]);
      assert.equal(count(conn, 'tasks'), 0);

      // The new constraints bite.
      const add = conn.prepare(
        `INSERT INTO tasks (project_id, title, priority, status, estimated_minutes, added_on,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '2026-10-01', ?, ?)`,
      );
      assert.throws(() => add.run(null, 'x', 'urgent', 'not_started', null, stamp, stamp), /CHECK/);
      assert.throws(() => add.run(null, 'x', 'high', 'done', null, stamp, stamp), /CHECK/);
      assert.throws(() => add.run(null, 'x', 'high', 'not_started', 0, stamp, stamp), /CHECK/);
      assert.throws(() => add.run(null, 'x', 'high', 'not_started', 6001, stamp, stamp), /CHECK/);
      assert.throws(
        () => add.run(999, 'x', 'high', 'not_started', null, stamp, stamp),
        /FOREIGN KEY/,
      );
      assert.equal(count(conn, 'tasks'), 0);

      // A link to a task that is not there is refused, even though the column was added later.
      add.run(1, 'Real task', 'high', 'in_progress', 120, stamp, stamp);
      const taskId = (conn.prepare('SELECT id FROM tasks').get() as { id: number }).id;
      const link = conn.prepare('UPDATE sessions SET task_id = ? WHERE id = ?');
      assert.throws(() => link.run(999, 8), /FOREIGN KEY/);
      assert.equal(count(conn, 'sessions'), 3);

      // Deleting a task unlinks its blocks and loses none of them.
      link.run(taskId, 7);
      link.run(taskId, 8);
      assert.deepEqual(conn.prepare('SELECT id, task_id FROM sessions WHERE id IN (7, 8)').all(), [
        { id: 7, task_id: taskId },
        { id: 8, task_id: taskId },
      ]);
      conn.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      assert.deepEqual(
        conn
          .prepare(
            'SELECT id, task_id, active_seconds FROM sessions WHERE id IN (7, 8) ORDER BY id',
          )
          .all(),
        [
          { id: 7, task_id: null, active_seconds: 2700 },
          { id: 8, task_id: null, active_seconds: 1800 },
        ],
      );
      assert.equal(count(conn, 'sessions'), 3);

      // A deleted project leaves its tasks behind, with no project.
      add.run(1, 'Project task', 'medium', 'not_started', null, stamp, stamp);
      conn.prepare('DELETE FROM projects WHERE id = 1').run();
      assert.deepEqual(conn.prepare('SELECT title, project_id FROM tasks').all(), [
        { title: 'Project task', project_id: null },
      ]);

      // What the earlier migrations promised still holds: one live block, and a block can be a stopwatch.
      assert.throws(
        () =>
          addSession.run(
            10,
            null,
            'Second live',
            null,
            null,
            stamp,
            null,
            0,
            null,
            'running',
            stamp,
            stamp,
          ),
        /UNIQUE/,
      );
      assert.deepEqual(conn.pragma('foreign_key_check'), []);

      // One backup, taken before anything changed, from the database as migration 3 left it.
      const backups = backupsIn(dir);
      assert.equal(backups.length, 1, `got ${backups.join(', ')}`);
      assert.match(backups[0]!, /^focusdesk\.backup-before-4-/);
      const before = new Database(path.join(dir, backups[0]!), { readonly: true });
      try {
        assert.deepEqual(before.prepare('SELECT id FROM _migrations ORDER BY id').all(), [
          { id: 1 },
          { id: 2 },
          { id: 3 },
        ]);
        assert.deepEqual(names(before, "SELECT name FROM sqlite_master WHERE name = 'tasks'"), []);
        assert.ok(
          !(before.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
            (c) => c.name === 'task_id',
          ),
        );
        assert.equal(count(before, 'sessions'), 3);
      } finally {
        before.close();
      }

      // Already up to date: nothing pending, so nothing new to back up.
      runMigrations(conn, file);
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });

  it('applies as one unit, so a failure partway leaves the database as it was', async () => {
    const { runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      await databaseBefore(conn, 4, '2026-10-01T10:00:00.000Z');
      // The last statement of the migration collides with this, after the table and the new
      // column have already been made.
      conn.exec('CREATE INDEX sessions_task ON sessions(title)');

      assert.throws(() => runMigrations(conn, file), /index sessions_task already exists/);

      assert.deepEqual(names(conn, "SELECT name FROM sqlite_master WHERE name = 'tasks'"), []);
      assert.ok(
        !(conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
          (c) => c.name === 'task_id',
        ),
        'the added column must be rolled back with the rest',
      );
      assert.deepEqual(conn.prepare('SELECT id FROM _migrations ORDER BY id').all(), [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);
      // The backup came first, so the failure cost nothing.
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });

  it('builds the same schema on a fresh install', async () => {
    const { runMigrations, migrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('foreign_keys = ON');
    try {
      runMigrations(conn, file);
      assert.equal(count(conn, '_migrations'), migrations.length);
      assert.deepEqual(names(conn, "SELECT name FROM sqlite_master WHERE name = 'tasks'"), [
        'tasks',
      ]);
      const info = conn
        .prepare(
          `INSERT INTO sessions (title, started_at, local_day, status, task_id, created_at, updated_at)
           SELECT 'x', 'now', '2026-10-01', 'completed', NULL, 'now', 'now'`,
        )
        .run();
      assert.equal(info.changes, 1);
      // No backup on a fresh install: there was nothing to lose.
      assert.deepEqual(backupsIn(dir), []);
    } finally {
      conn.close();
    }
  });
});

after(() => {
  // The scratch database lives in a temp dir; the OS reclaims it.
});
