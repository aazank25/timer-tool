import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import type { TaskInput, TaskView } from '../src/lib/tasks.js';
import { weekStart } from '../src/lib/time.js';
import { freshDb } from './setup.js';

const dbMod = () => import('../src/db.js');
const settingsMod = () => import('../src/lib/settings.js');
const tasksMod = () => import('../src/lib/tasks.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Four Mondays in a row, so a test says which week a task is in and does not leave it to the
// day the suite runs on. The clock is stopped on the Wednesday of THIS_WEEK wherever it matters.
const TWO_WEEKS_BACK = '2026-09-28';
const LAST_WEEK = '2026-10-05';
const THIS_WEEK = '2026-10-12';
const NEXT_WEEK = '2026-10-19';
const WEDNESDAY = '2026-10-14T12:00:00.000Z';

/** A clean database, with the user's day pinned to UTC and rolling over at 04:00. */
async function reset() {
  await freshDb();
  const { setSettings } = await settingsMod();
  setSettings({ timezone: 'UTC', day_start_hour: 4 });
}

/** Stop the wall clock at an instant, so "today" is exact. */
function freeze(iso: string) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}
const advance = (ms: number) => mock.timers.tick(ms);

async function task(title: string, rest: Partial<TaskInput> = {}) {
  const { createTask } = await tasksMod();
  return createTask({ title, ...rest });
}

async function reread(id: number): Promise<TaskView> {
  const { getTask } = await tasksMod();
  return getTask(id);
}

/** The titles of the tasks in a week and priority band, in the order the list shows them. */
async function band(weekOf: string, priority: 'high' | 'medium' | 'low') {
  const { listTasks } = await tasksMod();
  return listTasks({ view: 'all' })
    .filter((t) => t.weekOf === weekOf && t.priority === priority)
    .map((t) => t.title);
}

/** Every title, in the order the list shows them. */
async function everyTitle() {
  const { listTasks } = await tasksMod();
  return listTasks({ view: 'all' }).map((t) => t.title);
}

