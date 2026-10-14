import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { at, freeze, makeProject, reset } from './prompt-helpers.js';

/*
 * A meeting's id is its feed, its UID and its start, so a meeting that moves leaves the calendar
 * and comes back under a new id. What was linked to it has to follow it: the time logged on it,
 * the project it was given, what was done about its prompts. That includes the move every series
 * made the first time this version synced a calendar on a computer outside UTC, where the version
 * before it had stored the series' meetings off by the computer's offset from UTC.
 */

const calendarMod = () => import('../src/lib/calendar.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

const calendar = (lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

const meeting = (uid: string, summary: string, start: string, end: string, extra: string[] = []) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `SUMMARY:${summary}`,
  start,
  end,
  ...extra,
  'END:VEVENT',
];

/** A feed on a loopback port, added as the calendar Work, whose text can be changed between syncs. */
async function feedOf(text: string) {
  const feed = { text };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(feed.text);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const source = (await calendarMod()).addSource('Work', `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.ics`);
  return {
    feed,
    provider: `ics:${source.id}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const sync = async () => (await calendarMod()).syncCalendars();

/** A meeting as the calendar has it, put there as an earlier version of the app left it. */
async function stored(provider: string, uid: string, title: string, start: string, minutes: number, projectId: number | null = null) {
  const { db } = await dbMod();
  const id = `${provider}:${uid}:${start}`;
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO calendar_events (id, provider, calendar_id, title, starts_at, ends_at, all_day, local_day, project_id, synced_at)
     VALUES (?, ?, 'Work', ?, ?, ?, 0, ?, ?, '2026-10-01T00:00:00.000Z')`,
  ).run(id, provider, title, start, end, start.slice(0, 10), projectId);
  return id;
}

/** A finished block of `minutes`, logged on the meeting with id `eventId`. Returns its id. */
async function logged(eventId: string, start: string, minutes: number) {
  const { db } = await dbMod();
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO sessions (title, kind, planned_minutes, started_at, ended_at, local_day, active_seconds, status,
                             calendar_event_id, created_at, updated_at)
       VALUES ('Meeting', 'focus', NULL, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    )
    .run(start, end, start.slice(0, 10), minutes * 60, eventId, start, start);
  return Number(info.lastInsertRowid);
}

async function linkOf(sessionId: number) {
  const { db } = await dbMod();
  return (db.prepare('SELECT calendar_event_id AS id FROM sessions WHERE id = ?').get(sessionId) as { id: string | null }).id;
}

async function rows() {
  const { db } = await dbMod();
  return db.prepare('SELECT id, title, starts_at, project_id FROM calendar_events ORDER BY starts_at, title').all() as {
    id: string;
    title: string;
    starts_at: string;
    project_id: number | null;
  }[];
}

describe('a meeting that moves', () => {
  beforeEach(async () => {
    await reset();
    (await settingsMod()).setSettings({ calendar_sources: '[]' });
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  it('keeps its logged time and its project when an earlier version stored its series off by the offset from UTC', async () => {
    const alpha = await makeProject('Alpha');
    const NY = 'TZID=America/New_York';
    const { provider, close } = await feedOf(
      calendar([
        // Mondays at nine in New York: 13:00 UTC in summer time, 14:00 UTC from 2 November.
        ...meeting('standup@test', 'Standup', `DTSTART;${NY}:20261005T090000`, `DTEND;${NY}:20261005T093000`, ['RRULE:FREQ=WEEKLY;COUNT=8']),
        // A meeting new to the calendar at the very time another, which the feed no longer has, was.
        ...meeting('other@test', 'Other', 'DTSTART:20261013T090000Z', 'DTEND:20261013T100000Z'),
      ]),
    );
    try {
      // What the earlier version stored on a computer in New York: nine in the morning as 09:00
      // UTC. The meeting of 12 October was given a project, and time was logged on that of 5 October.
      const mondays = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
      const old = new Map<string, string>();
      for (const day of mondays) {
        old.set(day, await stored(provider, 'standup@test', 'Standup', `${day}T09:00:00.000Z`, 30, day === '2026-10-12' ? alpha : null));
      }
      const onStandup = await logged(old.get('2026-10-05')!, '2026-10-05T09:00:00.000Z', 30);
      const gone = await stored(provider, 'gone@test', 'Gone', '2026-10-13T09:00:00.000Z', 60);
      const onGone = await logged(gone, '2026-10-13T09:00:00.000Z', 60);

      const [result] = await sync();
      assert.deepEqual([result?.ok, result?.events], [true, 9]);

      const after = await rows();
      assert.deepEqual(
        after.map((r) => [r.title, r.starts_at, r.project_id]),
        [
          ['Standup', '2026-10-05T13:00:00.000Z', null],
          ['Standup', '2026-10-12T13:00:00.000Z', alpha],
          ['Other', '2026-10-13T09:00:00.000Z', null],
          ['Standup', '2026-10-19T13:00:00.000Z', null],
          ['Standup', '2026-10-26T13:00:00.000Z', null],
          ['Standup', '2026-11-02T14:00:00.000Z', null],
          ['Standup', '2026-11-09T14:00:00.000Z', null],
          ['Standup', '2026-11-16T14:00:00.000Z', null],
          ['Standup', '2026-11-23T14:00:00.000Z', null],
        ],
      );
      // The block is on the meeting it was logged on, at its right time, which shows it.
      assert.equal(await linkOf(onStandup), `${provider}:standup@test:2026-10-05T13:00:00.000Z`);
      const { listEvents } = await calendarMod();
      const fifth = listEvents('2026-10-05', '2026-10-05').find((e) => e.title === 'Standup');
      assert.equal(fifth?.loggedSeconds, 1800);
      // A meeting is never taken for one of another series, however near.
      assert.equal(await linkOf(onGone), gone);
      assert.equal(listEvents('2026-10-13', '2026-10-13').find((e) => e.title === 'Other')?.loggedSeconds, 0);
    } finally {
      await close();
    }
  });

  it('keeps its logged time, its project and its answered prompts when it is moved within its day', async () => {
    const beta = await makeProject('Beta');
    const review = (start: string, end: string) => meeting('review@test', 'Review', `DTSTART:${start}`, `DTEND:${end}`);
    const { feed, provider, close } = await feedOf(calendar(review('20261013T100000Z', '20261013T110000Z')));
    try {
      await sync();
      const { db } = await dbMod();
      const first = `${provider}:review@test:2026-10-13T10:00:00.000Z`;
      db.prepare('UPDATE calendar_events SET project_id = ? WHERE id = ?').run(beta, first);
      const block = await logged(first, '2026-10-13T10:00:00.000Z', 45);
      db.prepare("INSERT INTO prompt_state (key, status, updated_at) VALUES (?, 'dismissed', '2026-10-12T12:00:00.000Z')").run(
        `meeting-end:${first}`,
      );

      feed.text = calendar(review('20261013T113000Z', '20261013T123000Z'));
      await sync();

      const moved = `${provider}:review@test:2026-10-13T11:30:00.000Z`;
      assert.deepEqual(
        (await rows()).map((r) => [r.id, r.project_id]),
        [[moved, beta]],
      );
      assert.equal(await linkOf(block), moved);
      assert.equal((await calendarMod()).listEvents('2026-10-13', '2026-10-13')[0]?.loggedSeconds, 2700);
      assert.deepEqual(
        (db.prepare("SELECT key FROM prompt_state WHERE key LIKE 'meeting-%'").all() as { key: string }[]).map((r) => r.key),
        [`meeting-end:${moved}`],
      );

      // A day later is another meeting of the series, not this one moved.
      feed.text = calendar(review('20261014T113000Z', '20261014T123000Z'));
      await sync();
      assert.equal(await linkOf(block), moved);
    } finally {
      await close();
    }
  });

  it('pairs each meeting that goes with the nearest of its series that arrives, one with one', async () => {
    const { provider, close } = await feedOf(
      calendar([
        // At 13:00 and at 21:00 UTC on the same day.
        ...meeting('twice@test', 'Twice', 'DTSTART:20261013T130000Z', 'DTEND:20261013T133000Z', ['RRULE:FREQ=HOURLY;INTERVAL=8;COUNT=2']),
        ...meeting('pm@test', 'Afternoon', 'DTSTART:20261013T210000Z', 'DTEND:20261013T213000Z'),
      ]),
    );
    try {
      // Two meetings of one series four hours early, as on a computer four hours behind UTC.
      const morning = await logged(await stored(provider, 'twice@test', 'Twice', '2026-10-13T09:00:00.000Z', 30), '2026-10-13T09:00:00.000Z', 30);
      const evening = await logged(await stored(provider, 'twice@test', 'Twice', '2026-10-13T17:00:00.000Z', 30), '2026-10-13T17:00:00.000Z', 30);

      await sync();

      assert.equal(await linkOf(morning), `${provider}:twice@test:2026-10-13T13:00:00.000Z`);
      assert.equal(await linkOf(evening), `${provider}:twice@test:2026-10-13T21:00:00.000Z`);
    } finally {
      await close();
    }
  });
});
