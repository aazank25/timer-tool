import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { Prompt } from '../src/lib/prompts.js';
import type { StartInput } from '../src/lib/sessions.js';
import {
  addEvent,
  advance,
  at,
  type Api,
  DAY,
  freeze,
  goTo,
  MINUTE,
  reset,
  serve,
} from './prompt-helpers.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const promptsMod = () => import('../src/lib/prompts.js');
const settingsMod = () => import('../src/lib/settings.js');
const wrapupMod = () => import('../src/lib/wrapup.js');
const remindersMod = () => import('../src/lib/reminders.js');
const localTimeMod = () => import('../src/lib/local-time.js');
const dbMod = () => import('../src/db.js');

/** An instant on any day: on('2026-10-13', '09:00'). */
const on = (day: string, time: string) => `${day}T${time.length === 5 ? `${time}:00` : time}.000Z`;

/** What a prompt of this kind says right now. The others kinds are not what these tests are about. */
async function listed(kind: string): Promise<Prompt[]> {
  const { listPrompts } = await promptsMod();
  return listPrompts().filter((p) => p.kind === kind);
}
const wrapUps = () => listed('wrapup');
const reviews = () => listed('week-review');
const nudges = () => listed('idle');

async function set(patch: Record<string, string | number | boolean>) {
  (await settingsMod()).setSettings(patch);
}

/** A finished block as it would have been logged by hand: it starts at `from` and runs `minutes`. */
async function logged(
  from: string,
  minutes: number,
  rest: { kind?: 'focus' | 'break'; title?: string } = {},
) {
  const { logManualSession } = await sessionsMod();
  return logManualSession({ title: rest.title ?? 'Deep work', startedAt: from, minutes, ...rest });
}

/** Start a block on the frozen clock. */
async function startBlock(title = 'Deep work', rest: Partial<StartInput> = {}) {
  const { startSession } = await sessionsMod();
  return startSession({ title, ...rest });
}

async function savedState(key: string) {
  const { db } = await dbMod();
  const row = db.prepare('SELECT status, data FROM prompt_state WHERE key = ?').get(key) as
    | { status: string; data: string | null }
    | undefined;
  return row && { status: row.status, data: row.data ? JSON.parse(row.data) : null };
}

/** A clean slate: the shipped settings in UTC, nothing noted about any day or week, and a server that has been up for ever. */
async function fresh() {
  const db = await reset();
  db.exec('DELETE FROM day_notes; DELETE FROM week_reviews;');
  await set({ wrapup_time: '17:30' });
  (await remindersMod()).setServerStartedAt(0);
}

/** The way a person would see a plain day in the prompts: "Oct 5". */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/* ----------------------------------------------------- local times as instants */

describe('a time of day as minutes into the day', () => {
  it('counts from midnight, so times compare as the clock does', async () => {
    const { minutesOfDay } = await localTimeMod();
    assert.equal(minutesOfDay('00:00'), 0);
    assert.equal(minutesOfDay('00:01'), 1);
    assert.equal(minutesOfDay('03:59'), 239);
    assert.equal(minutesOfDay('04:00'), 240);
    assert.equal(minutesOfDay('17:30'), 1050);
    assert.equal(minutesOfDay('23:59'), 1439);
  });
});