/** Every task row exactly as stored, every column, so "untouched" means all of it. */
async function snapshot() {
  const { db } = await dbMod();
  return db.prepare('SELECT * FROM tasks ORDER BY id').all();
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

/**
 * The tasks the carry-over tests start from, with the clock on the Wednesday of THIS_WEEK. They
 * are made oldest week first, so that what is carried has LOWER positions than what is already in
 * this week: carried tasks that merely kept their place would land above the ones that were
 * there. Two of the weeks have a task that is done, which must stay where it is.
 */
async function aFewWeeks() {
  const made: Record<string, TaskView> = {};
  const add = async (title: string, weekOf: string, rest: Partial<TaskInput> = {}) => {
    made[title] = await task(title, { weekOf, addedOn: weekOf, ...rest });
  };
  await add('Old high 1', TWO_WEEKS_BACK, { priority: 'high' });
  await add('Last high', LAST_WEEK, { priority: 'high' });
  await add('Old high 2', TWO_WEEKS_BACK, { priority: 'high' });
  await add('Old medium', TWO_WEEKS_BACK, { status: 'in_progress' });
  await add('Last medium', LAST_WEEK);
  await add('Old low', TWO_WEEKS_BACK, { priority: 'low', status: 'held_up' });
  await add('Old done', TWO_WEEKS_BACK, { status: 'completed' });
  await add('Last done', LAST_WEEK, { status: 'completed', priority: 'high' });
  await add('This high', THIS_WEEK, { priority: 'high' });
  await add('This medium', THIS_WEEK);
  await add('Next medium', NEXT_WEEK);
  return made;
}

/* ------------------------------------------------------------- migration 6 */

describe('migration 6 on an existing database', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-weeks-migrate-'));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const backupsIn = (where: string) =>
    fs.readdirSync(where).filter((f) => /^focusdesk\.backup-before-\d+-.+\.sqlite$/.test(f));

  /** Day added, and the Monday it has to be filed under. A Sunday belongs to the week before it. */
  const CASES: [string, string][] = [
    ['2026-10-05', '2026-10-05'], // a Monday is its own week
    ['2026-10-06', '2026-10-05'],
    ['2026-10-07', '2026-10-05'],
    ['2026-10-11', '2026-10-05'], // the Sunday that closes it
    ['2026-10-12', '2026-10-12'],
    ['2027-01-01', '2026-12-28'], // across the new year
    ['2028-02-29', '2028-02-28'], // a leap day
    ['2026-03-01', '2026-02-23'], // a Sunday, on the first of the month
    ['2026-02-28', '2026-02-23'], // and the Saturday before it
  ];

  it('files every task under the Monday of the week it was added, and keeps every row', async () => {
    const { runMigrations, migrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      const stamp = '2026-10-01T10:00:00.000Z';
      await databaseBefore(conn, 6, stamp);
      conn
        .prepare(
          `INSERT INTO projects (id, name, color, created_at, updated_at)
           VALUES (1, 'ROI Dashboard', '#0ea5e9', ?, ?)`,
        )
        .run(stamp, stamp);
      const add = conn.prepare(
        `INSERT INTO tasks (id, project_id, title, priority, status, estimated_minutes, added_on,
           start_date, target_date, completed_on, notes, results, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      CASES.forEach(([addedOn], i) => {
        // Every kind of row: open and done, a project and none, notes, an estimate, odd positions.
        const done = i % 3 === 2;
        add.run(
          i + 1,
          i % 2 === 0 ? 1 : null,
          `Added ${addedOn}`,
          (['high', 'medium', 'low'] as const)[i % 3],
          done ? 'completed' : 'in_progress',
          i % 2 === 0 ? 90 : null,
          addedOn,
          '2026-10-02',
          '2026-10-30',
          done ? '2026-10-08' : null,
          `Notes ${i}`,
          done ? 'Shipped' : null,
          i * 7,
          stamp,
          stamp,
        );
      });
      conn
        .prepare(
          `INSERT INTO sessions (id, task_id, title, started_at, ended_at, local_day, active_seconds,
             status, created_at, updated_at)
           VALUES (50, 1, 'Logged on the first', ?, ?, '2026-10-05', 1800, 'completed', ?, ?)`,
        )
        .run(stamp, stamp, stamp, stamp);
      const before = conn.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      assert.equal(before.length, CASES.length);
      assert.ok(!('week_of' in before[0]!), 'precondition: the column is not there yet');
      assert.ok(!('carried_from' in before[0]!), 'precondition: nor is the one for carrying');

      runMigrations(conn, file);

      assert.deepEqual(
        conn.prepare('SELECT id, name FROM _migrations ORDER BY id').all(),
        migrations.map((m) => ({ id: m.id, name: m.name })),
      );
      assert.equal(migrations.find((m) => m.id === 6)?.name, 'task weeks');

      // Every row is still there, and every column of it but the new one is as it was.
      const after = conn.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      assert.equal(after.length, CASES.length);
      assert.deepEqual(
        after.map(({ week_of: _week, carried_from: _carried, ...rest }) => rest),
        before,
      );
      // And each is filed under the Monday of the day it was added.
      assert.deepEqual(
        after.map((r) => [r.added_on, r.week_of]),
        CASES,
      );
      // Nothing has been carried yet, whatever week each was added in: the column starts empty.
      assert.deepEqual(
        after.map((r) => r.carried_from),
        CASES.map(() => null),
      );
      // By the rule weekStart has, which the rest of the app goes by.
      for (const r of after) assert.equal(r.week_of, weekStart(r.added_on as string));
      // What was logged on a task is still on it.
      assert.deepEqual(conn.prepare('SELECT id, task_id, active_seconds FROM sessions').all(), [
        { id: 50, task_id: 1, active_seconds: 1800 },
      ]);

      // The index the list is ordered by, in the order it is ordered by.
      assert.deepEqual(
        conn.prepare("SELECT name FROM pragma_index_info('tasks_week') ORDER BY seqno").all(),
        [{ name: 'week_of' }, { name: 'priority' }, { name: 'position' }],
      );
      assert.deepEqual(conn.pragma('foreign_key_check'), []);

      // One backup, taken before anything changed, from the database as migration 5 left it.
      const backups = backupsIn(dir);
      assert.equal(backups.length, 1, `got ${backups.join(', ')}`);
      assert.match(backups[0]!, /^focusdesk\.backup-before-6-/);
      const old = new Database(path.join(dir, backups[0]!), { readonly: true });
      try {
        assert.ok(
          !(old.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).some(
            (c) => c.name === 'week_of',
          ),
        );
        assert.equal((old.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, CASES.length);
      } finally {
        old.close();
      }

      // Already up to date: nothing pending, so nothing new to back up or backfill.
      runMigrations(conn, file);
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });

  it('applies as one unit, so a failure partway leaves every task as it was', async () => {
    const { runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      const stamp = '2026-10-01T10:00:00.000Z';
      await databaseBefore(conn, 6, stamp);
      conn
        .prepare(
          `INSERT INTO tasks (title, added_on, created_at, updated_at)
           VALUES ('Existing', '2026-10-07', ?, ?)`,
        )
        .run(stamp, stamp);
      // The last statement of the migration collides with this, after the column has been added
      // and every task backfilled.
      conn.exec('CREATE INDEX tasks_week ON tasks(title)');

      assert.throws(() => runMigrations(conn, file), /index tasks_week already exists/);

      const columns = (conn.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      assert.ok(!columns.includes('week_of'), 'the added column must be rolled back with the rest');
      assert.ok(!columns.includes('carried_from'), 'and so must the one added beside it');
      assert.deepEqual(conn.prepare('SELECT id FROM _migrations WHERE id >= 6').all(), []);
      assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });
});

/* ---------------------------------------------------------- creating a task */

describe('the week a new task is filed under', () => {
  beforeEach(reset);
  afterEach(() => mock.timers.reset());

  it('is the Monday of the day it was added', async () => {
    const cases: [string, string][] = [
      ['2026-10-05', '2026-10-05'],
      ['2026-10-08', '2026-10-05'],
      ['2026-10-11', '2026-10-05'], // a Sunday still belongs to the week before it
      ['2026-10-12', '2026-10-12'],
      ['2027-01-01', '2026-12-28'],
    ];
    for (const [addedOn, weekOf] of cases) {
      const t = await task(`Added ${addedOn}`, { addedOn });
      assert.equal(t.addedOn, addedOn);
      assert.equal(t.weekOf, weekOf, addedOn);
      assert.equal(t.carriedFrom, null, addedOn);
    }
  });

  it('is the week of today when no day is given', async () => {
    freeze(WEDNESDAY);
    const t = await task('Added today');
    assert.equal(t.addedOn, '2026-10-14');
    assert.equal(t.weekOf, THIS_WEEK);
  });

  it('is the week it is given instead, whatever day it was added', async () => {
    const later = await task('Filed ahead', { addedOn: '2026-10-07', weekOf: NEXT_WEEK });
    assert.equal(later.addedOn, '2026-10-07');
    assert.equal(later.weekOf, NEXT_WEEK);
    // Filed under a week it was not added in is not the same as carried into it: only the
    // carry-over makes a task a carried one.
    assert.equal(later.carriedFrom, null);

    const earlier = await task('Filed back', { addedOn: '2026-10-14', weekOf: TWO_WEEKS_BACK });
    assert.equal(earlier.weekOf, TWO_WEEKS_BACK);
    assert.equal(earlier.carriedFrom, null);

    // A week given with no day added: the day is still today, and the week is the one given.
    freeze(WEDNESDAY);
    const bare = await task('Only a week', { weekOf: LAST_WEEK });
    assert.equal(bare.addedOn, '2026-10-14');
    assert.equal(bare.weekOf, LAST_WEEK);
  });

  it("is the Monday of any day it is given as the week, on the way in and in an edit", async () => {
    const { updateTask } = await tasksMod();
    // Every day of the week of the 12th, and a Sunday that closes the one before it.
    const week = Array.from({ length: 7 }, (_, i) => `2026-10-${String(12 + i).padStart(2, '0')}`);
    for (const day of ['2026-10-11', ...week]) {
      const expected = day === '2026-10-11' ? LAST_WEEK : THIS_WEEK;
      assert.equal((await task(`Made for ${day}`, { weekOf: day })).weekOf, expected, `made ${day}`);
      const t = await task(`Edited to ${day}`, { weekOf: NEXT_WEEK });
      assert.equal(updateTask(t.id, { weekOf: day }).weekOf, expected, `edited ${day}`);
    }
    // Across a new year, and on a leap day.
    assert.equal((await task('New year', { weekOf: '2027-01-03' })).weekOf, '2026-12-28');
    assert.equal((await task('Leap day', { weekOf: '2028-02-29' })).weekOf, '2028-02-28');
  });
});

/* ------------------------------------------------------------ editing a task */

describe('editing the week of a task', () => {
  beforeEach(reset);

  const order = async () => everyTitle();
  const positions = async () => {
    const { listTasks } = await tasksMod();
    return listTasks({ view: 'all' }).map((t) => [t.title, t.position]);
  };

  it('keeps the week and the place of a task whose day added is edited, even into another week', async () => {
    const { updateTask } = await tasksMod();
    await task('X', { weekOf: THIS_WEEK });
    await task('A', { weekOf: LAST_WEEK });
    const b = await task('B', { weekOf: LAST_WEEK });
    await task('C', { weekOf: LAST_WEEK });
    const before = await positions();
    assert.deepEqual(await order(), ['X', 'A', 'B', 'C']);

    // Into the week it is in, a day later in the week it is in, and then two weeks away either way.
    for (const addedOn of ['2026-10-06', '2026-10-11', '2026-10-14', '2026-11-30', '2026-09-01']) {
      const edited = updateTask(b.id, { addedOn });
      assert.equal(edited.addedOn, addedOn);
      assert.equal(edited.weekOf, LAST_WEEK, `added ${addedOn}`);
    }
    assert.deepEqual(await positions(), before);
    assert.deepEqual(await order(), ['X', 'A', 'B', 'C']);
  });

  it('sends a task to the bottom of its new band when the week is edited', async () => {
    const { updateTask } = await tasksMod();
    const a = await task('A', { weekOf: LAST_WEEK });
    await task('B', { weekOf: LAST_WEEK });
    await task('H', { weekOf: THIS_WEEK, priority: 'high' });
    await task('X', { weekOf: THIS_WEEK });
    await task('Y', { weekOf: THIS_WEEK });
    await task('L', { weekOf: THIS_WEEK, priority: 'low' });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['X', 'Y']);

    // A was the first made, so a task that kept its place would head the band it joined.
    const moved = updateTask(a.id, { weekOf: THIS_WEEK });
    assert.equal(moved.weekOf, THIS_WEEK);
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['X', 'Y', 'A']);
    // Only its own band: the others in that week are as they were, and the one it left closed up.
    assert.deepEqual(await band(THIS_WEEK, 'high'), ['H']);
    assert.deepEqual(await band(THIS_WEEK, 'low'), ['L']);
    assert.deepEqual(await band(LAST_WEEK, 'medium'), ['B']);

    // To a week with no tasks in it at all, and back to the one it came from, behind B.
    assert.equal(updateTask(a.id, { weekOf: NEXT_WEEK }).weekOf, NEXT_WEEK);
    assert.deepEqual(await band(NEXT_WEEK, 'medium'), ['A']);
    updateTask(a.id, { weekOf: LAST_WEEK });
    assert.deepEqual(await band(LAST_WEEK, 'medium'), ['B', 'A']);
  });

  it('puts a task that changes week and priority together at the bottom of the band it lands in', async () => {
    const { updateTask } = await tasksMod();
    const a = await task('A', { weekOf: LAST_WEEK });
    await task('H1', { weekOf: THIS_WEEK, priority: 'high' });
    await task('H2', { weekOf: THIS_WEEK, priority: 'high' });
    const moved = updateTask(a.id, { weekOf: THIS_WEEK, priority: 'high' });
    assert.equal(moved.weekOf, THIS_WEEK);
    assert.equal(moved.priority, 'high');
    assert.deepEqual(await band(THIS_WEEK, 'high'), ['H1', 'H2', 'A']);
  });

  it('keeps its place when it is edited to the week it is already in, by any day of it', async () => {
    const { updateTask } = await tasksMod();
    const a = await task('A', { weekOf: THIS_WEEK });
    await task('B', { weekOf: THIS_WEEK });
    await task('C', { weekOf: THIS_WEEK });
    const before = await positions();
    updateTask(a.id, { weekOf: THIS_WEEK });
    updateTask(a.id, { weekOf: '2026-10-16' });
    updateTask(a.id, { weekOf: '2026-10-18' });
    assert.deepEqual(await positions(), before);
    assert.deepEqual(await order(), ['A', 'B', 'C']);
  });

  it('leaves the week alone when an edit does not mention it', async () => {
    const { updateTask } = await tasksMod();
    const t = await task('Carried by hand', { addedOn: '2026-10-07', weekOf: NEXT_WEEK });
    const edited = updateTask(t.id, { title: 'Renamed', status: 'in_progress', priority: 'high' });
    assert.equal(edited.weekOf, NEXT_WEEK);
    assert.equal(edited.addedOn, '2026-10-07');
  });
});

/* ---------------------------------------------------------------- carry over */

describe('carrying unfinished tasks into this week', () => {
  beforeEach(async () => {
    await reset();
    freeze(WEDNESDAY);
  });
  afterEach(() => mock.timers.reset());

  it('moves the open tasks of earlier weeks into this week, and nothing else', async () => {
    const { carryOverTasks } = await tasksMod();
    const made = await aFewWeeks();
    const untouched = ['Old done', 'Last done', 'This high', 'This medium', 'Next medium'];
    const row = async (title: string) => {
      const { db } = await dbMod();
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(made[title]!.id);
    };
    advance(MINUTE); // a later clock than they were made at, so a row that was written shows in updated_at
    const before = Object.fromEntries(await Promise.all(untouched.map(async (t) => [t, await row(t)])));

    const result = carryOverTasks();
    assert.deepEqual(result, { carried: 6, weekOf: THIS_WEEK });

    // Done tasks stay in the week they were finished in, this week's and next week's are as they
    // were: not one column of them changed.
    for (const title of untouched) assert.deepEqual(await row(title), before[title], title);
    assert.equal((await reread(made['Old done']!.id)).weekOf, TWO_WEEKS_BACK);
    assert.equal((await reread(made['Last done']!.id)).weekOf, LAST_WEEK);
    assert.equal((await reread(made['Next medium']!.id)).weekOf, NEXT_WEEK);

    // The six open ones are in this week now, whatever they were doing and whenever they were added.
    for (const title of ['Old high 1', 'Old high 2', 'Old medium', 'Old low', 'Last high', 'Last medium']) {
      const t = await reread(made[title]!.id);
      assert.equal(t.weekOf, THIS_WEEK, title);
      assert.equal(t.addedOn, made[title]!.addedOn, `${title} keeps the day it was added`);
      assert.equal(t.status, made[title]!.status, `${title} keeps its status`);
      assert.equal(t.priority, made[title]!.priority, `${title} keeps its priority`);
    }
  });

  it('puts them at the bottom of each band, below what was there, in the order the list had them in', async () => {
    const { carryOverTasks } = await tasksMod();
    await aFewWeeks();
    carryOverTasks();
    // This week's own task first in each band, then the carried ones: the NEWEST week first, as the
    // list shows the weeks, and inside a week the order they were in.
    assert.deepEqual(await band(THIS_WEEK, 'high'), [
      'This high',
      'Last high',
      'Old high 1',
      'Old high 2',
    ]);
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['This medium', 'Last medium', 'Old medium']);
    assert.deepEqual(await band(THIS_WEEK, 'low'), ['Old low']);
    // And the whole list: newest week first, so next week's, then this week's three bands, then
    // the two weeks that now hold only what is done.
    assert.deepEqual(await everyTitle(), [
      'Next medium',
      'This high',
      'Last high',
      'Old high 1',
      'Old high 2',
      'This medium',
      'Last medium',
      'Old medium',
      'Old low',
      'Last done',
      'Old done',
    ]);
  });

  it('leaves the carried tasks in the order they were listed in, which is what carrying a week at a time gives', async () => {
    const { carryOverTasks, listTasks } = await tasksMod();
    const PRIORITIES = ['high', 'medium', 'low'] as const;
    /** The titles of the given tasks of one priority, in the order they are listed in. */
    const ofPriority = (list: TaskView[], priority: string) =>
      list.filter((t) => t.priority === priority).map((t) => t.title);

    await aFewWeeks();
    // What the Tasks tab shows of the tasks that are about to move: the open ones in earlier weeks.
    const behind = listTasks().filter((t) => t.weekOf < THIS_WEEK);
    assert.equal(behind.length, 6);
    carryOverTasks();
    const moved = new Set(behind.map((t) => t.id));
    const after = listTasks().filter((t) => moved.has(t.id));
    for (const priority of PRIORITIES) {
      assert.deepEqual(ofPriority(after, priority), ofPriority(behind, priority), priority);
    }
    const onceBands = await Promise.all(PRIORITIES.map((p) => band(THIS_WEEK, p)));

    // The same tasks carried a week at a time, with the clock moved on a week between, make the
    // same bands: last week's own tasks come ahead of the ones that were carried into it.
    await reset();
    await aFewWeeks();
    freeze('2026-10-07T12:00:00.000Z'); // the Wednesday of the week of the 5th
    assert.deepEqual(carryOverTasks(), { carried: 4, weekOf: LAST_WEEK });
    freeze(WEDNESDAY);
    assert.deepEqual(carryOverTasks(), { carried: 6, weekOf: THIS_WEEK });
    assert.deepEqual(await Promise.all(PRIORITIES.map((p) => band(THIS_WEEK, p))), onceBands);
  });

  it('keeps the order a week had when the tasks in it were put in an order of their own', async () => {
    const { carryOverTasks, moveTask } = await tasksMod();
    const made = await aFewWeeks();
    // In the old week the second high task is dragged above the first.
    moveTask(made['Old high 2']!.id, { before: made['Old high 1']!.id });
    assert.deepEqual(await band(TWO_WEEKS_BACK, 'high'), ['Old high 2', 'Old high 1']);

    carryOverTasks();
    assert.deepEqual(await band(THIS_WEEK, 'high'), [
      'This high',
      'Last high',
      'Old high 2',
      'Old high 1',
    ]);
  });

  it('puts carried tasks below the ones already there even when their own positions were lower', async () => {
    const { carryOverTasks } = await tasksMod();
    const { db } = await dbMod();
    const made = await aFewWeeks();
    const position = (title: string) =>
      (db.prepare('SELECT position FROM tasks WHERE id = ?').get(made[title]!.id) as { position: number })
        .position;
    // Made first, so the carried tasks start with the lowest positions there are.
    assert.ok(position('Old medium') < position('This medium'));

    carryOverTasks();
    assert.ok(position('Last medium') > position('This medium'));
    // Carried newest week first, so last week's was given its number before the older one.
    assert.ok(position('Old medium') > position('Last medium'));
    // Past every position there was, not merely past the end of its own band.
    const others = ['This high', 'This medium', 'Next medium', 'Old done', 'Last done'];
    for (const other of others) assert.ok(position('Old low') > position(other), other);
  });

  it('carries nothing the second time, and writes nothing', async () => {
    const { carryOverTasks } = await tasksMod();
    await aFewWeeks();
    assert.equal(carryOverTasks().carried, 6);
    advance(MINUTE);
    const before = await snapshot();
    const order = await everyTitle();

    assert.deepEqual(carryOverTasks(), { carried: 0, weekOf: THIS_WEEK });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await everyTitle(), order);
  });

  it('carries nothing, and says which week, when there is nothing to carry', async () => {
    const { carryOverTasks } = await tasksMod();
    assert.deepEqual(carryOverTasks(), { carried: 0, weekOf: THIS_WEEK });
    // Only tasks that are done in earlier weeks, and open ones in this week and later.
    await task('Done last week', { weekOf: LAST_WEEK, status: 'completed' });
    await task('Open this week', { weekOf: THIS_WEEK });
    await task('Open next week', { weekOf: NEXT_WEEK });
    const before = await snapshot();
    assert.deepEqual(carryOverTasks(), { carried: 0, weekOf: THIS_WEEK });
    assert.deepEqual(await snapshot(), before);
  });

  it('carries a task that was completed and has been reopened, and not one completed since', async () => {
    const { carryOverTasks, updateTask } = await tasksMod();
    const a = await task('Reopened', { weekOf: LAST_WEEK, status: 'completed' });
    const b = await task('Finished in time', { weekOf: LAST_WEEK });
    updateTask(a.id, { status: 'held_up' });
    updateTask(b.id, { status: 'completed' });

    assert.equal(carryOverTasks().carried, 1);
    assert.equal((await reread(a.id)).weekOf, THIS_WEEK);
    assert.equal((await reread(b.id)).weekOf, LAST_WEEK);
  });

  it('goes by the week the user is in, which turns over at their day-start hour', async () => {
    const { carryOverTasks } = await tasksMod();
    await task('From two weeks back', { weekOf: TWO_WEEKS_BACK });
    await task('From last week', { weekOf: LAST_WEEK });

    // 02:00 UTC on Monday the 12th is still Sunday the 11th for someone whose day starts at 04:00,
    // so it is still the week of the 5th: only the older task is behind it.
    freeze('2026-10-12T02:00:00.000Z');
    assert.deepEqual(carryOverTasks(), { carried: 1, weekOf: LAST_WEEK });
    assert.deepEqual(await band(LAST_WEEK, 'medium'), ['From last week', 'From two weeks back']);

    // Three hours on, the 12th has begun, and the week with it.
    advance(3 * HOUR);
    assert.deepEqual(carryOverTasks(), { carried: 2, weekOf: THIS_WEEK });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['From last week', 'From two weeks back']);
  });

  it('carries all of them or none, whichever write fails', async () => {
    const { carryOverTasks } = await tasksMod();
    const { db } = await dbMod();
    const made = await aFewWeeks();
    advance(MINUTE);
    const before = await snapshot();

    // The last to be carried is the newest week's medium task, so five writes have gone through by
    // the time this one is refused, and only the transaction around them can take those back.
    db.exec(`CREATE TEMP TRIGGER tripwire BEFORE UPDATE OF week_of ON tasks
             WHEN NEW.id = ${made['Last medium']!.id} BEGIN SELECT RAISE(ABORT, 'tripwire'); END`);
    try {
      assert.throws(() => carryOverTasks(), /tripwire/);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS tripwire');
    }
    assert.deepEqual(await snapshot(), before);

    // Nothing is left in the way: with the trigger gone the same call carries them all.
    assert.equal(carryOverTasks().carried, 6);
  });
});

/* -------------------------------------------------------------- carriedFrom */

describe('where a task was carried from', () => {
  beforeEach(async () => {
    await reset();
    freeze(WEDNESDAY);
  });
  afterEach(() => mock.timers.reset());

  it('is empty for a task in the week it was added, whichever day of it', async () => {
    const t = await task('In its own week', { addedOn: '2026-10-08' });
    assert.equal(t.weekOf, LAST_WEEK);
    assert.equal(t.carriedFrom, null);
    assert.equal((await reread(t.id)).carriedFrom, null);
  });

  it('is the Monday of the week it was carried from once the carry-over has moved it', async () => {
    const { carryOverTasks, listTasks } = await tasksMod();
    const t = await task('Slipped', { addedOn: '2026-10-08' });
    assert.equal(carryOverTasks().carried, 1);

    const carried = await reread(t.id);
    assert.equal(carried.weekOf, THIS_WEEK);
    // The Monday of the week it left, not the day it was added.
    assert.equal(carried.addedOn, '2026-10-08');
    assert.equal(carried.carriedFrom, LAST_WEEK);
    // The list says the same.
    assert.equal(listTasks().find((x) => x.id === t.id)?.carriedFrom, LAST_WEEK);
  });

  it('stays the week it was first carried from, through every week it is carried after that', async () => {
    const { carryOverTasks } = await tasksMod();
    const t = await task('Slips twice', { weekOf: TWO_WEEKS_BACK, addedOn: '2026-09-29' });
    carryOverTasks();
    assert.equal((await reread(t.id)).carriedFrom, TWO_WEEKS_BACK);
    freeze('2026-10-21T12:00:00.000Z');
    carryOverTasks();
    const again = await reread(t.id);
    assert.equal(again.weekOf, NEXT_WEEK);
    assert.equal(again.carriedFrom, TWO_WEEKS_BACK);
  });

  it('is recorded, not worked out from the day added: a task filed under another week by hand was not carried', async () => {
    const { listTasks } = await tasksMod();
    // Added this week and filed under an earlier one, and the other way about: neither was carried
    // anywhere, though neither sits in the week of the day it was added.
    const back = await task('Filed back', { addedOn: '2026-10-14', weekOf: LAST_WEEK });
    const ahead = await task('Filed ahead', { addedOn: '2026-10-07', weekOf: NEXT_WEEK });
    for (const t of [back, ahead]) assert.equal((await reread(t.id)).carriedFrom, null, t.title);
    assert.deepEqual(
      listTasks({ view: 'all' }).map((t) => [t.title, t.carriedFrom]),
      [
        ['Filed ahead', null],
        ['Filed back', null],
      ],
    );
  });

  it('is kept when the day added of a task that was carried is corrected', async () => {
    const { carryOverTasks, updateTask } = await tasksMod();
    const t = await task('Slipped', { addedOn: '2026-10-08' });
    carryOverTasks();
    assert.equal((await reread(t.id)).carriedFrom, LAST_WEEK);

    // Into the week it now sits in, which used to make it look as if it had never been carried, and
    // into a day that is nowhere near: the day added is a record, carrying is a fact about weeks.
    for (const addedOn of ['2026-10-13', '2026-11-30', '2026-08-03']) {
      const fixed = updateTask(t.id, { addedOn });
      assert.equal(fixed.addedOn, addedOn);
      assert.equal(fixed.weekOf, THIS_WEEK);
      assert.equal(fixed.carriedFrom, LAST_WEEK, addedOn);
    }
  });

  it('goes when the task is filed under another week by hand, and not when it is filed under the week it is in', async () => {
    const { carryOverTasks, updateTask } = await tasksMod();
    const t = await task('Slipped', { addedOn: '2026-10-08' });
    carryOverTasks();
    assert.equal((await reread(t.id)).carriedFrom, LAST_WEEK);

    // The week it is already in, by any day of it, is no move, and says nothing new about it.
    assert.equal(updateTask(t.id, { weekOf: THIS_WEEK }).carriedFrom, LAST_WEEK);
    assert.equal(updateTask(t.id, { weekOf: '2026-10-16' }).carriedFrom, LAST_WEEK);
    // Edits that do not mention the week leave the mark alone as well.
    assert.equal(updateTask(t.id, { title: 'Renamed', priority: 'high' }).carriedFrom, LAST_WEEK);

    // Put back where it came from, or filed under any other week: that was done by hand.
    assert.equal(updateTask(t.id, { weekOf: LAST_WEEK }).carriedFrom, null);
    carryOverTasks();
    assert.equal((await reread(t.id)).carriedFrom, LAST_WEEK);
    const ahead = updateTask(t.id, { weekOf: NEXT_WEEK });
    assert.equal(ahead.weekOf, NEXT_WEEK);
    assert.equal(ahead.carriedFrom, null);
  });

  it('is the week it was in when it was carried, whatever put it there first', async () => {
    const { carryOverTasks, updateTask } = await tasksMod();
    // Added in one week, filed by hand under the next, and only then carried: it was carried
    // from the week it was filed under, which is not the one it was added in.
    const t = await task('Filed, then carried', { addedOn: '2026-09-29', weekOf: LAST_WEEK });
    assert.equal(t.carriedFrom, null);
    assert.equal(carryOverTasks().carried, 1);
    assert.equal((await reread(t.id)).carriedFrom, LAST_WEEK);

    // Moved by hand and carried again later: the mark began again with the move.
    updateTask(t.id, { weekOf: TWO_WEEKS_BACK });
    assert.equal((await reread(t.id)).carriedFrom, null);
    carryOverTasks();
    assert.equal((await reread(t.id)).carriedFrom, TWO_WEEKS_BACK);
  });

  it('is written only for the tasks the carry-over moves', async () => {
    const { carryOverTasks } = await tasksMod();
    const made = await aFewWeeks();
    carryOverTasks();
    const carriedFrom = async (title: string) => (await reread(made[title]!.id)).carriedFrom;
    assert.equal(await carriedFrom('Old high 1'), TWO_WEEKS_BACK);
    assert.equal(await carriedFrom('Old low'), TWO_WEEKS_BACK);
    assert.equal(await carriedFrom('Last high'), LAST_WEEK);
    assert.equal(await carriedFrom('Last medium'), LAST_WEEK);
    // Done, already in this week, or filed ahead: not moved, so not marked.
    for (const title of ['Old done', 'Last done', 'This high', 'This medium', 'Next medium']) {
      assert.equal(await carriedFrom(title), null, title);
    }
  });
});

/* ---------------------------------------------------- bands go by the stored week */

describe('the band of a carried task', () => {
  beforeEach(async () => {
    await reset();
    freeze(WEDNESDAY);
  });
  afterEach(() => mock.timers.reset());

  it('is the week it was carried into: it can be moved among that week and not among the one it left', async () => {
    const { carryOverTasks, moveTask } = await tasksMod();
    const x = await task('X', { weekOf: THIS_WEEK });
    const a = await task('A', { weekOf: LAST_WEEK });
    const b = await task('B', { weekOf: LAST_WEEK });
    // Left behind in the old week, in the same priority as the two that are carried out of it.
    const done = await task('Done', { weekOf: LAST_WEEK, status: 'completed' });
    carryOverTasks();
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['X', 'A', 'B']);

    // Beside the tasks that were always this week's: put B above X, then A below it again.
    moveTask(b.id, { before: x.id });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['B', 'X', 'A']);
    moveTask(a.id, { after: b.id });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['B', 'A', 'X']);

    // Not beside the one that stayed behind, which sits in another week, though it was added with them.
    const before = await snapshot();
    assert.throws(() => moveTask(a.id, { after: done.id }), {
      status: 400,
      message: /own week and priority/,
    });
    assert.throws(() => moveTask(done.id, { before: a.id }), { status: 400 });
    assert.deepEqual(await snapshot(), before);
  });

  it('is the stored week, not the week the task was added in', async () => {
    const { moveTask } = await tasksMod();
    // Added in the same week as `home`, and filed under another: they are not in one band.
    const home = await task('Home', { addedOn: '2026-10-14' });
    const away = await task('Away', { addedOn: '2026-10-15', weekOf: LAST_WEEK });
    assert.throws(() => moveTask(away.id, { before: home.id }), {
      status: 400,
      message: /own week and priority/,
    });
    // Added in different weeks and filed under one: they are, and can be put in either order.
    const early = await task('Added early', { addedOn: '2026-10-07', weekOf: THIS_WEEK });
    moveTask(early.id, { before: home.id });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['Added early', 'Home']);
    moveTask(early.id, { after: home.id });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['Home', 'Added early']);
  });

  it('numbers every task filed under the week in a move, whatever week each was added in', async () => {
    const { moveTask } = await tasksMod();
    // One band, made in this order, with the middle task added in an earlier week than the others.
    // A move that took the band to be the tasks added in the week would leave that one out and
    // number the other two around it, and the order that came out would differ from this one.
    const q = await task('Q', { addedOn: '2026-10-14' });
    await task('P', { addedOn: '2026-10-07', weekOf: THIS_WEEK });
    const s = await task('S', { addedOn: '2026-10-15' });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['Q', 'P', 'S']);

    moveTask(q.id, { after: s.id });
    assert.deepEqual(await band(THIS_WEEK, 'medium'), ['P', 'S', 'Q']);
    const { listTasks } = await tasksMod();
    assert.deepEqual(
      listTasks().map((t) => t.position),
      [0, 1, 2],
    );
  });

  it('numbers the whole band again when one of its tasks is moved, carried ones included', async () => {
    const { carryOverTasks, moveTask, listTasks } = await tasksMod();
    await task('X', { weekOf: THIS_WEEK });
    await task('Y', { weekOf: THIS_WEEK });
    const a = await task('A', { weekOf: LAST_WEEK });
    await task('B', { weekOf: LAST_WEEK });
    carryOverTasks();
    // Carried tasks have the highest numbers there are; a move brings the band back to 0..n-1.
    const y = listTasks().find((t) => t.title === 'Y')!;
    moveTask(a.id, { before: y.id });
    assert.deepEqual(
      listTasks({ view: 'all' })
        .filter((t) => t.weekOf === THIS_WEEK)
        .map((t) => [t.title, t.position]),
      [
        ['X', 0],
        ['A', 1],
        ['Y', 2],
        ['B', 3],
      ],
    );
  });
});

/* ------------------------------------------------------------ over the API */

describe('carrying over, over the API', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    freeze(WEDNESDAY);
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  it('answers with how many it carried and the week it carried them into', async () => {
    await aFewWeeks();
    const first = await api.call('POST', '/tasks/carry-over');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { carried: 6, weekOf: THIS_WEEK });

    const second = await api.call('POST', '/tasks/carry-over');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { carried: 0, weekOf: THIS_WEEK });
  });

  it('takes no body, and an empty one or a stray one is no different', async () => {
    await task('Old', { weekOf: LAST_WEEK });
    await task('Older', { weekOf: TWO_WEEKS_BACK });
    await task('Oldest', { weekOf: '2026-09-21' });
    assert.equal((await api.call('POST', '/tasks/carry-over', {})).body.carried, 3);
    await task('Old again', { weekOf: LAST_WEEK });
    // Nothing in a request can change what is carried: the tasks and today decide that.
    const stray = await api.call('POST', '/tasks/carry-over', { weekOf: NEXT_WEEK, ids: [1] });
    assert.deepEqual(stray.body, { carried: 1, weekOf: THIS_WEEK });
  });

  it('shows in the list as the weekOf and carriedFrom of each task', async () => {
    const made = await aFewWeeks();
    await api.call('POST', '/tasks/carry-over');
    const listed = (await api.call('GET', '/tasks?view=all')).body as TaskView[];
    const byTitle = new Map(listed.map((t) => [t.title, t]));
    assert.deepEqual(
      ['Old high 1', 'Last medium', 'This high', 'Old done', 'Next medium'].map((title) => {
        const t = byTitle.get(title)!;
        return [title, t.weekOf, t.carriedFrom];
      }),
      [
        ['Old high 1', THIS_WEEK, TWO_WEEKS_BACK],
        ['Last medium', THIS_WEEK, LAST_WEEK],
        ['This high', THIS_WEEK, null],
        ['Old done', TWO_WEEKS_BACK, null],
        ['Next medium', NEXT_WEEK, null],
      ],
    );
    assert.equal(byTitle.get('Old low')!.id, made['Old low']!.id);
  });

  it('says a task was carried once the carry-over has moved it, and stops when it is filed by hand', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Slipped', weekOf: LAST_WEEK })).body;
    assert.equal(t.carriedFrom, null);
    await api.call('POST', '/tasks/carry-over');
    const listed = (await api.call('GET', '/tasks')).body as TaskView[];
    assert.equal(listed.find((x) => x.id === t.id)?.carriedFrom, LAST_WEEK);

    // The day added is only a record; the week it sits in has not moved either.
    const corrected = await api.call('PATCH', `/tasks/${t.id}`, { addedOn: '2026-10-13' });
    assert.equal(corrected.body.carriedFrom, LAST_WEEK);
    // Saying the week it is in again is no move.
    const same = await api.call('PATCH', `/tasks/${t.id}`, { weekOf: '2026-10-15' });
    assert.equal(same.body.carriedFrom, LAST_WEEK);
    // A week of its own choosing is.
    const filed = await api.call('PATCH', `/tasks/${t.id}`, { weekOf: NEXT_WEEK });
    assert.equal(filed.body.weekOf, NEXT_WEEK);
    assert.equal(filed.body.carriedFrom, null);
  });

  it('files a task under the week it is created or edited into, taking any day to its Monday', async () => {
    const created = await api.call('POST', '/tasks', {
      title: 'Filed ahead',
      addedOn: '2026-10-08',
      weekOf: '2026-10-21',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.weekOf, NEXT_WEEK);
    assert.equal(created.body.addedOn, '2026-10-08');
    // Filed by hand, so not a carried one.
    assert.equal(created.body.carriedFrom, null);

    const moved = await api.call('PATCH', `/tasks/${created.body.id}`, { weekOf: '2026-10-14' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.weekOf, THIS_WEEK);

    // The day it was added is edited and moves nothing.
    const edited = await api.call('PATCH', `/tasks/${created.body.id}`, { addedOn: '2026-11-02' });
    assert.equal(edited.body.weekOf, THIS_WEEK);
    assert.equal(edited.body.addedOn, '2026-11-02');
  });

  it('refuses a week that is not a real day, on the way in and in an edit, and writes nothing', async () => {
    const t = (await api.call('POST', '/tasks', { title: 'Keep me', weekOf: LAST_WEEK })).body;
    const before = await snapshot();
    for (const bad of ['next week', '2026-10-5', '2026-02-30', '2026-13-01', '20261012', '', null, 5]) {
      assert.equal(await api.status('POST', '/tasks', { title: 'x', weekOf: bad }), 400, `POST ${bad}`);
      assert.equal(await api.status('PATCH', `/tasks/${t.id}`, { weekOf: bad }), 400, `PATCH ${bad}`);
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('is not shadowed by the routes that take a task id', async () => {
    // A POST to /tasks/carry-over is the carry-over, not a move or an edit of a task called that.
    const res = await api.call('POST', '/tasks/carry-over');
    assert.equal(res.status, 200);
    assert.ok('carried' in res.body && 'weekOf' in res.body);
    assert.equal(await api.status('PATCH', '/tasks/carry-over', { title: 'x' }), 400);
    assert.equal(await api.status('DELETE', '/tasks/carry-over'), 400);
  });
});
