import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import type { TaskInput } from '../src/lib/tasks.js';
import { weekStart as serverWeekStart } from '../src/lib/time.js';
import { freshDb } from './setup.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const tasksMod = () => import('../src/lib/tasks.js');
const statsMod = () => import('../src/lib/stats.js');
const settingsMod = () => import('../src/lib/settings.js');
const wrapupMod = () => import('../src/lib/wrapup.js');
const dbMod = () => import('../src/db.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A Monday, and the days around it, so no test leaves it to the day the suite runs on which
// week it is in. The week under test is Mon 12 to Sun 18 October, and the one before it starts
// on the 5th.
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';

/** A clean database, with the user's day pinned to UTC and rolling over at 04:00. */
async function reset() {
  const db = await freshDb();
  // freshDb leaves the wrap-up tables and the settings alone, and both outlive a test.
  db.exec(`DELETE FROM day_notes; DELETE FROM week_reviews;
           DELETE FROM settings WHERE key = 'wrapup_time';`);
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

interface BlockOptions {
  title?: string;
  projectId?: number | null;
  taskId?: number | null;
  rating?: number | null;
  kind?: 'focus' | 'break';
  status?: 'completed' | 'abandoned';
}

/** A finished block begun at an instant and worth exactly this many seconds, whatever the clock says. */
async function logBlock(at: string, seconds: number, opts: BlockOptions = {}) {
  freeze(at);
  const { startSession, stopSession } = await sessionsMod();
  const started = startSession({
    title: opts.title ?? 'Logged work',
    projectId: opts.projectId,
    taskId: opts.taskId,
    kind: opts.kind,
  });
  return stopSession(started.id, opts.status ?? 'completed', {
    activeSeconds: seconds,
    focusRating: opts.rating,
  });
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
    // Express answers a route that does not exist with a page of HTML, which is not JSON.
    const json = text && res.headers.get('content-type')?.includes('json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (json ? JSON.parse(text) : text || undefined) as any };
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

const titles = (list: { title: string }[]) => list.map((t) => t.title);

/*
 * The page's own rules are plain functions in plain files, and the web app has no test
 * runner of its own, so they are loaded here by their path. Nothing in them needs a
 * browser, and a path is not an import TypeScript follows, so the types are stated here.
 */
interface Weeks {
  realDay(value: string | null | undefined): string | null;
  weekStart(day: string): string;
  defaultWeek(today: string): string;
}
interface Summary {
  span(seconds: number): string;
  shortDate(day: string): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  daySummary(view: any, note: string | null): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  weekSummary(view: any, note: string | null): string;
}
interface Format {
  duration(seconds: number, opts?: { zero?: string }): string;
}
const webLib = (name: string) =>
  import(new URL(`../../web/src/lib/${name}.ts`, import.meta.url).href);
const weeksLib = () => webLib('weeks') as Promise<Weeks>;
const summaryLib = () => webLib('wrapupSummary') as Promise<Summary>;
const formatLib = () => webLib('format') as Promise<Format>;

/* ------------------------------------------------------------------ over HTTP */

describe('the wrap-up over the API', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });

  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const getDay = async (day: string) => {
    const res = await api.call('GET', `/wrapup/day?day=${day}`);
    assert.equal(res.status, 200);
    return res.body;
  };
  const getWeek = async (week: string) => {
    const res = await api.call('GET', `/wrapup/week?week=${week}`);
    assert.equal(res.status, 200);
    return res.body;
  };

  /* ------------------------------------------------------------------- day */

  describe('a day', () => {
    it('adds up the blocks stored for it, in total and per project', async () => {
      const roi = await makeProject('ROI Dashboard', '#2a78d6');
      const crew = await makeProject('Crew Ops', '#1baf7a');
      await logBlock(`${MON}T09:00:00.000Z`, 2700, {
        title: 'Competitor demo teardown',
        projectId: roi,
        rating: 4,
      });
      await logBlock(`${MON}T10:00:00.000Z`, 1800, {
        title: 'Tickets view',
        projectId: roi,
        rating: 5,
      });
      await logBlock(`${MON}T11:00:00.000Z`, 3600, {
        title: 'Crew queue',
        projectId: crew,
        rating: 3,
      });
      await logBlock(`${MON}T12:00:00.000Z`, 600, { title: 'Inbox' });
      // Neighbouring days are not this one.
      await logBlock('2026-10-11T14:00:00.000Z', 1200, { projectId: roi, rating: 1 });
      await logBlock(`${TUE}T09:00:00.000Z`, 900, { projectId: roi, rating: 1 });

      const view = await getDay(MON);
      assert.equal(view.day, MON);
      assert.equal(view.focusSeconds, 2700 + 1800 + 3600 + 600);
      assert.equal(view.blocks, 4);
      // Only the rated blocks are averaged: (4 + 5 + 3) / 3.
      assert.equal(view.avgFocusRating, 4);
      assert.deepEqual(
        view.byProject.map((p: { name: string; seconds: number; blocks: number }) => [
          p.name,
          p.seconds,
          p.blocks,
        ]),
        [
          ['ROI Dashboard', 4500, 2],
          ['Crew Ops', 3600, 1],
          ['Unassigned', 600, 1],
        ],
      );
      assert.deepEqual(view.byProject[0], {
        projectId: roi,
        name: 'ROI Dashboard',
        color: '#2a78d6',
        seconds: 4500,
        blocks: 2,
        // Ratings 4 and 5 of a stopwatch block: 85 and 100.
        avgFocusScore: 92.5,
        share: 51.7,
      });
      assert.deepEqual(
        view.sessions.map((s: { title: string; elapsedSeconds: number }) => [
          s.title,
          s.elapsedSeconds,
        ]),
        [
          ['Competitor demo teardown', 2700],
          ['Tickets view', 1800],
          ['Crew queue', 3600],
          ['Inbox', 600],
        ],
      );

      // The same figures the Today screen draws from the stored blocks, which is what they are
      // checked against: nothing here is on the clock, so the two must agree to the second.
      const { dayStats } = await statsMod();
      const stats = dayStats(MON);
      assert.equal(view.focusSeconds, stats.focusSeconds);
      assert.equal(view.blocks, stats.blocks);
      assert.equal(view.avgFocusRating, stats.avgFocusRating);
      assert.deepEqual(view.byProject, stats.byProject);
    });

    it('is empty, not an error, for a day with nothing on it', async () => {
      const view = await getDay('2026-10-10');
      assert.deepEqual(view, {
        day: '2026-10-10',
        focusSeconds: 0,
        blocks: 0,
        avgFocusRating: null,
        byProject: [],
        sessions: [],
        unrated: [],
        tasks: [],
        note: null,
        wrappedUpAt: null,
        previous: null,
      });
    });

    it('is the day the user is in when none is named, which is not always the UTC date', async () => {
      // 02:30 UTC is still the 12th for someone whose day starts at 04:00.
      freeze('2026-10-13T02:30:00.000Z');
      assert.equal((await api.call('GET', '/wrapup/day')).body.day, MON);
      freeze('2026-10-13T04:00:00.000Z');
      assert.equal((await api.call('GET', '/wrapup/day')).body.day, TUE);
    });

    it('counts a block still running by what the clock says, and only once', async () => {
      const roi = await makeProject('ROI Dashboard');
      await logBlock(`${MON}T09:00:00.000Z`, 1800, { projectId: roi, rating: 4 });
      advance(HOUR); // 10:00
      const { startSession, pauseSession, resumeSession, stopSession } = await sessionsMod();
      const { db } = await dbMod();
      const live = startSession({ title: 'Deep work', projectId: roi });
      advance(25 * MINUTE);

      let view = await getDay(MON);
      assert.equal(view.focusSeconds, 1800 + 1500);
      assert.equal(view.blocks, 2);
      assert.equal(view.byProject[0].seconds, 3300);
      const running = view.sessions.at(-1);
      assert.equal(running.id, live.id);
      assert.equal(running.status, 'running');
      assert.equal(running.elapsedSeconds, 1500);
      // It cannot be rated yet, so it is neither listed to rate nor averaged in.
      assert.deepEqual(view.unrated, []);
      assert.equal(view.avgFocusRating, 4);
      // The proof that the clock is what is read: the stored column, which the stats screens
      // add up, still says nothing at all for it.
      const stored = () =>
        (
          db.prepare('SELECT active_seconds AS s FROM sessions WHERE id = ?').get(live.id) as {
            s: number;
          }
        ).s;
      assert.equal(stored(), 0);

      // Paused, its time is flushed to the block: counted once, not twice, and a pause is not work.
      pauseSession(live.id);
      assert.equal(stored(), 1500);
      advance(HOUR);
      view = await getDay(MON);
      assert.equal(view.focusSeconds, 3300);
      assert.equal(view.blocks, 2);

      resumeSession(live.id);
      advance(5 * MINUTE);
      view = await getDay(MON);
      assert.equal(view.focusSeconds, 3600);

      // Finished, the same total, and now it is there to be rated.
      stopSession(live.id, 'completed');
      view = await getDay(MON);
      assert.equal(view.focusSeconds, 3600);
      assert.deepEqual(view.unrated, [live.id]);
    });

    it('leaves out discarded blocks and breaks', async () => {
      const roi = await makeProject('ROI Dashboard');
      const spare = await makeProject('Never finished');
      const kept = await logBlock(`${MON}T09:00:00.000Z`, 1800, { projectId: roi, rating: 4 });
      // Rated low, so an average that took them in would show it.
      await logBlock(`${MON}T10:00:00.000Z`, 900, {
        projectId: spare,
        rating: 1,
        status: 'abandoned',
      });
      await logBlock(`${MON}T11:00:00.000Z`, 600, { projectId: roi, rating: 2, kind: 'break' });

      const view = await getDay(MON);
      assert.equal(view.focusSeconds, 1800);
      assert.equal(view.blocks, 1);
      assert.equal(view.avgFocusRating, 4);
      assert.deepEqual(
        view.sessions.map((s: { id: number }) => s.id),
        [kept.id],
      );
      // The project that only has a discarded block on it is not on the page at all.
      assert.deepEqual(
        view.byProject.map((p: { name: string }) => p.name),
        ['ROI Dashboard'],
      );
      assert.equal(view.byProject[0].seconds, 1800);
    });

    it('lists only finished focus blocks that have no rating, oldest first', async () => {
      const first = await logBlock(`${MON}T09:00:00.000Z`, 1800, { title: 'First' });
      await logBlock(`${MON}T10:00:00.000Z`, 1800, { title: 'Rated', rating: 4 });
      const third = await logBlock(`${MON}T11:00:00.000Z`, 1200, { title: 'Third' });
      await logBlock(`${MON}T12:00:00.000Z`, 900, { title: 'Thrown away', status: 'abandoned' });
      await logBlock(`${MON}T13:00:00.000Z`, 600, { title: 'A rest', kind: 'break' });
      // Still on the clock: nothing to rate yet.
      freeze(`${MON}T14:00:00.000Z`);
      const { startSession } = await sessionsMod();
      startSession({ title: 'Still going' });
      advance(10 * MINUTE);

      assert.deepEqual((await getDay(MON)).unrated, [first.id, third.id]);

      // Rating one takes it off the list, through the same route the wrap-up uses.
      const res = await api.call('PATCH', `/sessions/${first.id}`, { focusRating: 3 });
      assert.equal(res.status, 200);
      const view = await getDay(MON);
      assert.deepEqual(view.unrated, [third.id]);
      assert.equal(view.avgFocusRating, 3.5);
    });

    it('lists the tasks worked on, with the time put on each today beside all that is logged', async () => {
      const roi = await makeProject('ROI Dashboard', '#2a78d6');
      const status = await task('Build the current status', {
        projectId: roi,
        estimatedMinutes: 180,
      });
      const errand = await task('Renew the domain');
      const yesterdayOnly = await task('Worked yesterday');
      const discardedOnly = await task('Only thrown away');
      await task('Never touched');

      // Yesterday's hour is logged on it but is not today's.
      await logBlock('2026-10-11T15:00:00.000Z', 3600, { taskId: status.id });
      await logBlock(`${MON}T09:00:00.000Z`, 1800, { taskId: status.id });
      await logBlock(`${MON}T10:00:00.000Z`, 900, { taskId: status.id });
      await logBlock(`${MON}T11:00:00.000Z`, 600, { taskId: errand.id });
      await logBlock('2026-10-11T16:00:00.000Z', 1200, { taskId: yesterdayOnly.id });
      // A discarded block and a rest are not work on a task.
      await logBlock(`${MON}T12:00:00.000Z`, 900, {
        taskId: discardedOnly.id,
        status: 'abandoned',
      });
      await logBlock(`${MON}T13:00:00.000Z`, 300, { taskId: yesterdayOnly.id, kind: 'break' });

      const view = await getDay(MON);
      assert.deepEqual(view.tasks, [
        {
          id: status.id,
          title: 'Build the current status',
          projectId: roi,
          projectName: 'ROI Dashboard',
          projectColor: '#2a78d6',
          status: 'in_progress',
          estimatedMinutes: 180,
          secondsToday: 2700,
          loggedSeconds: 3600 + 2700,
        },
        {
          id: errand.id,
          title: 'Renew the domain',
          projectId: null,
          projectName: null,
          projectColor: null,
          status: 'in_progress',
          estimatedMinutes: null,
          secondsToday: 600,
          loggedSeconds: 600,
        },
      ]);

      // A block on the clock is on its task both today and in all, and nowhere twice.
      freeze(`${MON}T14:00:00.000Z`);
      const { startSession } = await sessionsMod();
      startSession({ title: 'More errands', taskId: errand.id });
      advance(10 * MINUTE);
      const live = (await getDay(MON)).tasks.find((t: { id: number }) => t.id === errand.id);
      assert.equal(live.secondsToday, 1200);
      assert.equal(live.loggedSeconds, 1200);
    });

    it('puts the tasks in the order of the time put on them today, not of all that is logged on them', async () => {
      const bigHistory = await task('Long history');
      const fresh = await task('Fresh today');
      // Three hours yesterday and ten minutes today, against one hour today and nothing before: the
      // task with the longer history is ahead in all, and behind today.
      await logBlock('2026-10-11T12:00:00.000Z', 3 * 3600, { taskId: bigHistory.id });
      await logBlock(`${MON}T09:00:00.000Z`, 600, { taskId: bigHistory.id });
      await logBlock(`${MON}T10:00:00.000Z`, 3600, { taskId: fresh.id });

      const view = await getDay(MON);
      assert.deepEqual(titles(view.tasks), ['Fresh today', 'Long history']);
      assert.deepEqual(
        view.tasks.map((t: { secondsToday: number; loggedSeconds: number }) => [
          t.secondsToday,
          t.loggedSeconds,
        ]),
        [
          [3600, 3600],
          [600, 3 * 3600 + 600],
        ],
      );
    });

    it('shows the same average focus as Today does for a day with rated breaks and discarded blocks', async () => {
      const { dayStats } = await statsMod();
      await logBlock(`${MON}T09:00:00.000Z`, 1800, { title: 'Good', rating: 5 });
      await logBlock(`${MON}T10:00:00.000Z`, 1800, { title: 'Fine', rating: 3 });
      // Rated low, so an average that took them in would show it.
      await logBlock(`${MON}T11:00:00.000Z`, 600, { title: 'Rest', rating: 1, kind: 'break' });
      await logBlock(`${MON}T12:00:00.000Z`, 600, {
        title: 'Gone',
        rating: 1,
        status: 'abandoned',
      });

      const view = await getDay(MON);
      const today = dayStats(MON);
      assert.equal(view.avgFocusRating, 4);
      assert.equal(today.avgFocusRating, view.avgFocusRating);
      assert.equal(today.ratedBlocks, 2);
    });

    it('saves a note, trims it, and clears it with null or blank text', async () => {
      assert.equal((await getDay(MON)).note, null);

      const saved = await api.call('PUT', `/wrapup/day/${MON}`, {
        note: '  Ship the tickets view  ',
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.note, 'Ship the tickets view');
      // What comes back is the whole day, so the screen can draw from the reply.
      assert.equal(saved.body.day, MON);
      assert.deepEqual(saved.body.sessions, []);
      assert.equal((await getDay(MON)).note, 'Ship the tickets view');

      assert.equal((await api.call('PUT', `/wrapup/day/${MON}`, { note: null })).body.note, null);
      assert.equal((await getDay(MON)).note, null);

      await api.call('PUT', `/wrapup/day/${MON}`, { note: 'Something' });
      assert.equal((await api.call('PUT', `/wrapup/day/${MON}`, { note: '   ' })).body.note, null);
      await api.call('PUT', `/wrapup/day/${MON}`, { note: 'Something' });
      assert.equal((await api.call('PUT', `/wrapup/day/${MON}`, { note: '' })).body.note, null);
    });

    it('takes a note of 500 characters and refuses one of 501, leaving the saved one alone', async () => {
      const longest = 'x'.repeat(500);
      assert.equal((await api.call('PUT', `/wrapup/day/${MON}`, { note: longest })).status, 200);
      assert.equal((await getDay(MON)).note, longest);

      const tooLong = await api.call('PUT', `/wrapup/day/${MON}`, { note: 'y'.repeat(501) });
      assert.equal(tooLong.status, 400);
      assert.equal((await getDay(MON)).note, longest);

      // The limit is on the note as stored, so spaces round it do not count against it.
      assert.equal(
        (await api.call('PUT', `/wrapup/day/${MON}`, { note: `  ${longest}  ` })).status,
        200,
      );

      // A body that does not say what the note is must not be taken for a clear.
      assert.equal(await api.status('PUT', `/wrapup/day/${MON}`, {}), 400);
      assert.equal(await api.status('PUT', `/wrapup/day/${MON}`, { note: 42 }), 400);
      assert.equal(await api.status('PUT', `/wrapup/day/${MON}`), 400);
      assert.equal((await getDay(MON)).note, longest);
    });

    it('is wrapped up once, however many times it is pressed, and an edit to the note does not undo it', async () => {
      const { db } = await dbMod();
      const row = () =>
        db.prepare('SELECT * FROM day_notes WHERE day = ?').get(MON) as {
          note: string | null;
          wrapped_up_at: string | null;
          updated_at: string;
        };

      assert.equal((await getDay(MON)).wrappedUpAt, null);

      freeze(`${MON}T17:42:00.000Z`);
      const first = await api.call('POST', `/wrapup/day/${MON}/done`);
      assert.equal(first.status, 200);
      assert.equal(first.body.wrappedUpAt, `${MON}T17:42:00.000Z`);
      assert.equal(first.body.note, null);
      const stamped = row();

      // Again, later: the first stamp is the one that stays, and nothing about the row moves.
      advance(30 * MINUTE);
      const again = await api.call('POST', `/wrapup/day/${MON}/done`);
      assert.equal(again.body.wrappedUpAt, `${MON}T17:42:00.000Z`);
      assert.deepEqual(row(), stamped);

      // Writing the note afterwards leaves it wrapped up...
      const edited = await api.call('PUT', `/wrapup/day/${MON}`, { note: 'First thing: the memo' });
      assert.equal(edited.body.wrappedUpAt, `${MON}T17:42:00.000Z`);
      assert.equal(edited.body.note, 'First thing: the memo');
      // ...and so does clearing it.
      const cleared = await api.call('PUT', `/wrapup/day/${MON}`, { note: null });
      assert.equal(cleared.body.wrappedUpAt, `${MON}T17:42:00.000Z`);
      assert.equal(cleared.body.note, null);

      // The other order: a note first, then done, keeps the note.
      await api.call('PUT', `/wrapup/day/${TUE}`, { note: 'Plan the week' });
      const done = await api.call('POST', `/wrapup/day/${TUE}/done`);
      assert.equal(done.body.note, 'Plan the week');
      assert.notEqual(done.body.wrappedUpAt, null);
      assert.equal((await getDay(MON)).wrappedUpAt, `${MON}T17:42:00.000Z`);
    });

    it('opens with the latest earlier note, skipping days that have none', async () => {
      const put = (day: string, note: string | null) =>
        api.call('PUT', `/wrapup/day/${day}`, { note });
      await put('2026-10-07', 'The plan from Wednesday');
      await put('2026-10-08', 'The plan from Thursday');
      // Wrapped up with nothing to say, and a note written and then cleared: rows, but no note.
      await api.call('POST', '/wrapup/day/2026-10-09/done');
      await put('2026-10-10', 'Changed my mind');
      await put('2026-10-10', null);
      // Later than the day asked about, so not before it.
      await put('2026-10-13', 'Tuesday looking ahead');

      assert.deepEqual((await getDay(MON)).previous, {
        day: '2026-10-08',
        note: 'The plan from Thursday',
      });
      // A day's own note is not its previous one.
      assert.deepEqual((await getDay('2026-10-08')).previous, {
        day: '2026-10-07',
        note: 'The plan from Wednesday',
      });
      assert.equal((await getDay('2026-10-07')).previous, null);
      assert.equal((await getDay('2026-09-01')).previous, null);

      // Once the day before has a note of its own, that is the one.
      assert.deepEqual((await getDay(TUE)).previous, {
        day: '2026-10-08',
        note: 'The plan from Thursday',
      });
      await put(MON, 'Monday looking ahead');
      assert.deepEqual((await getDay(TUE)).previous, { day: MON, note: 'Monday looking ahead' });
    });

    it('refuses a day that is not a real YYYY-MM-DD, and writes nothing for it', async () => {
      const { db } = await dbMod();
      for (const bad of [
        'yesterday',
        '2026-1-5',
        '20261012',
        '2026-13-01',
        '2026-02-30',
        '2026-10-32',
        '2026-10-12T10:00:00Z',
        '',
      ]) {
        assert.equal(
          await api.status('GET', `/wrapup/day?day=${encodeURIComponent(bad)}`),
          400,
          bad,
        );
      }
      assert.equal(await api.status('GET', '/wrapup/day?day=2026-10-12&day=2026-10-13'), 400);

      for (const bad of ['not-a-day', '2026-02-30', '2026-13-01']) {
        assert.equal(await api.status('PUT', `/wrapup/day/${bad}`, { note: 'x' }), 400, bad);
        assert.equal(await api.status('POST', `/wrapup/day/${bad}/done`), 400, bad);
      }
      const rows = db.prepare('SELECT COUNT(*) AS n FROM day_notes').get() as { n: number };
      assert.equal(rows.n, 0);
    });
  });

  /* ------------------------------------------------------------------ week */

  describe('a week', () => {
    it('is named by its Monday, whichever day of it is asked about', async () => {
      for (const day of [MON, TUE, WED, '2026-10-17', '2026-10-18']) {
        const view = await getWeek(day);
        assert.equal(view.week, MON, day);
        assert.equal(view.from, MON, day);
        assert.equal(view.to, '2026-10-18', day);
      }
      // Sunday is the end of the week before it, not the start of the next.
      const before = await getWeek('2026-10-11');
      assert.deepEqual(
        [before.week, before.from, before.to],
        ['2026-10-05', '2026-10-05', '2026-10-11'],
      );
    });

    it('is this week when none is named, by the day the user is in', async () => {
      freeze('2026-10-14T12:00:00.000Z');
      assert.equal((await api.call('GET', '/wrapup/week')).body.week, MON);
      // 02:00 UTC on Monday is still Sunday for someone whose day starts at 04:00, so still last week.
      freeze('2026-10-12T02:00:00.000Z');
      assert.equal((await api.call('GET', '/wrapup/week')).body.week, '2026-10-05');
      freeze('2026-10-12T04:00:00.000Z');
      assert.equal((await api.call('GET', '/wrapup/week')).body.week, MON);
    });

    it('has seven days, Monday to Sunday, each there whether or not it had any work', async () => {
      const roi = await makeProject('ROI Dashboard');
      const crew = await makeProject('Crew Ops');
      await logBlock('2026-10-11T20:00:00.000Z', 5000, { projectId: roi }); // the Sunday before
      await logBlock(`${TUE}T09:00:00.000Z`, 1800, { projectId: roi, rating: 4 });
      await logBlock(`${TUE}T10:00:00.000Z`, 1800, { projectId: crew, rating: 5 });
      await logBlock('2026-10-15T09:00:00.000Z', 900, { projectId: crew });
      await logBlock('2026-10-15T10:00:00.000Z', 900, { projectId: crew, status: 'abandoned' });
      await logBlock('2026-10-19T09:00:00.000Z', 7000, { projectId: roi }); // the Monday after
      // On the clock on the Friday.
      freeze('2026-10-16T11:00:00.000Z');
      const { startSession } = await sessionsMod();
      startSession({ title: 'Friday push', projectId: roi });
      advance(20 * MINUTE);

      const view = await getWeek(WED);
      assert.deepEqual(
        view.days.map((d: { day: string }) => d.day),
        [MON, TUE, WED, '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'],
      );
      assert.deepEqual(
        view.days.map((d: { focusSeconds: number }) => d.focusSeconds),
        [0, 3600, 0, 900, 1200, 0, 0],
      );
      assert.deepEqual(
        view.days.map((d: { blocks: number }) => d.blocks),
        [0, 2, 0, 1, 1, 0, 0],
      );
      assert.equal(view.focusSeconds, 3600 + 900 + 1200);
      assert.equal(view.blocks, 4);
      assert.equal(view.activeDays, 3);
      // Rated 4 and 5; the others have no rating and the discarded one is not counted.
      assert.equal(view.avgFocusRating, 4.5);
      assert.deepEqual(
        view.byProject.map((p: { name: string; seconds: number; blocks: number }) => [
          p.name,
          p.seconds,
          p.blocks,
        ]),
        [
          ['ROI Dashboard', 3000, 2],
          ['Crew Ops', 2700, 2],
        ],
      );
    });

    it('puts a block on the day it felt like in a timezone that is not UTC, in the day and in the week', async () => {
      const { setSettings } = await settingsMod();
      setSettings({ timezone: 'America/New_York', day_start_hour: 4 });
      // October is EDT, four hours behind UTC. Each is the instant of the wall clock beside it, and
      // the day starts at 04:00, so what is begun before then is still the day before.
      await logBlock('2026-10-13T03:30:00.000Z', 1800, { title: 'Mon 23:30' }); // Monday 12th
      await logBlock('2026-10-13T07:30:00.000Z', 900, { title: 'Tue 03:30' }); // still Monday 12th
      await logBlock('2026-10-13T08:30:00.000Z', 600, { title: 'Tue 04:30' }); // Tuesday 13th
      await logBlock('2026-10-19T02:00:00.000Z', 1200, { title: 'Sun 22:00' }); // Sunday 18th
      await logBlock('2026-10-12T07:30:00.000Z', 300, { title: 'Mon 03:30' }); // Sunday 11th

      // The day: by the day it felt like, which is not the UTC date of when it began.
      const monday = await getDay(MON);
      assert.deepEqual(titles(monday.sessions), ['Mon 23:30', 'Tue 03:30']);
      assert.equal(monday.focusSeconds, 2700);
      assert.deepEqual(titles((await getDay(TUE)).sessions), ['Tue 04:30']);
      assert.deepEqual(titles((await getDay('2026-10-11')).sessions), ['Mon 03:30']);
      assert.deepEqual(titles((await getDay('2026-10-18')).sessions), ['Sun 22:00']);

      // The week: the same blocks in the same columns, and the Sunday evening block in the last
      // one although by the UTC date it began on the Monday after.
      const week = await getWeek(MON);
      assert.deepEqual(
        week.days.map((d: { day: string; focusSeconds: number; blocks: number }) => [
          d.day,
          d.focusSeconds,
          d.blocks,
        ]),
        [
          [MON, 2700, 2],
          [TUE, 600, 1],
          [WED, 0, 0],
          ['2026-10-15', 0, 0],
          ['2026-10-16', 0, 0],
          ['2026-10-17', 0, 0],
          ['2026-10-18', 1200, 1],
        ],
      );
      assert.equal(week.focusSeconds, 2700 + 600 + 1200);
      assert.equal(week.activeDays, 3);
      // The block of the Sunday 11th is last week's, whichever UTC day it began on.
      const before = await getWeek('2026-10-05');
      assert.equal(before.days[6].focusSeconds, 300);
    });

    it('is a week of zeros, not an error, when nothing was done', async () => {
      const view = await getWeek('2026-08-03');
      // The shape other screens and reminders are written against, so a field is not lost quietly.
      assert.deepEqual(Object.keys(view).sort(), [
        'activeDays',
        'avgFocusRating',
        'blocks',
        'byProject',
        'completed',
        'days',
        'focusSeconds',
        'from',
        'note',
        'reviewedAt',
        'tasks',
        'to',
        'unfinished',
        'week',
      ]);
      assert.equal(view.days.length, 7);
      assert.ok(
        view.days.every(
          (d: { focusSeconds: number; blocks: number }) => d.focusSeconds === 0 && d.blocks === 0,
        ),
      );
      assert.deepEqual(
        [view.focusSeconds, view.blocks, view.activeDays, view.avgFocusRating],
        [0, 0, 0, null],
      );
      assert.deepEqual(
        [view.byProject, view.tasks, view.completed, view.unfinished],
        [[], [], [], []],
      );
      assert.deepEqual([view.note, view.reviewedAt], [null, null]);
    });

    it('sorts the tasks into worked on, completed and unfinished, by the task view', async () => {
      const roi = await makeProject('ROI Dashboard', '#2a78d6');
      // Worked on and finished within the week.
      const a = await task('A: shipped', {
        projectId: roi,
        status: 'completed',
        completedOn: '2026-10-14',
        addedOn: '2026-10-13',
      });
      // This week's sheet, in progress, the most time put on it.
      const b = await task('B: in flight', {
        projectId: roi,
        status: 'in_progress',
        estimatedMinutes: 120,
        addedOn: MON,
      });
      // Last week's sheet, but worked on this week.
      const c = await task('C: from last week', { status: 'in_progress', addedOn: '2026-10-07' });
      // This week's sheet, never touched.
      const d = await task('D: not started', { addedOn: '2026-10-15' });
      // Finished this week without a block on it, from last week's sheet.
      const e = await task('E: ticked off', {
        status: 'completed',
        completedOn: '2026-10-15',
        addedOn: '2026-10-07',
      });
      // Finished on the Sunday before, and on the Sunday that ends the week: one each side.
      await task('F: last Sunday', {
        status: 'completed',
        completedOn: '2026-10-11',
        addedOn: MON,
      });
      const h = await task('H: this Sunday', {
        status: 'completed',
        completedOn: '2026-10-18',
        addedOn: MON,
      });
      // Completed with no date to place it in a week.
      await task('G: no date', { status: 'completed', completedOn: null, addedOn: MON });
      // Added on the Sunday, which belongs to the week before it.
      const i = await task('I: Sunday sheet', { addedOn: '2026-10-11' });

      await logBlock(`${MON}T09:00:00.000Z`, 3600, { taskId: b.id });
      await logBlock('2026-10-13T09:00:00.000Z', 1800, { taskId: a.id });
      await logBlock('2026-10-15T09:00:00.000Z', 600, { taskId: b.id });
      await logBlock('2026-10-14T09:00:00.000Z', 900, { taskId: c.id });
      // Not work on a task, so these do not list one.
      await logBlock('2026-10-14T10:00:00.000Z', 900, { taskId: d.id, status: 'abandoned' });
      await logBlock('2026-10-14T11:00:00.000Z', 900, { taskId: d.id, kind: 'break' });
      // The week before's work is that week's.
      await logBlock('2026-10-08T09:00:00.000Z', 2400, { taskId: c.id });

      const view = await getWeek(MON);
      assert.deepEqual(titles(view.tasks), ['B: in flight', 'A: shipped', 'C: from last week']);
      assert.deepEqual(titles(view.completed), ['A: shipped', 'E: ticked off', 'H: this Sunday']);
      assert.deepEqual(titles(view.unfinished), ['B: in flight', 'D: not started']);

      assert.deepEqual(view.tasks[0], {
        id: b.id,
        title: 'B: in flight',
        projectName: 'ROI Dashboard',
        projectColor: '#2a78d6',
        status: 'in_progress',
        estimatedMinutes: 120,
        secondsThisWeek: 4200,
        loggedSeconds: 4200,
        completedOn: null,
      });
      // This week's share is not all that is logged on it.
      const lastWeeksTask = view.tasks[2];
      assert.equal(lastWeeksTask.id, c.id);
      assert.equal(lastWeeksTask.secondsThisWeek, 900);
      assert.equal(lastWeeksTask.loggedSeconds, 900 + 2400);
      assert.deepEqual(
        view.completed.map((t: { completedOn: string }) => t.completedOn),
        ['2026-10-14', '2026-10-15', '2026-10-18'],
      );
      // Listed for another reason than time: no time this week, and its own completion day.
      assert.deepEqual([view.completed[1].id, view.completed[1].secondsThisWeek], [e.id, 0]);
      assert.equal(view.completed[2].id, h.id);
      assert.equal(view.unfinished[1].secondsThisWeek, 0);

      // The week before holds the tasks whose sheet it was: the Sunday's, and C, which is
      // still open, but not E, which is done.
      const last = await getWeek('2026-10-05');
      assert.deepEqual(titles(last.unfinished), ['C: from last week', 'I: Sunday sheet']);
      assert.deepEqual(titles(last.completed), ['F: last Sunday']);
      assert.deepEqual(titles(last.tasks), ['C: from last week']);
      assert.equal(last.unfinished[1].id, i.id);

      // Whatever the Tasks tab says a task's week is, this is the answer it gives: the list is the
      // task view's own `weekOf` read back, not a second opinion worked out from the day added.
      const { listTasks } = await tasksMod();
      for (const week of [MON, '2026-10-05', '2026-09-28', '2026-10-19']) {
        const asked = await getWeek(week);
        const byView = listTasks({ view: 'all' })
          .filter((t) => t.status !== 'completed' && t.weekOf === week)
          .map((t) => t.id);
        assert.deepEqual(
          asked.unfinished.map((t: { id: number }) => t.id),
          byView,
          week,
        );
      }
    });

    it('lists a task that was carried under the week it was carried into, and not under the one it left', async () => {
      const slipped = await task('Slipped', { addedOn: '2026-10-07' }); // last week's sheet
      await task('This week own', { addedOn: MON });
      const LAST = '2026-10-05';
      assert.deepEqual(titles((await getWeek(LAST)).unfinished), ['Slipped']);
      assert.deepEqual(titles((await getWeek(MON)).unfinished), ['This week own']);

      freeze(`${WED}T12:00:00.000Z`);
      const carried = await api.call('POST', '/tasks/carry-over');
      assert.deepEqual(carried.body, { carried: 1, weekOf: MON });
      // Added in last week, and sitting in this one now: this one's, at the bottom of its band.
      assert.deepEqual(titles((await getWeek(LAST)).unfinished), []);
      assert.deepEqual(titles((await getWeek(MON)).unfinished), ['This week own', 'Slipped']);
      assert.equal((await getWeek(MON)).unfinished[1].id, slipped.id);

      // Filed under another week by hand, in an edit: the same, whichever week it was added in.
      const pushed = await task('Pushed', { addedOn: TUE });
      const back = await task('Filed back', { addedOn: WED });
      assert.equal(
        (await api.call('PATCH', `/tasks/${pushed.id}`, { weekOf: '2026-10-21' })).status,
        200,
      );
      assert.equal((await api.call('PATCH', `/tasks/${back.id}`, { weekOf: LAST })).status, 200);
      assert.deepEqual(titles((await getWeek(MON)).unfinished), ['This week own', 'Slipped']);
      assert.deepEqual(titles((await getWeek('2026-10-19')).unfinished), ['Pushed']);
      assert.deepEqual(titles((await getWeek(LAST)).unfinished), ['Filed back']);
    });

    it('does not list as completed a task that is open, whatever completion day it carries', async () => {
      const { updateTask } = await tasksMod();
      // The day can be typed in whatever the status is, so a day in the week does not make it done.
      await task('Open, with a day', { status: 'in_progress', completedOn: WED, addedOn: MON });
      const reopened = await task('Reopened', {
        status: 'completed',
        completedOn: WED,
        addedOn: MON,
      });
      updateTask(reopened.id, { status: 'held_up', completedOn: WED });
      await task('Really done', { status: 'completed', completedOn: WED, addedOn: MON });

      const view = await getWeek(MON);
      assert.deepEqual(titles(view.completed), ['Really done']);
      assert.deepEqual(titles(view.unfinished), ['Open, with a day', 'Reopened']);
      assert.equal(view.completed.length, 1);
    });

    it('keeps the week unfinished list in the order the tasks sheet shows it', async () => {
      await task('Low one', { priority: 'low', addedOn: MON });
      await task('High one', { priority: 'high', addedOn: MON });
      await task('Medium first', { addedOn: MON });
      await task('Medium second', { addedOn: MON });
      assert.deepEqual(titles((await getWeek(MON)).unfinished), [
        'High one',
        'Medium first',
        'Medium second',
        'Low one',
      ]);
    });

    it('saves a note and a reviewed stamp under the Monday, from any day of the week', async () => {
      freeze(`${WED}T09:30:00.000Z`);
      const saved = await api.call('PUT', `/wrapup/week/${WED}`, {
        note: '  Ship the dashboard  ',
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.week, MON);
      assert.equal(saved.body.note, 'Ship the dashboard');
      assert.equal(saved.body.reviewedAt, null);
      for (const day of [MON, '2026-10-17', '2026-10-18']) {
        assert.equal((await getWeek(day)).note, 'Ship the dashboard', day);
      }
      // The weeks either side are their own.
      assert.deepEqual(
        [(await getWeek('2026-10-05')).note, (await getWeek('2026-10-19')).note],
        [null, null],
      );

      const done = await api.call('POST', `/wrapup/week/2026-10-15/done`);
      assert.equal(done.status, 200);
      assert.equal(done.body.week, MON);
      assert.equal(done.body.reviewedAt, `${WED}T09:30:00.000Z`);
      assert.equal(done.body.note, 'Ship the dashboard');

      // Once, however often it is pressed, and whatever happens to the note afterwards.
      advance(HOUR);
      assert.equal(
        (await api.call('POST', `/wrapup/week/${MON}/done`)).body.reviewedAt,
        `${WED}T09:30:00.000Z`,
      );
      const cleared = await api.call('PUT', `/wrapup/week/${TUE}`, { note: null });
      assert.equal(cleared.body.note, null);
      assert.equal(cleared.body.reviewedAt, `${WED}T09:30:00.000Z`);
      assert.equal((await getWeek('2026-10-05')).reviewedAt, null);

      // The same limit as a day's note.
      assert.equal(
        (await api.call('PUT', `/wrapup/week/${MON}`, { note: 'x'.repeat(500) })).status,
        200,
      );
      assert.equal(await api.status('PUT', `/wrapup/week/${MON}`, { note: 'x'.repeat(501) }), 400);
      assert.equal(await api.status('PUT', `/wrapup/week/${MON}`, {}), 400);
      assert.equal((await getWeek(MON)).note, 'x'.repeat(500));
    });

    it('files a review marked from the Sunday that ends the week under that week, not the next', async () => {
      const { db } = await dbMod();
      const { isWeekReviewed } = await wrapupMod();
      const SUN = '2026-10-18';
      const NEXT = '2026-10-19';
      freeze(`${SUN}T20:00:00.000Z`);

      const done = await api.call('POST', `/wrapup/week/${SUN}/done`);
      assert.equal(done.status, 200);
      assert.equal(done.body.week, MON);
      assert.equal(done.body.reviewedAt, `${SUN}T20:00:00.000Z`);
      assert.equal((await getWeek(MON)).reviewedAt, `${SUN}T20:00:00.000Z`);
      assert.equal((await getWeek(NEXT)).reviewedAt, null);
      assert.equal(isWeekReviewed(SUN), true);
      assert.equal(isWeekReviewed(NEXT), false);

      // A note written on the Sunday is the same week's too, and the Monday after is its own.
      const note = await api.call('PUT', `/wrapup/week/${SUN}`, { note: 'From the Sunday' });
      assert.equal(note.body.week, MON);
      assert.equal((await getWeek(MON)).note, 'From the Sunday');
      assert.equal((await getWeek(NEXT)).note, null);
      assert.equal((await api.call('POST', `/wrapup/week/${NEXT}/done`)).body.week, NEXT);
      assert.deepEqual(db.prepare('SELECT week FROM week_reviews ORDER BY week').all(), [
        { week: MON },
        { week: NEXT },
      ]);
    });

    it('refuses a week that is not a real YYYY-MM-DD, and writes nothing for it', async () => {
      const { db } = await dbMod();
      for (const bad of ['last-week', '2026-02-30', '2026-W41', '10/12/2026', '']) {
        assert.equal(
          await api.status('GET', `/wrapup/week?week=${encodeURIComponent(bad)}`),
          400,
          bad,
        );
      }
      for (const bad of ['last-week', '2026-02-30']) {
        assert.equal(await api.status('PUT', `/wrapup/week/${bad}`, { note: 'x' }), 400, bad);
        assert.equal(await api.status('POST', `/wrapup/week/${bad}/done`), 400, bad);
      }
      const rows = db.prepare('SELECT COUNT(*) AS n FROM week_reviews').get() as { n: number };
      assert.equal(rows.n, 0);
    });
  });

  /* ------------------------------------------------------ the text it copies */

  describe('the summary the page copies', () => {
    it('lists the day by project with its blocks, the tasks it moved and the note for tomorrow', async () => {
      const { daySummary } = await summaryLib();
      const roi = await makeProject('ROI Dashboard');
      const crew = await makeProject('Crew Ops');
      const status = await task('Building the ROI Current Status', {
        projectId: roi,
        estimatedMinutes: 180,
      });
      const at = (time: string) => `${MON}T${time}:00.000Z`;
      await logBlock(at('09:00'), 45 * 60, {
        title: 'Competitor demo teardown',
        projectId: roi,
        rating: 4,
      });
      await logBlock(at('10:00'), 60 * 60, { title: 'Tickets view', taskId: status.id, rating: 4 });
      await logBlock(at('11:30'), 25 * 60, { title: 'Tickets view', taskId: status.id, rating: 3 });
      await logBlock(at('13:00'), 60 * 60, {
        title: 'Crew queue review',
        projectId: crew,
        rating: 5,
      });
      // Two sittings on one thing are one line of work, not two.
      await logBlock(at('14:30'), 40 * 60, { title: 'Inbox' });
      await logBlock(at('15:30'), 10 * 60, { title: 'Inbox' });

      assert.equal(
        daySummary(await getDay(MON), 'Ship the tickets view'),
        [
          'Mon Oct 12 — 4h focused, 6 blocks, focus 4/5',
          '• ROI Dashboard 2h 10m: Tickets view (1h 25m), Competitor demo teardown (45m)',
          '• Crew Ops 1h: Crew queue review (1h)',
          '• No project 50m: Inbox (50m)',
          'Tasks: Building the ROI Current Status — 1h 25m of 3h (in progress)',
          'Tomorrow: Ship the tickets view',
        ].join('\n'),
      );
    });

    it('counts a block still running, says "1 block", and leaves the rating off when there is none', async () => {
      const { daySummary } = await summaryLib();
      freeze(`${MON}T16:00:00.000Z`);
      const { startSession } = await sessionsMod();
      startSession({ title: 'Live work' });
      advance(20 * MINUTE);

      assert.equal(
        daySummary(await getDay(MON), null),
        ['Mon Oct 12 — 20m focused, 1 block', '• No project 20m: Live work (20m)'].join('\n'),
      );
    });

    it('says nothing was logged for an empty day, and still carries the note', async () => {
      const { daySummary } = await summaryLib();
      const empty = await getDay(MON);
      assert.equal(daySummary(empty, null), 'Mon Oct 12 — Nothing logged yet');
      assert.equal(
        daySummary(empty, 'Plan the week'),
        'Mon Oct 12 — Nothing logged yet\nTomorrow: Plan the week',
      );
    });

    it('says a task with nothing logged and no estimate by its status alone, and one with no estimate by what is logged', async () => {
      const { daySummary } = await summaryLib();
      const view = {
        day: MON,
        focusSeconds: 600,
        blocks: 1,
        avgFocusRating: null,
        byProject: [{ projectId: null, name: 'Unassigned', seconds: 600 }],
        sessions: [{ projectId: null, title: 'Admin', elapsedSeconds: 600 }],
        tasks: [
          {
            title: 'Renew the domain',
            status: 'completed',
            estimatedMinutes: null,
            loggedSeconds: 2400,
          },
          { title: 'Just started', status: 'held_up', estimatedMinutes: null, loggedSeconds: 0 },
          {
            title: 'Over budget',
            status: 'in_progress',
            estimatedMinutes: 60,
            loggedSeconds: 5400,
          },
        ],
      };
      assert.equal(
        daySummary(view, null).split('\n').at(-1),
        'Tasks: Renew the domain — 40m logged (completed); Just started (held up); Over budget — 1h 30m of 1h (in progress)',
      );
    });

    it('rounds the minutes before it splits them into hours, so it never says 1h 60m', async () => {
      const { span } = await summaryLib();
      assert.equal(span(7190), '2h');
      assert.equal(span(3599), '1h');
      assert.equal(span(3570), '1h');
      assert.equal(span(3569), '59m');
      assert.equal(span(5400), '1h 30m');
      assert.equal(span(45 * 60), '45m');
      assert.equal(span(59), '59s');
      assert.equal(span(0), '0m');
      assert.equal(span(-5), '0m');
    });

    it('writes the week: the time by project, what was worked on, finished and left open, and the note', async () => {
      const { weekSummary } = await summaryLib();
      const roi = await makeProject('ROI Dashboard');
      const done = await task('Tickets view', {
        projectId: roi,
        status: 'completed',
        completedOn: WED,
        addedOn: MON,
      });
      const flight = await task('ROI status page', {
        projectId: roi,
        status: 'in_progress',
        estimatedMinutes: 120,
        addedOn: MON,
      });
      await task('Pricing memo', { addedOn: MON });
      await logBlock(`${MON}T09:00:00.000Z`, 3600, { taskId: flight.id, rating: 4 });
      await logBlock(`${TUE}T09:00:00.000Z`, 1800, { taskId: done.id, rating: 5 });
      await logBlock('2026-10-15T09:00:00.000Z', 600, { taskId: flight.id });

      assert.equal(
        weekSummary(await getWeek(MON), 'Ship the dashboard'),
        [
          'Week of Mon Oct 12 — 1h 40m focused over 3 days, 3 blocks, focus 4.5/5',
          '• ROI Dashboard 1h 40m',
          'Worked on: ROI status page — 1h 10m this week, 1h 10m of 2h (in progress); Tickets view — 30m this week (completed)',
          'Completed: Tickets view (Wed)',
          'Unfinished: ROI status page — 1h 10m of 2h (in progress); Pricing memo (not started)',
          'Next week: Ship the dashboard',
        ].join('\n'),
      );
    });

    it('says nothing was logged for an empty week and leaves out the lines with nothing in them', async () => {
      const { weekSummary } = await summaryLib();
      const empty = await getWeek(MON);
      assert.equal(weekSummary(empty, null), 'Week of Mon Oct 12 — Nothing logged yet');
      assert.equal(
        weekSummary(empty, 'Start the audit'),
        'Week of Mon Oct 12 — Nothing logged yet\nNext week: Start the audit',
      );
    });
  });

  /* ------------------------------------------------------- what a reminder asks */

  describe('whether a day or a week has been closed out', () => {
    it('says so for a day only once it was wrapped up, a note alone is not enough', async () => {
      const { isDayWrappedUp } = await wrapupMod();
      assert.equal(isDayWrappedUp(MON), false);

      await api.call('PUT', `/wrapup/day/${MON}`, { note: 'Tomorrow: the memo' });
      assert.equal(isDayWrappedUp(MON), false);

      await api.call('POST', `/wrapup/day/${MON}/done`);
      assert.equal(isDayWrappedUp(MON), true);
      // Only that day.
      assert.equal(isDayWrappedUp(TUE), false);
      assert.equal(isDayWrappedUp('2026-10-11'), false);
      // Wrapped up without a note is wrapped up all the same.
      await api.call('POST', `/wrapup/day/${TUE}/done`);
      assert.equal(isDayWrappedUp(TUE), true);
    });

    it('says so for a week only once it was reviewed, and any day of the week will do', async () => {
      const { isWeekReviewed } = await wrapupMod();
      assert.equal(isWeekReviewed(MON), false);

      await api.call('PUT', `/wrapup/week/${MON}`, { note: 'Ship it' });
      assert.equal(isWeekReviewed(MON), false);

      await api.call('POST', `/wrapup/week/${WED}/done`);
      for (const day of [MON, TUE, WED, '2026-10-18']) assert.equal(isWeekReviewed(day), true, day);
      // The week before and the week after are not.
      assert.equal(isWeekReviewed('2026-10-11'), false);
      assert.equal(isWeekReviewed('2026-10-19'), false);
    });
  });

  /* --------------------------------------------------------------- the setting */

  describe('the wrap-up time setting', () => {
    const setTime = (value: unknown) => api.call('PATCH', '/settings', { wrapup_time: value });

    it('is half past five until it is changed', async () => {
      assert.equal((await api.call('GET', '/settings')).body.wrapup_time, '17:30');
    });

    it('takes a 24-hour HH:MM, or an empty string for off', async () => {
      for (const ok of ['09:05', '00:00', '23:59', '17:30', '12:00']) {
        const res = await setTime(ok);
        assert.equal(res.status, 200, ok);
        assert.equal(res.body.wrapup_time, ok);
        assert.equal((await api.call('GET', '/settings')).body.wrapup_time, ok);
      }
      const off = await setTime('');
      assert.equal(off.status, 200);
      assert.equal(off.body.wrapup_time, '');
      assert.equal((await api.call('GET', '/settings')).body.wrapup_time, '');
      // Off is a stored choice, not a missing one: it does not fall back to the default.
      const { getSetting } = await settingsMod();
      assert.equal(getSetting('wrapup_time'), '');
    });

    it('refuses anything else, and keeps what was there', async () => {
      await setTime('08:15');
      for (const bad of [
        '25:00',
        '24:00',
        '9:5',
        '9:05',
        '09:5',
        '12:60',
        '1730',
        '17.30',
        '17:30:00',
        ' 17:30',
        '5pm',
        'ab:cd',
        null,
        1730,
        true,
      ]) {
        assert.equal((await setTime(bad)).status, 400, String(bad));
      }
      assert.equal((await api.call('GET', '/settings')).body.wrapup_time, '08:15');
    });

    it('is changed on its own, the other settings are left as they are', async () => {
      const before = (await api.call('GET', '/settings')).body;
      await setTime('06:45');
      assert.deepEqual((await api.call('GET', '/settings')).body, {
        ...before,
        wrapup_time: '06:45',
      });
    });
  });
});

/* --------------------------------------------------------- how a length of time reads */

describe('how a length of time is written', () => {
  it('rounds to whole minutes before it splits them into hours, so nothing reads 60m', async () => {
    const { duration } = await formatLib();
    const cases: [number, string][] = [
      [7190, '2h'], // 1h 59m 50s
      [7199, '2h'],
      [7170, '2h'], // 1h 59m 30s: the half minute rounds up
      [7169, '1h 59m'],
      [7200, '2h'],
      [3600, '1h'],
      [3599, '1h'], // 59m 59s
      [3570, '1h'], // 59m 30s
      [3569, '59m'],
      [3540, '59m'],
      [3509, '58m'],
      [5400, '1h 30m'],
      [3660, '1h 1m'],
      [2700, '45m'],
      [90, '2m'],
      [89, '1m'],
      [60, '1m'],
      [59, '59s'],
      [1, '1s'],
      [59.6, '1m'], // rounds to a whole second first, and a whole second is a minute
      [0.4, '0m'],
      [0, '0m'],
      [-5, '0m'],
    ];
    for (const [seconds, text] of cases) assert.equal(duration(seconds), text, `${seconds} s`);

    // For every second of a day: never 60 minutes, and the minutes beside an hour are 1 to 59.
    for (let seconds = 0; seconds <= 86_400; seconds++) {
      const text = duration(seconds);
      assert.match(text, /^(\d+s|\d+m|\d+h|\d+h [1-9]\d?m)$/, `${seconds} s: ${text}`);
      assert.doesNotMatch(text, /(^|\D)60m/, `${seconds} s: ${text}`);
    }
  });

  it('uses the words it is given for no time at all, and only for that', async () => {
    const { duration } = await formatLib();
    assert.equal(duration(0, { zero: '—' }), '—');
    assert.equal(duration(0.4, { zero: '—' }), '—');
    assert.equal(duration(-1, { zero: '—' }), '—');
    assert.equal(duration(30, { zero: '—' }), '30s');
    assert.equal(duration(0), '0m');
  });

  it('is written the same in the summary as on every screen, for every second to a day and a bit', async () => {
    const { duration } = await formatLib();
    const { span } = await summaryLib();
    for (let seconds = 0; seconds <= 100_000; seconds++) {
      assert.equal(span(seconds), duration(seconds), `${seconds} s`);
    }
    // And the lengths that were wrong on the screens, in the summary's own words.
    assert.equal(span(7190), '2h');
    assert.equal(span(3570), '1h');
  });
});

/* ------------------------------------------------------- the review's week, on the page */

describe('the weeks the page works out for itself', () => {
  it('opens the review on last week on a Monday and a Tuesday, and on this week from Wednesday', async () => {
    const { defaultWeek } = await weeksLib();
    const cases: [string, string][] = [
      ['2026-10-12', '2026-10-05'], // Monday
      ['2026-10-13', '2026-10-05'], // Tuesday
      ['2026-10-14', '2026-10-12'], // Wednesday
      ['2026-10-15', '2026-10-12'],
      ['2026-10-16', '2026-10-12'],
      ['2026-10-17', '2026-10-12'],
      ['2026-10-18', '2026-10-12'], // Sunday
      ['2026-10-19', '2026-10-12'], // the next Monday looks back again
      ['2027-01-04', '2026-12-28'], // across the new year
      ['2027-01-05', '2026-12-28'],
      ['2027-01-06', '2027-01-04'],
    ];
    for (const [today, week] of cases) assert.equal(defaultWeek(today), week, today);
  });

  it('finds the Monday of a week as the server does, on every day for a year and more', async () => {
    const { weekStart } = await weeksLib();
    for (
      let t = Date.parse('2025-12-01T00:00:00Z');
      t <= Date.parse('2027-03-01T00:00:00Z');
      t += 24 * HOUR
    ) {
      const day = new Date(t).toISOString().slice(0, 10);
      assert.equal(weekStart(day), serverWeekStart(day), day);
    }
  });

  it('takes only a real YYYY-MM-DD from the address bar, and drops anything else', async () => {
    const { realDay } = await weeksLib();
    for (const ok of ['2026-10-12', '2024-02-29', '2026-12-31']) assert.equal(realDay(ok), ok);
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-10-12T10:00',
      '12-10-2026',
      'today',
      '',
      null,
      undefined,
    ]) {
      assert.equal(realDay(bad), null, String(bad));
    }
  });
});

/* ----------------------------------------------------------------- migration 7 */

describe('migration 7 on an existing database', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-wrapup-'));
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
  /** Every row of every table there is, as stored, so "kept every row" means all of them. */
  const everything = (conn: Database.Database) =>
    Object.fromEntries(
      names(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
        .filter((t) => t !== '_migrations')
        .sort()
        .map((t) => [t, conn.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
    );

  it('keeps every row, adds the two tables empty, and leaves a pre-migration backup', async () => {
    const { migrations, runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      // The database as it stood before wrap-ups shipped: every earlier migration, with history in it.
      const stamp = '2026-10-09T10:00:00.000Z';
      const end = '2026-10-09T10:45:00.000Z';
      await databaseBefore(conn, 7, stamp);
      conn
        .prepare(
          `INSERT INTO projects (id, name, color, created_at, updated_at)
           VALUES (1, 'ROI Dashboard', '#2a78d6', ?, ?)`,
        )
        .run(stamp, stamp);
      conn
        .prepare(
          `INSERT INTO tasks (id, project_id, title, priority, status, estimated_minutes, added_on,
             created_at, updated_at)
           VALUES (3, 1, 'Build the current status', 'high', 'in_progress', 180, '2026-10-05', ?, ?)`,
        )
        .run(stamp, stamp);
      conn
        .prepare(
          `INSERT INTO sessions (id, project_id, task_id, title, started_at, ended_at, local_day,
             active_seconds, focus_rating, status, created_at, updated_at)
           VALUES (7, 1, 3, 'Old block', ?, ?, '2026-10-09', 2700, 4, 'completed', ?, ?)`,
        )
        .run(stamp, end, stamp, stamp);
      conn
        .prepare(
          `INSERT INTO sessions (id, title, started_at, local_day, status, created_at, updated_at)
           VALUES (8, 'Still running', ?, '2026-10-09', 'running', ?, ?)`,
        )
        .run(stamp, stamp, stamp);
      conn
        .prepare(
          'INSERT INTO session_segments (id, session_id, started_at, ended_at) VALUES (11, 7, ?, ?)',
        )
        .run(stamp, end);
      conn
        .prepare('INSERT INTO session_segments (id, session_id, started_at) VALUES (12, 8, ?)')
        .run(stamp);
      conn
        .prepare("INSERT INTO settings (key, value) VALUES ('daily_target_minutes', '300')")
        .run();
      const before = everything(conn);
      assert.equal(count(conn, 'sessions'), 2);
      assert.deepEqual(names(conn, "SELECT name FROM sqlite_master WHERE name = 'day_notes'"), []);

      runMigrations(conn, file);

      // Applied, in order, as the last of the list.
      assert.deepEqual(
        conn.prepare('SELECT id, name FROM _migrations ORDER BY id').all(),
        migrations.map((m) => ({ id: m.id, name: m.name })),
      );
      assert.equal(
        (conn.prepare('SELECT name FROM _migrations WHERE id = 7').get() as { name: string }).name,
        'wrap-ups',
      );

      // Every old row is as it was, and the new tables are there. Migrations after 7 run
      // in the same call and may add tables of their own, so the check is that nothing
      // went missing and these two arrived, not that nothing else did.
      const after = everything(conn);
      for (const table of [...Object.keys(before), 'day_notes', 'week_reviews']) {
        assert.ok(table in after, `${table} is there after migrating`);
      }
      for (const table of Object.keys(before)) assert.deepEqual(after[table], before[table], table);
      assert.equal(count(conn, 'day_notes'), 0);
      assert.equal(count(conn, 'week_reviews'), 0);
      assert.deepEqual(names(conn, 'PRAGMA table_info(day_notes)'), [
        'day',
        'note',
        'wrapped_up_at',
        'updated_at',
      ]);
      assert.deepEqual(names(conn, 'PRAGMA table_info(week_reviews)'), [
        'week',
        'note',
        'reviewed_at',
        'updated_at',
      ]);

      // They behave: a day or a week is one row, and a row says when it was touched.
      const addDay = conn.prepare(
        'INSERT INTO day_notes (day, note, wrapped_up_at, updated_at) VALUES (?, ?, ?, ?)',
      );
      addDay.run('2026-10-12', 'Ship it', null, stamp);
      addDay.run('2026-10-13', null, stamp, stamp);
      assert.throws(() => addDay.run('2026-10-12', 'Again', null, stamp), /UNIQUE|PRIMARY KEY/);
      assert.throws(
        () => conn.prepare("INSERT INTO day_notes (day) VALUES ('2026-10-14')").run(),
        /NOT NULL/,
      );
      const addWeek = conn.prepare(
        'INSERT INTO week_reviews (week, note, reviewed_at, updated_at) VALUES (?, ?, ?, ?)',
      );
      addWeek.run('2026-10-12', 'Ship it', null, stamp);
      assert.throws(() => addWeek.run('2026-10-12', 'Again', null, stamp), /UNIQUE|PRIMARY KEY/);
      assert.throws(
        () => conn.prepare("INSERT INTO week_reviews (week) VALUES ('2026-10-19')").run(),
        /NOT NULL/,
      );
      assert.equal(count(conn, 'day_notes'), 2);
      assert.equal(count(conn, 'week_reviews'), 1);

      // What the earlier migrations promised still holds: one live block, and keys that bind.
      assert.throws(
        () =>
          conn
            .prepare(
              `INSERT INTO sessions (title, started_at, local_day, status, created_at, updated_at)
               VALUES ('Second live', ?, '2026-10-09', 'running', ?, ?)`,
            )
            .run(stamp, stamp, stamp),
        /UNIQUE/,
      );
      assert.deepEqual(conn.pragma('foreign_key_check'), []);

      // One backup, taken before anything changed, from the database as it stood.
      const backups = backupsIn(dir);
      assert.equal(backups.length, 1, `got ${backups.join(', ')}`);
      assert.match(backups[0]!, /^focusdesk\.backup-before-7-/);
      const old = new Database(path.join(dir, backups[0]!), { readonly: true });
      try {
        assert.deepEqual(
          old.prepare('SELECT id FROM _migrations ORDER BY id').all(),
          migrations.filter((m) => m.id < 7).map((m) => ({ id: m.id })),
        );
        assert.deepEqual(names(old, "SELECT name FROM sqlite_master WHERE name = 'day_notes'"), []);
        assert.deepEqual(everything(old), before);
      } finally {
        old.close();
      }

      // Already up to date: nothing pending, so nothing new to back up.
      runMigrations(conn, file);
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });

  it('builds the same two tables on a fresh install, with no backup to take', async () => {
    const { migrations, runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('foreign_keys = ON');
    try {
      runMigrations(conn, file);
      assert.equal(count(conn, '_migrations'), migrations.length);
      assert.deepEqual(
        names(
          conn,
          "SELECT name FROM sqlite_master WHERE name IN ('day_notes', 'week_reviews') ORDER BY name",
        ),
        ['day_notes', 'week_reviews'],
      );
      assert.deepEqual(backupsIn(dir), []);
    } finally {
      conn.close();
    }
  });
});