describe('a time of day in a timezone, as an instant', () => {
  const instant = async (day: string, time: string, zone: string) =>
    new Date((await localTimeMod()).instantAt(day, time, zone)).toISOString();

  it('is the same clock time in UTC, and an offset away in another zone', async () => {
    assert.equal(await instant(DAY, '17:30', 'UTC'), at('17:30'));
    // Tokyo is nine hours ahead and has no clock change.
    assert.equal(await instant(DAY, '17:30', 'Asia/Tokyo'), at('08:30'));
    // And India half an hour off a whole one.
    assert.equal(await instant(DAY, '09:00', 'Asia/Kolkata'), at('03:30'));
  });

  it('moves with the clocks of New York when they go forward in March', async () => {
    // The clocks go forward at 02:00 on Sunday the 8th, so the same 17:30 is an hour earlier in UTC.
    assert.equal(
      await instant('2026-03-07', '17:30', 'America/New_York'),
      '2026-03-07T22:30:00.000Z',
    );
    assert.equal(
      await instant('2026-03-08', '17:30', 'America/New_York'),
      '2026-03-08T21:30:00.000Z',
    );
    assert.equal(
      await instant('2026-03-09', '17:30', 'America/New_York'),
      '2026-03-09T21:30:00.000Z',
    );
    // Either side of the change itself.
    assert.equal(
      await instant('2026-03-08', '01:59', 'America/New_York'),
      '2026-03-08T06:59:00.000Z',
    );
    assert.equal(
      await instant('2026-03-08', '03:00', 'America/New_York'),
      '2026-03-08T07:00:00.000Z',
    );
  });

  it('moves with the clocks of New York when they go back in November', async () => {
    assert.equal(
      await instant('2026-10-31', '17:30', 'America/New_York'),
      '2026-10-31T21:30:00.000Z',
    );
    assert.equal(
      await instant('2026-11-01', '17:30', 'America/New_York'),
      '2026-11-01T22:30:00.000Z',
    );
    assert.equal(
      await instant('2026-11-01', '02:00', 'America/New_York'),
      '2026-11-01T07:00:00.000Z',
    );
  });

  it('takes a time that the clocks skip as just after the gap', async () => {
    // 02:30 on the 8th of March does not exist in New York: it is read with the old offset.
    assert.equal(
      await instant('2026-03-08', '02:30', 'America/New_York'),
      '2026-03-08T07:30:00.000Z',
    );
    assert.equal(
      await instant('2026-03-08', '02:00', 'America/New_York'),
      '2026-03-08T07:00:00.000Z',
    );
  });

  it('takes a time that happens twice as the first time it happens', async () => {
    // 01:30 on the 1st of November is on the clock at 05:30 UTC and again at 06:30 UTC.
    assert.equal(
      await instant('2026-11-01', '01:30', 'America/New_York'),
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('follows the southern hemisphere, where the clocks change the other way round', async () => {
    // Sydney goes forward at 02:00 on Sunday the 4th of October.
    assert.equal(
      await instant('2026-10-03', '17:30', 'Australia/Sydney'),
      '2026-10-03T07:30:00.000Z',
    );
    assert.equal(
      await instant('2026-10-04', '17:30', 'Australia/Sydney'),
      '2026-10-04T06:30:00.000Z',
    );
  });
});

/* ----------------------------------------------------------- end of the day */

describe('the end-of-day reminder', () => {
  let api: Api;

  before(async () => {
    api = await serve();
  });
  beforeEach(fresh);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });

  it('is not due before wrapup_time, and is due from it on', async () => {
    freeze(at('17:29:59'));
    await logged(at('10:00'), 90);
    assert.deepEqual(await wrapUps(), []);

    goTo(at('17:30'));
    const [prompt, ...others] = await wrapUps();
    assert.equal(others.length, 0);
    assert.equal(prompt?.id, `wrapup:${DAY}`);
    assert.equal(prompt?.kind, 'wrapup');
    assert.equal(prompt?.title, 'Time to wrap up the day');
    assert.equal(prompt?.body, 'You have focused for 1 h 30 min across 1 block so far today.');
    // The time it fell due, which stays the same however late it is read.
    assert.equal(prompt?.createdAt, at('17:30'));
    assert.deepEqual(prompt?.actions, [
      { id: 'open', label: 'Wrap up', primary: true, open: '/wrap-up' },
      { id: 'dismiss', label: 'Not today' },
    ]);

    goTo(at('21:45'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, at('17:30')]],
    );
  });

  it('follows the time in the setting', async () => {
    await set({ wrapup_time: '16:00' });
    freeze(at('15:59'));
    await logged(at('10:00'), 60);
    assert.deepEqual(await wrapUps(), []);

    goTo(at('16:00'));
    assert.equal((await wrapUps())[0]?.createdAt, at('16:00'));
  });

  it('is off when wrapup_time is empty', async () => {
    freeze(at('19:00'));
    await logged(at('10:00'), 60);
    assert.equal((await wrapUps()).length, 1);

    await set({ wrapup_time: '' });

    assert.deepEqual(await wrapUps(), []);
  });

  it('is not asked on a day that is not a work day', async () => {
    freeze(at('19:00'));
    await logged(at('10:00'), 60);
    await set({ work_days: '2,3,4,5' });
    assert.deepEqual(await wrapUps(), [], 'Monday taken out of the work days');

    // And a Saturday, with the work days as they ship.
    await set({ work_days: '1,2,3,4,5' });
    freeze(on('2026-10-17', '19:00'));
    await logged(on('2026-10-17', '10:00'), 60);
    assert.deepEqual(await wrapUps(), []);
  });

  it('needs a focus block on the day, and a break or a discarded block is not one', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('18:00'));
    assert.deepEqual(await wrapUps(), [], 'no blocks at all');

    await logged(at('10:00'), 30, { kind: 'break' });
    assert.deepEqual(await wrapUps(), [], 'only a break');

    const thrownAway = await startBlock('Mistake');
    stopSession(thrownAway.id, 'abandoned');
    assert.deepEqual(await wrapUps(), [], 'only a discarded block');

    await logged(at('11:00'), 45);
    assert.equal((await wrapUps()).length, 1);
  });

  it('counts a block that is still running, by the time it has so far', async () => {
    freeze(at('16:30'));
    await startBlock('Deep work');
    goTo(at('17:45'));

    const [prompt] = await wrapUps();

    assert.equal(prompt?.body, 'You have focused for 1 h 15 min across 1 block so far today.');
  });

  it('names the time of every block of the day, and not the other days', async () => {
    freeze(at('18:00'));
    await logged(at('09:00'), 60);
    await logged(at('11:00'), 30);
    await logged(at('13:00'), 25);
    await logged(on('2026-10-11', '10:00'), 120);
    await logged(on('2026-10-13', '10:00'), 120);

    assert.equal(
      (await wrapUps())[0]?.body,
      'You have focused for 1 h 55 min across 3 blocks so far today.',
    );
  });

  it('is gone once the day is wrapped up, however it was done', async () => {
    const { finishDay } = await wrapupMod();
    freeze(at('18:00'));
    await logged(at('10:00'), 60);
    assert.equal((await wrapUps()).length, 1);

    finishDay(DAY);
    assert.deepEqual(await wrapUps(), []);

    // The same through the page's own request, on another day.
    freeze(on('2026-10-13', '18:00'));
    await logged(on('2026-10-13', '10:00'), 60);
    assert.equal((await wrapUps()).length, 1);
    assert.equal((await api.call('POST', '/wrapup/day/2026-10-13/done')).status, 200);
    assert.deepEqual(await wrapUps(), []);
  });

  it('stays dismissed for that day, and the next day asks again', async () => {
    freeze(at('18:00'));
    await logged(at('10:00'), 60);

    const res = await act(`wrapup:${DAY}`, 'dismiss');

    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body.prompts as Prompt[]).filter((p) => p.kind === 'wrapup'),
      [],
    );
    assert.equal((await savedState(`wrapup:${DAY}`))?.status, 'dismissed');
    goTo(at('23:00'));
    assert.deepEqual(await wrapUps(), []);

    // Tuesday is another day: its own prompt, with its own answer.
    freeze(on('2026-10-13', '18:00'));
    await logged(on('2026-10-13', '10:00'), 60);
    assert.deepEqual(
      (await wrapUps()).map((p) => p.id),
      ['wrapup:2026-10-13'],
    );
  });

  it('answers 400 to Wrap up, which only opens a page, and 409 to a day that is not asked about', async () => {
    freeze(at('18:00'));
    await logged(at('10:00'), 60);

    assert.equal((await act(`wrapup:${DAY}`, 'open')).status, 400);
    assert.equal((await act(`wrapup:${DAY}`, 'bogus')).status, 400);
    assert.equal((await act('wrapup:2026-10-11', 'dismiss')).status, 409);
    assert.equal((await wrapUps()).length, 1);
  });

  it('keeps asking past midnight about the day that has not ended, until the day turns', async () => {
    freeze(at('18:00'));
    await logged(at('10:00'), 60);
    assert.equal((await wrapUps())[0]?.id, `wrapup:${DAY}`);

    // 01:00 on Tuesday is still Monday's day: it starts at 04:00.
    goTo(on('2026-10-13', '01:00'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, at('17:30')]],
    );
    goTo(on('2026-10-13', '03:59:59'));
    assert.equal((await wrapUps()).length, 1);

    // At 04:00 it is Tuesday, which has no blocks on it and is not yet time to wrap it up.
    goTo(on('2026-10-13', '04:00'));
    assert.deepEqual(await wrapUps(), []);
  });

  it('takes the day it belongs to from the focus day, so the small hours of a work day are its own and those of a rest day are not', async () => {
    // Friday night, past midnight: it is Saturday on the calendar and still Friday's day.
    freeze(on('2026-10-16', '20:00'));
    await logged(on('2026-10-16', '19:00'), 60);
    goTo(on('2026-10-17', '01:00'));
    assert.deepEqual(
      (await wrapUps()).map((p) => p.id),
      ['wrapup:2026-10-16'],
    );

    // Sunday night, past midnight: a Monday on the calendar and still the rest day before it.
    freeze(on('2026-10-18', '20:00'));
    await logged(on('2026-10-18', '19:00'), 60);
    goTo(on('2026-10-19', '01:00'));
    assert.deepEqual(await wrapUps(), []);
  });

  it('reads a time before the day starts as the small hours at the end of the day', async () => {
    await set({ wrapup_time: '02:00' });
    freeze(at('23:00'));
    await logged(at('10:00'), 60);
    // It is 02:00 that night, not the 02:00 that has long gone by this morning.
    assert.deepEqual(await wrapUps(), []);

    goTo(on('2026-10-13', '01:59:59'));
    assert.deepEqual(await wrapUps(), []);
    goTo(on('2026-10-13', '02:00'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, on('2026-10-13', '02:00')]],
    );
  });

  it('reads a time at the hour the day starts as the end of the day, which it never reaches, and not as the first minute of it', async () => {
    // Day start 04:00 and wrapup_time 04:00: that is the moment this day turns into the next, so
    // it is not the day's own first minute (which asked to wrap up from the first block of the
    // morning), and by the time it comes it is the next day that is being asked about.
    await set({ wrapup_time: '04:00' });
    freeze(at('10:00'));
    await logged(at('09:00'), 30);
    for (const when of [
      at('10:01'),
      at('17:30'),
      at('23:59'),
      on('2026-10-13', '02:00'),
      on('2026-10-13', '03:59:59'),
    ]) {
      goTo(when);
      assert.deepEqual(await wrapUps(), [], when);
    }
    goTo(on('2026-10-13', '04:00'));
    assert.deepEqual(await wrapUps(), [], 'the next day has nothing on it yet');
    await logged(on('2026-10-13', '04:05'), 30);
    goTo(on('2026-10-13', '12:00'));
    assert.deepEqual(await wrapUps(), [], 'and its own 04:00 is a whole day away');
  });

  it('reads a minute before the hour the day starts as the small hours of the night after', async () => {
    await set({ wrapup_time: '03:59' });
    freeze(at('23:00'));
    await logged(at('10:00'), 60);
    assert.deepEqual(await wrapUps(), [], 'it is not 03:59 of this morning');
    goTo(on('2026-10-13', '03:58:59'));
    assert.deepEqual(await wrapUps(), []);
    goTo(on('2026-10-13', '03:59'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, on('2026-10-13', '03:59')]],
    );
  });

  it('reads a minute after the hour the day starts as a time of the day itself', async () => {
    await set({ wrapup_time: '04:01' });
    freeze(at('04:30'));
    await logged(at('04:05'), 20);
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, at('04:01')]],
      'the day has started, so it is due as soon as there is something to wrap up',
    );
  });

  it('reads 00:00 as the end of the day when the day starts at midnight, so it never comes, and 00:01 as the first minute of it', async () => {
    await set({ day_start_hour: 0, wrapup_time: '00:00' });
    freeze(at('10:00'));
    await logged(at('09:00'), 30);
    for (const when of [at('10:01'), at('23:59:59'), on('2026-10-13', '00:00')]) {
      goTo(when);
      assert.deepEqual(await wrapUps(), [], when);
    }

    await set({ wrapup_time: '00:01' });
    freeze(at('10:01'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, at('00:01')]],
    );
  });

  it('reads wrapup_time on the clocks of the timezone the user is in, not the machine', async () => {
    await set({ timezone: 'Asia/Tokyo' });
    freeze(at('00:30'));
    // 09:30 in Tokyo, on the same Monday there.
    await logged(at('00:30'), 60);

    goTo(at('08:29:59'));
    assert.deepEqual(await wrapUps(), []);
    goTo(at('08:30'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [[`wrapup:${DAY}`, at('08:30')]],
    );
  });

  it('keeps its time of day across a clock change', async () => {
    await set({ timezone: 'America/New_York', work_days: '6,7' });
    // Saturday the 7th is before the clocks go forward, Sunday the 8th is after: 17:30 is an hour apart in UTC.
    freeze(on('2026-03-07', '22:29:59'));
    await logged(on('2026-03-07', '15:00'), 60);
    assert.deepEqual(await wrapUps(), []);
    goTo(on('2026-03-07', '22:30'));
    assert.equal((await wrapUps())[0]?.createdAt, on('2026-03-07', '22:30'));

    freeze(on('2026-03-08', '21:29:59'));
    await logged(on('2026-03-08', '15:00'), 60);
    assert.deepEqual(await wrapUps(), []);
    goTo(on('2026-03-08', '21:30'));
    assert.deepEqual(
      (await wrapUps()).map((p) => [p.id, p.createdAt]),
      [['wrapup:2026-03-08', on('2026-03-08', '21:30')]],
    );
  });

  it('does nothing but read when it lists', async () => {
    const { db } = await dbMod();
    freeze(at('18:00'));
    await logged(at('10:00'), 60);
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();

    assert.equal((await wrapUps()).length, 1);
    assert.equal((await wrapUps()).length, 1);

    assert.equal(changes(), before);
  });
});

/* --------------------------------------------------------------- last week */

describe('the review-of-last-week reminder', () => {
  let api: Api;
  /** Monday of last week, as the prompt names it. */
  const LAST = '2026-10-05';

  before(async () => {
    api = await serve();
  });
  beforeEach(fresh);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });
  /** A finished block on the Wednesday of last week. */
  const lastWeekBlock = (minutes = 120) => logged(on('2026-10-07', '10:00'), minutes);

  it('is due from work_start on the first work day of the week, and not before', async () => {
    freeze(at('08:59:59'));
    await lastWeekBlock();
    assert.deepEqual(await reviews(), []);

    goTo(at('09:00'));
    const [prompt, ...others] = await reviews();
    assert.equal(others.length, 0);
    assert.deepEqual(prompt, {
      id: `week-review:${LAST}`,
      kind: 'week-review',
      title: 'Review last week',
      body: `The week of ${dayText(LAST)}, with 2 h of focus.`,
      createdAt: at('09:00'),
      actions: [
        { id: 'open', label: 'Review', primary: true, open: `/wrap-up/week?week=${LAST}` },
        { id: 'dismiss', label: 'Not this week' },
      ],
    });
  });

  it('waits for the first work day when Monday is not one', async () => {
    await set({ work_days: '2,3,4,5' });
    freeze(at('15:00'));
    await lastWeekBlock();
    assert.deepEqual(await reviews(), [], 'Monday');

    goTo(on('2026-10-13', '08:59:59'));
    assert.deepEqual(await reviews(), [], 'Tuesday before work starts');
    goTo(on('2026-10-13', '09:00'));
    assert.deepEqual(
      (await reviews()).map((p) => [p.id, p.createdAt]),
      [[`week-review:${LAST}`, on('2026-10-13', '09:00')]],
    );
  });

  it('is due when work starts, whatever the setting says that is', async () => {
    await set({ work_start: '07:45' });
    freeze(at('07:44:59'));
    await lastWeekBlock();
    assert.deepEqual(await reviews(), []);
    goTo(at('07:45'));
    assert.equal((await reviews())[0]?.createdAt, at('07:45'));
  });

  it('reads work_start on the clocks of the timezone the user is in', async () => {
    await set({ timezone: 'Asia/Tokyo' });
    freeze(on('2026-10-11', '23:59:59'));
    // Last week's Wednesday, 10:00 in Tokyo.
    await logged(on('2026-10-07', '01:00'), 120);
    assert.deepEqual(await reviews(), [], '08:59:59 on Monday in Tokyo');
    goTo(at('00:00'));
    // 09:00 in Tokyo on Monday is 00:00 UTC.
    assert.equal((await reviews())[0]?.createdAt, at('00:00'));
  });

  it('needs last week to have had a focus block, and a break or a discarded block is not one', async () => {
    const { stopSession } = await sessionsMod();
    freeze(on('2026-10-08', '10:00'));
    const thrownAway = await startBlock('Mistake');
    stopSession(thrownAway.id, 'abandoned');
    await logged(on('2026-10-08', '11:00'), 30, { kind: 'break' });
    goTo(at('10:00'));
    assert.deepEqual(await reviews(), [], 'a break and a discarded block');

    await lastWeekBlock(30);
    assert.equal((await reviews()).length, 1);
  });

  it('counts the days of last week, Monday to Sunday by the focus day, and no other', async () => {
    freeze(at('10:00'));
    // The Sunday before, and this very week: neither is last week.
    await logged(on('2026-10-04', '10:00'), 60);
    await logged(on('2026-10-12', '09:30'), 60);
    assert.deepEqual(await reviews(), []);

    // 02:00 on Monday the 12th is still Sunday's day, which is last week's last.
    await logged(on('2026-10-12', '02:00'), 60);
    assert.equal((await reviews())[0]?.body, `The week of ${dayText(LAST)}, with 1 h of focus.`);
  });

  it('is gone once last week is reviewed', async () => {
    const { finishWeek } = await wrapupMod();
    freeze(at('10:00'));
    await lastWeekBlock();
    assert.equal((await reviews()).length, 1);

    finishWeek(LAST);

    assert.deepEqual(await reviews(), []);
  });

  it('stays dismissed for the rest of the week', async () => {
    freeze(at('10:00'));
    await lastWeekBlock();

    const res = await act(`week-review:${LAST}`, 'dismiss');

    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body.prompts as Prompt[]).filter((p) => p.kind === 'week-review'),
      [],
    );
    assert.equal((await savedState(`week-review:${LAST}`))?.status, 'dismissed');
    goTo(on('2026-10-16', '15:00'));
    assert.deepEqual(await reviews(), []);
  });

  it('answers 400 to Review, which only opens a page, and 409 to a week that is not asked about', async () => {
    freeze(at('10:00'));
    await lastWeekBlock();

    assert.equal((await act(`week-review:${LAST}`, 'open')).status, 400);
    assert.equal((await act('week-review:2026-09-28', 'dismiss')).status, 409);
    assert.equal((await reviews()).length, 1);
  });

  it('stays until the week is over, and then it is the next week that is asked about', async () => {
    freeze(at('10:00'));
    await lastWeekBlock();
    await logged(on('2026-10-14', '10:00'), 180);

    goTo(on('2026-10-18', '23:00'));
    assert.deepEqual(
      (await reviews()).map((p) => p.id),
      [`week-review:${LAST}`],
      'Sunday evening of the week it is for',
    );
    goTo(on('2026-10-19', '03:59:59'));
    assert.deepEqual(
      (await reviews()).map((p) => p.id),
      [`week-review:${LAST}`],
      'still Sunday, until the day starts at 04:00',
    );

    // From Monday the 19th it is the week of the 12th that was last, and the 5th is not asked about again.
    goTo(on('2026-10-19', '08:00'));
    assert.deepEqual(await reviews(), [], 'before work starts');
    goTo(on('2026-10-19', '09:00'));
    const [prompt, ...others] = await reviews();
    assert.equal(others.length, 0);
    assert.equal(prompt?.id, 'week-review:2026-10-12');
    assert.equal(prompt?.body, `The week of ${dayText('2026-10-12')}, with 3 h of focus.`);
    assert.equal(prompt?.createdAt, on('2026-10-19', '09:00'));
  });

  it('is not asked when no day of the week is a work day', async () => {
    freeze(at('10:00'));
    await lastWeekBlock();
    assert.equal((await reviews()).length, 1);

    await set({ work_days: '' });

    assert.deepEqual(await reviews(), []);
  });

  it('does nothing but read when it lists', async () => {
    const { db } = await dbMod();
    freeze(at('10:00'));
    await lastWeekBlock();
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();

    assert.equal((await reviews()).length, 1);

    assert.equal(changes(), before);
  });
});

/* ------------------------------------------------------ nothing on the clock */

describe('the nothing-on-the-clock nudge', () => {
  let api: Api;

  before(async () => {
    api = await serve();
  });
  beforeEach(fresh);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });

  it('is due once work hours have been quiet for nudge_minutes', async () => {
    freeze(at('09:14:59'));
    assert.deepEqual(await nudges(), []);

    goTo(at('09:15'));
    const [prompt, ...others] = await nudges();

    assert.equal(others.length, 0);
    assert.equal(prompt?.id, `idle:${at('09:00')}`);
    assert.equal(prompt?.kind, 'idle');
    assert.equal(prompt?.title, 'Nothing on the clock');
    assert.match(prompt?.body ?? '', /^Since .*9:00.*\. Start something\?$/);
    assert.equal(prompt?.createdAt, at('09:15'));
    assert.deepEqual(prompt?.actions, [
      { id: 'open', label: 'Start a block', primary: true, open: '/' },
      { id: 'dismiss', label: 'Not now' },
    ]);
    // The same list over HTTP.
    assert.deepEqual(
      ((await api.call('GET', '/prompts')).body as Prompt[]).filter((p) => p.kind === 'idle'),
      [prompt],
    );
  });

  it('follows nudge_minutes', async () => {
    await set({ nudge_minutes: 40 });
    freeze(at('09:39:59'));
    assert.deepEqual(await nudges(), []);
    goTo(at('09:40'));
    assert.equal((await nudges())[0]?.createdAt, at('09:40'));
  });

  it('is off when nudge_minutes is 0', async () => {
    freeze(at('14:00'));
    assert.equal((await nudges()).length, 1);

    await set({ nudge_minutes: 0 });

    assert.deepEqual(await nudges(), []);
  });

  it('is only asked inside work hours, from work_start up to work_end', async () => {
    freeze(at('08:00'));
    assert.deepEqual(await nudges(), [], 'before work');
    goTo(at('17:59:59'));
    assert.equal((await nudges()).length, 1, 'the last second of work');
    goTo(at('18:00'));
    assert.deepEqual(await nudges(), [], 'work is over');
    goTo(at('22:30'));
    assert.deepEqual(await nudges(), [], 'the evening');
  });

  it('follows the work hours in the settings', async () => {
    await set({ work_start: '10:00', work_end: '12:00' });
    freeze(at('10:14:59'));
    assert.deepEqual(await nudges(), []);
    goTo(at('10:15'));
    assert.equal((await nudges())[0]?.id, `idle:${at('10:00')}`);
    goTo(at('12:00'));
    assert.deepEqual(await nudges(), []);
  });

  it('is not asked on a day that is not a work day', async () => {
    freeze(at('14:00'));
    await set({ work_days: '2,3,4,5' });
    assert.deepEqual(await nudges(), [], 'Monday taken out of the work days');

    await set({ work_days: '1,2,3,4,5' });
    freeze(on('2026-10-17', '14:00'));
    assert.deepEqual(await nudges(), [], 'a Saturday');

    await set({ work_days: '' });
    freeze(at('14:00'));
    assert.deepEqual(await nudges(), [], 'no work days at all');
  });

  it('takes the work day from the calendar day the hours are on, so the small hours are the day the clock is on', async () => {
    // Fridays only, 02:00 to 08:00, and the focus day is not over until 04:00.
    await set({ work_days: '5', work_start: '02:00', work_end: '08:00' });
    freeze(on('2026-10-16', '02:14:59'));
    assert.deepEqual(await nudges(), [], 'Friday, before the quiet has lasted');
    goTo(on('2026-10-16', '02:15'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${on('2026-10-16', '02:00')}`, on('2026-10-16', '02:15')]],
    );

    // The next night is Saturday on the calendar: not a work day, although it is still Friday's
    // focus day until 04:00. The hours it is asked in and the day it is asked on are the same day.
    freeze(on('2026-10-17', '02:15'));
    assert.deepEqual(await nudges(), []);
    goTo(on('2026-10-17', '05:00'));
    assert.deepEqual(await nudges(), []);
  });

  it('goes by the weekday of the day the hours are on, however late the day starts', async () => {
    // The day starts at noon, so the morning hours are inside the focus day before.
    await set({ day_start_hour: 12 });

    // Saturday morning is Saturday's: not a work day, whatever the focus day (Friday) is.
    freeze(on('2026-10-17', '10:00'));
    assert.deepEqual(await nudges(), [], 'Saturday 10:00 is not work');
    goTo(on('2026-10-17', '15:00'));
    assert.deepEqual(await nudges(), [], 'nor is Saturday 15:00');

    // Monday morning is Monday's: work, although the focus day (Sunday) is not.
    freeze(on('2026-10-19', '10:00'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${on('2026-10-19', '09:00')}`, on('2026-10-19', '09:15')]],
      'Monday 10:00 is work',
    );
    freeze(on('2026-10-19', '13:00'));
    assert.equal((await nudges()).length, 1, 'and Monday 13:00');

    // Friday morning is Friday's, so it is work, as it is on the afternoon after the day turns over.
    freeze(on('2026-10-16', '10:00'));
    assert.equal((await nudges()).length, 1, 'Friday 10:00');
    freeze(on('2026-10-16', '13:00'));
    assert.equal((await nudges()).length, 1, 'Friday 13:00');
  });

  it('is not asked while a block is running', async () => {
    freeze(at('09:00'));
    await startBlock('Deep work');
    goTo(at('11:00'));

    assert.deepEqual(await nudges(), []);
  });

  it('is not asked while a block is paused either', async () => {
    const { pauseSession } = await sessionsMod();
    freeze(at('09:00'));
    const block = await startBlock('Deep work');
    goTo(at('09:20'));
    pauseSession(block.id);
    goTo(at('11:00'));

    assert.deepEqual(await nudges(), []);
  });

  it('is not asked while a timed meeting is going on, and an all-day event does not count', async () => {
    freeze(at('10:00'));
    await addEvent({ title: 'Offsite', start: at('00:00'), end: at('23:59'), allDay: true });
    assert.equal((await nudges()).length, 1, 'an all-day event says nothing about the hour');

    await addEvent({ title: 'Roadmap review', start: at('09:30'), end: at('10:30') });
    assert.deepEqual(await nudges(), [], 'inside the meeting');
    goTo(at('10:29:59'));
    assert.deepEqual(await nudges(), []);

    // It is the end of the meeting that frees it: the quiet has been going on since work began.
    goTo(at('10:30'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('09:00')}`, at('09:15')]],
    );
  });

  it('is not asked once the day is wrapped up', async () => {
    const { finishDay } = await wrapupMod();
    freeze(at('15:00'));
    assert.equal((await nudges()).length, 1);

    finishDay(DAY);

    assert.deepEqual(await nudges(), []);
  });

  it('counts the quiet from work_start when nothing has happened since', async () => {
    freeze(at('13:00'));

    const [prompt] = await nudges();

    assert.equal(prompt?.id, `idle:${at('09:00')}`);
    assert.equal(prompt?.createdAt, at('09:15'));
  });

  it('counts the quiet from the end of the last block, and not before it', async () => {
    freeze(at('10:44:59'));
    // A block of 09:30 to 10:30, which ends the quiet there was before it.
    await logged(at('09:30'), 60);
    assert.deepEqual(await nudges(), []);

    goTo(at('10:45'));
    const [prompt, ...others] = await nudges();

    assert.equal(others.length, 0);
    assert.equal(prompt?.id, `idle:${at('10:30')}`);
    assert.equal(prompt?.createdAt, at('10:45'));
    assert.match(prompt?.body ?? '', /^Since .*10:30.*\. Start something\?$/);
  });

  it('counts a break, and a block that was discarded, as the end of the last block too', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('09:00'));
    const thrownAway = await startBlock('Mistake');
    goTo(at('11:00'));
    stopSession(thrownAway.id, 'abandoned');
    assert.equal((await nudges()).length, 0, 'it has only just ended');
    goTo(at('11:15'));
    assert.equal((await nudges())[0]?.id, `idle:${at('11:00')}`, 'a discarded block');

    goTo(at('11:40'));
    await logged(at('11:30'), 10, { kind: 'break' });
    goTo(at('11:54:59'));
    assert.deepEqual(await nudges(), [], 'the break ended at 11:40');
    goTo(at('11:55'));
    assert.equal((await nudges())[0]?.id, `idle:${at('11:40')}`, 'a break');
  });

  it('is not put off by a block that ended on another day', async () => {
    freeze(at('09:15'));
    await logged(on('2026-10-11', '20:00'), 60);
    await logged(on('2026-10-12', '03:00'), 60);

    assert.equal((await nudges())[0]?.id, `idle:${at('09:00')}`);
  });

  it('is not put off by a block that has not begun, however far ahead it is dated', async () => {
    freeze(at('10:15'));
    // A meeting this afternoon logged as time spent ahead of it, and a block whose year was
    // typed wrong. Neither has begun, so the quiet still runs from work starting.
    await logged(at('15:00'), 60);
    await logged(on('2062-10-12', '10:00'), 60);
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('09:00')}`, at('09:15')]],
    );

    // The afternoon's counts once it has begun, and the quiet runs from its end.
    goTo(at('16:15'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('16:00')}`, at('16:15')]],
    );
    // The one decades on counts on no day before then.
    freeze(on('2026-10-13', '10:00'));
    assert.equal((await nudges())[0]?.id, `idle:${on('2026-10-13', '09:00')}`);
  });

  it('is held off while a block that was logged is going on, and counts the quiet from its end', async () => {
    freeze(at('10:00'));
    // 09:30 to 11:00, logged by hand while it is going on, as a meeting can be.
    await logged(at('09:30'), 90);
    assert.deepEqual(await nudges(), [], 'it is going on');
    goTo(at('10:59:59'));
    assert.deepEqual(await nudges(), [], 'its last second');
    goTo(at('11:14:59'));
    assert.deepEqual(await nudges(), [], 'not until nudge_minutes after it ends');
    goTo(at('11:15'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('11:00')}`, at('11:15')]],
    );
  });

  it('counts the quiet from the block that ended last, of those that are over, whichever began last', async () => {
    freeze(at('12:00'));
    // Logged after they happened, in no order. The latest end is 11:00, of the one that began
    // first, before work did.
    await logged(at('10:30'), 15);
    await logged(at('08:30'), 150);
    await logged(at('10:50'), 5, { kind: 'break' });
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('11:00')}`, at('11:15')]],
    );
  });

  it('counts the quiet from the last time it was dismissed, and is another prompt then', async () => {
    freeze(at('09:15'));
    const [first] = await nudges();
    assert.equal(first?.id, `idle:${at('09:00')}`);

    goTo(at('09:20'));
    const res = await act(first!.id, 'dismiss');

    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body.prompts as Prompt[]).filter((p) => p.kind === 'idle'),
      [],
    );
    assert.equal((await savedState(first!.id))?.status, 'dismissed');

    goTo(at('09:34:59'));
    assert.deepEqual(await nudges(), [], 'not until nudge_minutes after the dismissal');
    goTo(at('09:35'));
    const [second, ...others] = await nudges();
    assert.equal(others.length, 0);
    assert.equal(second?.id, `idle:${at('09:20')}`);
    assert.notEqual(second?.id, first?.id);
    assert.equal(second?.createdAt, at('09:35'));
  });

  it('is moved by a dismissal of its own and not by one of some other prompt', async () => {
    // A block from 09:30 to 10:00 puts the start of the quiet at 10:00, and the wrap-up is due at
    // 10:05 with it: two prompts are asking at once, and only one of them is this nudge.
    await set({ wrapup_time: '10:05' });
    freeze(at('10:00'));
    await logged(at('09:30'), 30);
    goTo(at('10:10'));
    assert.deepEqual(
      (await wrapUps()).map((p) => p.id),
      [`wrapup:${DAY}`],
    );

    assert.equal((await act(`wrapup:${DAY}`, 'dismiss')).status, 200);
    assert.equal((await savedState(`wrapup:${DAY}`))?.status, 'dismissed');
    goTo(at('10:15'));
    // The quiet still began at 10:00 and is still due at 10:15: that dismissal was not of this.
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('10:00')}`, at('10:15')]],
    );

    // Nor by the review of last week being put away.
    await logged(on('2026-10-07', '10:00'), 60);
    assert.deepEqual(
      (await reviews()).map((p) => p.id),
      ['week-review:2026-10-05'],
    );
    assert.equal((await act('week-review:2026-10-05', 'dismiss')).status, 200);
    assert.deepEqual(
      (await nudges()).map((p) => p.id),
      [`idle:${at('10:00')}`],
    );
  });

  it('is not moved by a dismissal on another day, and starts again from work_start', async () => {
    freeze(on('2026-10-09', '15:00'));
    const [yesterdays] = await nudges();
    assert.ok(yesterdays, 'there was a nudge on the Friday');
    assert.equal((await act(yesterdays.id, 'dismiss')).status, 200);

    freeze(at('09:15'));
    const [prompt] = await nudges();

    assert.equal(prompt?.id, `idle:${at('09:00')}`);
    assert.equal(prompt?.createdAt, at('09:15'));
  });

  it('asks again after every dismissal, as often as it is dismissed', async () => {
    freeze(at('09:15'));
    const seen: string[] = [];
    for (const minute of ['09:15', '09:31', '09:47']) {
      goTo(at(minute));
      const [prompt] = await nudges();
      assert.ok(prompt, minute);
      seen.push(prompt.id);
      assert.equal((await act(prompt.id, 'dismiss')).status, 200);
    }
    assert.deepEqual(seen, [`idle:${at('09:00')}`, `idle:${at('09:15')}`, `idle:${at('09:31')}`]);
  });

  it('counts the quiet from when the server started, so opening the app late does not nag at once', async () => {
    const { setServerStartedAt } = await remindersMod();
    setServerStartedAt(Date.parse(at('14:00')));
    freeze(at('14:00'));
    assert.deepEqual(await nudges(), [], 'the moment it opens');
    goTo(at('14:14:59'));
    assert.deepEqual(await nudges(), []);

    goTo(at('14:15'));
    const [prompt] = await nudges();

    assert.equal(prompt?.id, `idle:${at('14:00')}`);
    assert.equal(prompt?.createdAt, at('14:15'));
  });

  it('counts the quiet from when the process began unless a start is given, so it never starts out overdue', async () => {
    const { setServerStartedAt } = await remindersMod();
    setServerStartedAt(null);
    freeze(at('14:00'));
    // The process in this test has been up for a few seconds, however late the clock says it is.
    assert.deepEqual(await nudges(), []);
    goTo(at('14:10'));
    assert.deepEqual(await nudges(), [], 'ten minutes of quiet is less than the fifteen');

    setServerStartedAt(0);
    assert.equal((await nudges()).length, 1);
  });

  it("is the same prompt every time it is listed while the start is the process's own, however late the uptime is read", async () => {
    const { setServerStartedAt } = await remindersMod();
    setServerStartedAt(null);
    // A server that began 100 seconds before the instant the clock is frozen at. Its uptime is
    // read a different few milliseconds late each time, as it is once a request has been through
    // the providers before this one, which put the start somewhere new on every poll.
    let reads = 0;
    const uptime = mock.method(process, 'uptime', () => 100 + (reads++ % 9) / 1000);
    try {
      await set({ nudge_minutes: 1 });
      freeze(at('14:00'));
      const seen = new Set<string>();
      const due = new Set<string>();
      for (let n = 0; n < 40; n++) {
        const [prompt, ...others] = await nudges();
        assert.ok(prompt, 'it has been quiet for 100 seconds, which is more than the minute');
        assert.equal(others.length, 0);
        seen.add(prompt.id);
        due.add(prompt.createdAt);
      }
      assert.equal(seen.size, 1, [...seen].join(' '));
      assert.equal(due.size, 1);
      // Answering it by the id it was listed with works, which it did not when the id moved.
      assert.equal((await act([...seen][0]!, 'dismiss')).status, 200);
      assert.deepEqual(await nudges(), []);
    } finally {
      uptime.mock.restore();
    }
  });

  it('takes a clock that has been moved back past the start as a new start, so a start of its own is never ahead of the clock', async () => {
    const { setServerStartedAt } = await remindersMod();
    setServerStartedAt(null);
    const uptime = mock.method(process, 'uptime', () => 100);
    try {
      await set({ nudge_minutes: 1 });
      freeze(at('14:00'));
      assert.equal((await nudges())[0]?.id, `idle:${at('13:58:20')}`);

      // A clock that steps back a little, to a time that is still after the start, changes nothing.
      freeze(at('13:59:59'));
      assert.equal((await nudges())[0]?.id, `idle:${at('13:58:20')}`);

      // Put back two hours, the start it had is in the future, which would hold the nudge off
      // until the clock got there: the server has been up for 100 seconds as of this clock.
      freeze(at('12:00'));
      assert.equal((await nudges())[0]?.id, `idle:${at('11:58:20')}`);
    } finally {
      uptime.mock.restore();
    }
  });

  it('does not move the start when the Mac sleeps: the uptime stops and the clock does not, and it is still the same stretch', async () => {
    const { setServerStartedAt } = await remindersMod();
    setServerStartedAt(null);
    // The process has been up for as long as it has been awake, as the real uptime is.
    let awake = 0;
    const uptime = mock.method(process, 'uptime', () => awake / 1000);
    try {
      freeze(at('10:00'));
      assert.deepEqual(await nudges(), [], 'it has only just started');
      goTo(at('10:20'));
      awake = 20 * MINUTE;
      const before = await nudges();
      assert.deepEqual(
        before.map((p) => [p.id, p.createdAt]),
        [[`idle:${at('10:00')}`, at('10:15')]],
      );

      // The lid is shut at 10:20 and opened at 11:20: an hour on by the clock, none by the uptime.
      // Counting the start back from the uptime put it at 11:00, a new prompt (and a second
      // notification) that said "Since 11:00 AM" about a quiet that had begun at 10:00.
      goTo(at('11:20'));
      assert.deepEqual(await nudges(), before);
      assert.match(before[0]?.body ?? '', /^Since .*10:00.*\. Start something\?$/);

      // And on until a block ends it, like any other quiet.
      goTo(at('13:00'));
      assert.deepEqual(
        (await nudges()).map((p) => [p.id, p.createdAt]),
        [[`idle:${at('10:00')}`, at('10:15')]],
      );
    } finally {
      uptime.mock.restore();
    }
  });

  it('takes the latest of the four, whichever that is', async () => {
    const { setServerStartedAt } = await remindersMod();
    freeze(at('09:30'));
    // Work began at 09:00, the server at 09:20 and a block ended at 09:40: the block is the latest.
    setServerStartedAt(Date.parse(at('09:20')));
    await logged(at('09:10'), 30);
    goTo(at('09:55'));
    assert.equal((await nudges())[0]?.id, `idle:${at('09:40')}`);

    // A dismissal at 09:56 is later than the block that ended at 09:40.
    const [prompt] = await nudges();
    goTo(at('09:56'));
    await act(prompt!.id, 'dismiss');
    goTo(at('10:10'));
    assert.deepEqual(await nudges(), []);
    goTo(at('10:11'));
    assert.equal((await nudges())[0]?.id, `idle:${at('09:56')}`);
  });

  it('is a new prompt when a block starts and ends in between, and not before it is quiet again', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('09:15'));
    const [first] = await nudges();

    const block = await startBlock('Deep work');
    goTo(at('10:00'));
    assert.deepEqual(await nudges(), [], 'while the block runs');
    stopSession(block.id, 'completed');
    goTo(at('10:14:59'));
    assert.deepEqual(await nudges(), [], 'the quiet starts over when it ends');
    goTo(at('10:15'));

    const [second] = await nudges();
    assert.equal(second?.id, `idle:${at('10:00')}`);
    assert.notEqual(second?.id, first?.id);
  });

  it('answers 400 to Start a block, which only opens a page, and 409 to a stretch that is over', async () => {
    freeze(at('09:15'));
    const [prompt] = await nudges();

    assert.equal((await act(prompt!.id, 'open')).status, 400);
    assert.equal((await act(prompt!.id, 'bogus')).status, 400);
    assert.equal((await act(`idle:${at('08:00')}`, 'dismiss')).status, 409);
    assert.equal((await nudges()).length, 1);
  });

  it('reads the work hours on the clocks of the timezone the user is in, not the machine', async () => {
    await set({ timezone: 'America/Los_Angeles' });
    // 09:00 to 18:00 in Los Angeles in October is 16:00 to 01:00 UTC.
    freeze(at('15:59:59'));
    assert.deepEqual(await nudges(), [], 'before work, there');
    goTo(at('16:14:59'));
    assert.deepEqual(await nudges(), []);
    goTo(at('16:15'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('16:00')}`, at('16:15')]],
    );
    goTo(on('2026-10-13', '00:59:59'));
    assert.equal((await nudges()).length, 1, 'still work, there');
    goTo(on('2026-10-13', '01:00'));
    assert.deepEqual(await nudges(), [], 'work is over, there');
  });

  it('reads the work days in the zone too, so a Monday there can be a Sunday here', async () => {
    await set({ timezone: 'Pacific/Auckland', work_days: '1' });
    // 09:15 on Tuesday the 13th in Auckland (UTC+13 in October) is 20:15 UTC on the Monday.
    freeze(at('20:14:59'));
    assert.deepEqual(
      await nudges(),
      [],
      'Monday here, but a Tuesday there, which is not a work day',
    );
    await set({ work_days: '2' });
    goTo(at('20:15'));
    assert.deepEqual(
      (await nudges()).map((p) => [p.id, p.createdAt]),
      [[`idle:${at('20:00')}`, at('20:15')]],
    );
  });

  it('keeps work hours on the clock across a clock change', async () => {
    await set({ timezone: 'America/New_York', work_days: '6,7' });
    // Saturday the 31st is before the clocks go back (UTC-4), Sunday the 1st is after (UTC-5).
    freeze(on('2026-10-31', '13:14:59'));
    assert.deepEqual(await nudges(), []);
    goTo(on('2026-10-31', '13:15'));
    assert.equal((await nudges())[0]?.id, `idle:${on('2026-10-31', '13:00')}`);

    freeze(on('2026-11-01', '14:14:59'));
    assert.deepEqual(await nudges(), []);
    goTo(on('2026-11-01', '14:15'));
    assert.equal((await nudges())[0]?.id, `idle:${on('2026-11-01', '14:00')}`);
  });

  it('puts a work_start that the clocks skip just after the gap', async () => {
    await set({
      timezone: 'America/New_York',
      work_days: '7',
      work_start: '02:30',
      work_end: '08:00',
      // So that the small hours are the day's own and not still Saturday's.
      day_start_hour: 0,
    });
    // 02:30 does not happen on the 8th of March; it is read as 03:30 summer time, 07:30 UTC.
    freeze(on('2026-03-08', '07:44:59'));
    assert.deepEqual(await nudges(), []);
    goTo(on('2026-03-08', '07:45'));
    assert.equal((await nudges())[0]?.id, `idle:${on('2026-03-08', '07:30')}`);
  });

  it('does nothing but read when it lists', async () => {
    const { db } = await dbMod();
    freeze(at('14:00'));
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();

    assert.equal((await nudges()).length, 1);
    advance(MINUTE);
    assert.equal((await nudges()).length, 1);

    assert.equal(changes(), before);
  });
});

/* ---------------------------------------------------------- all together */

describe('the reminders together', () => {
  beforeEach(fresh);
  afterEach(() => mock.timers.reset());

  it('are listed with the rest, oldest first', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('08:00'));
    // Last week had a block (the review is due at 09:00), and so does this morning,
    // which ended at 10:30 and so put the nudge off until 10:45.
    await logged(on('2026-10-07', '10:00'), 60);
    await logged(at('09:30'), 60);
    goTo(at('17:45'));

    assert.deepEqual(
      listPrompts().map((p) => [p.kind, p.createdAt]),
      [
        ['week-review', at('09:00')],
        ['idle', at('10:45')],
        ['wrapup', at('17:30')],
      ],
    );
  });

  it('are each left out when they do not apply, and the others stay', async () => {
    const { listPrompts } = await promptsMod();
    freeze(at('08:00'));
    await logged(at('09:30'), 60);
    goTo(at('18:30'));

    // Work is over, so there is no nudge, and last week was empty: only the wrap-up is left.
    assert.deepEqual(
      listPrompts().map((p) => p.kind),
      ['wrapup'],
    );
  });
});
