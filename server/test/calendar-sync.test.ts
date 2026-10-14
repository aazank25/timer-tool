import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SyncResult } from '../src/lib/calendar.js';
import {
  addEvent,
  advance,
  at,
  type Api,
  freeze,
  goTo,
  makeProject,
  MINUTE,
  reset,
  serve,
} from './prompt-helpers.js';

const calendarMod = () => import('../src/lib/calendar.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A turn of the event loop: long enough for a promise chain that waits on nothing to finish. */
const flush = () => new Promise((r) => setImmediate(r));

/** Wait, in real time, for a condition: these tests read a real feed on a real clock. */
async function until(condition: () => boolean, what: string, limitMs = 5_000) {
  for (let waited = 0; waited < limitMs; waited += 10) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** How many meetings of a feed the calendar holds. */
async function meetingsOf(sourceId: string): Promise<number> {
  const { db } = await dbMod();
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE provider = ?')
    .get(`ics:${sourceId}`) as { n: number };
  return row.n;
}

/** 2026-10-13T14:00:00.000Z as an ICS date-time. */
const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

interface FeedEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  rrule?: string;
}

function ics(events: FeedEvent[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `SUMMARY:${e.summary}`,
      ...(e.location ? [`LOCATION:${e.location}`] : []),
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      ...(e.rrule ? [`RRULE:${e.rrule}`] : []),
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

/** An ICS feed on a loopback port, so a sync reads a real feed and nothing leaves the machine. */
async function serveFeed(initial: FeedEvent[] = []) {
  let body = ics(initial);
  const feed = {
    url: '',
    hits: 0,
    inFlight: 0,
    mostAtOnce: 0,
    /** Requests the reader gave up on before they were answered. */
    abandoned: 0,
    delayMs: 0,
    status: 200,
    /** What to answer with instead of the calendar, such as an error page. */
    raw: null as string | null,
    contentType: 'text/calendar',
    set: (events: FeedEvent[]) => {
      body = ics(events);
    },
  };
  const server = http.createServer((_req, res) => {
    feed.hits++;
    feed.inFlight++;
    feed.mostAtOnce = Math.max(feed.mostAtOnce, feed.inFlight);
    const answer = setTimeout(() => {
      res.statusCode = feed.status;
      res.setHeader('content-type', feed.contentType);
      res.end(feed.raw ?? body);
      feed.inFlight--;
    }, feed.delayMs);
    res.on('close', () => {
      if (res.writableEnded) return;
      clearTimeout(answer);
      feed.abandoned++;
      feed.inFlight--;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  feed.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.ics`;
  return {
    feed,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function eventsOn(from: string, to = from) {
  const { listEvents } = await calendarMod();
  return listEvents(from, to);
}

/** Forget every feed, so a test starts with none. */
async function noFeeds() {
  (await settingsMod()).setSettings({ calendar_sources: '[]' });
}

const DESIGN_CRIT: FeedEvent = {
  uid: 'crit-1',
  summary: 'Design crit',
  start: '2026-10-13T14:00:00.000Z',
  end: '2026-10-13T15:00:00.000Z',
};
const PLANNING: FeedEvent = {
  uid: 'plan-1',
  summary: 'Planning',
  start: '2026-10-13T16:00:00.000Z',
  end: '2026-10-13T16:30:00.000Z',
};

/* --------------------------------------------------------------------- sync */

describe('syncing a calendar feed', () => {
  let api: Api;
  let feeds: Awaited<ReturnType<typeof serveFeed>>;
  let alpha = 0;

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    await noFeeds();
    alpha = await makeProject('Alpha');
    freeze(at('12:00'));
    feeds = await serveFeed([DESIGN_CRIT, PLANNING]);
    const { addSource } = await calendarMod();
    addSource('Work', feeds.feed.url);
  });
  afterEach(async () => {
    mock.timers.reset();
    await feeds.close();
  });
  after(() => api.close());

  const sync = async () => (await calendarMod()).syncCalendars();
  /** Give a meeting a project through the same route the Today page uses. */
  const assign = async (eventId: string, projectId: number | null) =>
    api.call('PATCH', `/calendar/events/${encodeURIComponent(eventId)}`, { projectId });

  it('reads the feed into the calendar', async () => {
    const results = await sync();

    assert.deepEqual(
      results.map((r) => [r.ok, r.events]),
      [[true, 2]],
    );
    const events = await eventsOn('2026-10-13');
    assert.deepEqual(
      events.map((e) => [e.title, e.startsAt, e.endsAt, e.projectId]),
      [
        ['Design crit', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z', null],
        ['Planning', '2026-10-13T16:00:00.000Z', '2026-10-13T16:30:00.000Z', null],
      ],
    );
  });

  it('keeps the project a meeting was given by hand when the feed is synced again', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    const assigned = await assign(crit!.id, alpha);
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.projectId, alpha);

    await sync();

    const after = await eventsOn('2026-10-13');
    assert.equal(after.length, 2);
    const again = after.find((e) => e.title === 'Design crit');
    // Same meeting, same id, and the attribution it was given has survived.
    assert.equal(again?.id, crit!.id);
    assert.equal(again?.projectId, alpha);
    assert.equal(again?.projectName, 'Alpha');
    assert.equal(after.find((e) => e.title === 'Planning')?.projectId, null);
    // And through the API the Today page reads.
    const viaApi = (await api.call('GET', '/calendar/events?day=2026-10-13')).body;
    assert.equal(viaApi.find((e: { title: string }) => e.title === 'Design crit').projectId, alpha);
  });

  it('keeps it through any number of syncs', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);

    for (let i = 0; i < 3; i++) await sync();

    assert.equal((await eventsOn('2026-10-13'))[0]?.projectId, alpha);
  });

  it('keeps the time logged on a meeting ahead of it through a sync', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    // Logged the day before it, from its start, as Today's "Log as time spent" logs it.
    const logged = await api.call('POST', '/sessions/manual', {
      title: 'Design crit',
      startedAt: crit!.startsAt,
      minutes: 60,
      calendarEventId: crit!.id,
    });
    assert.equal(logged.status, 201);

    await sync();

    const [after] = await eventsOn('2026-10-13');
    assert.equal(after?.id, crit!.id);
    assert.equal(after?.loggedSeconds, 3600);
    assert.equal(logged.body.calendarEventId, after?.id);
  });

  it('keeps the time logged on a meeting through a sync', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    // Logged once it is over, as the prompt at its end logs it.
    goTo(DESIGN_CRIT.end);
    const logged = await api.call('POST', '/sessions/manual', {
      title: 'Design crit',
      startedAt: crit!.startsAt,
      minutes: 60,
      calendarEventId: crit!.id,
    });
    assert.equal(logged.status, 201);

    await sync();

    assert.equal((await eventsOn('2026-10-13'))[0]?.loggedSeconds, 3600);
  });

  it('updates what changed about a meeting and keeps its project', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);

    feeds.feed.set([{ ...DESIGN_CRIT, summary: 'Design critique', location: 'Room 4' }, PLANNING]);
    await sync();

    const again = (await eventsOn('2026-10-13'))[0];
    assert.equal(again?.id, crit!.id);
    assert.equal(again?.title, 'Design critique');
    assert.equal(again?.location, 'Room 4');
    assert.equal(again?.projectId, alpha);
  });

  it('removes a meeting that is no longer in the feed, and keeps the rest', async () => {
    await sync();
    assert.equal((await eventsOn('2026-10-13')).length, 2);
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);

    feeds.feed.set([DESIGN_CRIT]);
    await sync();

    const left = await eventsOn('2026-10-13');
    assert.deepEqual(
      left.map((e) => e.title),
      ['Design crit'],
    );
    assert.equal(left[0]?.projectId, alpha);
  });

  it('removes a meeting that has moved, and the new time takes the project the old one had', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);

    feeds.feed.set([
      { ...DESIGN_CRIT, start: '2026-10-13T17:00:00.000Z', end: '2026-10-13T18:00:00.000Z' },
      PLANNING,
    ]);
    await sync();

    const events = await eventsOn('2026-10-13');
    assert.deepEqual(
      events.map((e) => [e.title, e.startsAt]),
      [
        ['Planning', '2026-10-13T16:00:00.000Z'],
        ['Design crit', '2026-10-13T17:00:00.000Z'],
      ],
    );
    assert.equal(events[1]?.projectId, alpha);
  });

  it('leaves alone what is outside the window the feed is read for', async () => {
    const { db } = await dbMod();
    const { readSources } = await calendarMod();
    const provider = `ics:${readSources()[0]!.id}`;
    // Forty-one days back and fifty ahead: both past the edges of the window around now.
    for (const [uid, start] of [
      ['old', '2026-09-01T10:00:00.000Z'],
      ['far', '2026-12-01T10:00:00.000Z'],
    ] as const) {
      db.prepare(
        `INSERT INTO calendar_events (id, provider, title, starts_at, ends_at, local_day, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(`${provider}:${uid}:${start}`, provider, uid, start, start, start.slice(0, 10), start);
    }

    await sync();

    const titles = (
      db.prepare('SELECT title FROM calendar_events ORDER BY starts_at').all() as {
        title: string;
      }[]
    ).map((r) => r.title);
    assert.deepEqual(titles, ['old', 'Design crit', 'Planning', 'far']);
  });

  /** A weekly standup of two instances, 13 and 20 October, that the feed can later extend. */
  const STANDUP: FeedEvent = {
    uid: 'standup',
    summary: 'Standup',
    start: '2026-10-13T09:00:00.000Z',
    end: '2026-10-13T09:15:00.000Z',
    rrule: 'FREQ=WEEKLY;COUNT=2',
  };
  const projectsOf = async (from: string, to: string) =>
    (await eventsOn(from, to)).map((e) => [e.day, e.projectId]);

  it('gives a new instance of a series the project the series was given', async () => {
    feeds.feed.set([STANDUP]);
    await sync();
    const first = (await eventsOn('2026-10-13'))[0]!;
    await assign(first.id, alpha);

    // The series is extended: a third instance appears in the feed.
    feeds.feed.set([{ ...STANDUP, rrule: 'FREQ=WEEKLY;COUNT=3' }]);
    await sync();

    const third = (await eventsOn('2026-10-27'))[0];
    assert.equal(third?.projectId, alpha);
    assert.equal(third?.title, 'Standup');
    // The first one still has what it was given.
    assert.equal((await eventsOn('2026-10-13'))[0]?.projectId, alpha);
  });

  it('leaves the meetings that are in the calendar already as they are, however a later one was given its project', async () => {
    feeds.feed.set([STANDUP]);
    await sync();
    // The second instance is given a project by hand; the first, which is earlier, is not.
    const second = (await eventsOn('2026-10-20'))[0]!;
    await assign(second.id, alpha);

    feeds.feed.set([{ ...STANDUP, rrule: 'FREQ=WEEKLY;COUNT=3' }]);
    await sync();
    await sync();

    // Earlier meetings do not take a project from a later one, as new ones do.
    assert.deepEqual(await projectsOf('2026-10-13', '2026-10-27'), [
      ['2026-10-13', null],
      ['2026-10-20', alpha],
      ['2026-10-27', alpha],
    ]);
  });

  it('leaves a project that was taken off a meeting by hand off, when the feed is synced again', async () => {
    feeds.feed.set([{ ...STANDUP, rrule: 'FREQ=WEEKLY;COUNT=3' }]);
    await sync();
    const [one, , three] = await eventsOn('2026-10-13', '2026-10-27');
    // The project is given to the first and the last, and taken off the last by hand again.
    await assign(one!.id, alpha);
    await assign(three!.id, alpha);
    const cleared = await assign(three!.id, null);
    assert.equal(cleared.body.projectId, null);

    await sync();
    await sync();

    // It is not given back, though the first instance still has it and the series would.
    assert.deepEqual(await projectsOf('2026-10-13', '2026-10-27'), [
      ['2026-10-13', alpha],
      ['2026-10-20', null],
      ['2026-10-27', null],
    ]);
  });

  it('keeps the project each of two meetings with the same title was given by hand', async () => {
    const beta = await makeProject('Beta');
    const first: FeedEvent = { ...DESIGN_CRIT, uid: 'one-1', summary: '1:1' };
    const second: FeedEvent = {
      ...PLANNING,
      uid: 'one-2',
      summary: '1:1',
    };
    feeds.feed.set([first, second]);
    await sync();
    const [one, two] = await eventsOn('2026-10-13');
    await assign(one!.id, alpha);
    await assign(two!.id, beta);

    for (let i = 0; i < 3; i++) await sync();

    assert.deepEqual(
      (await eventsOn('2026-10-13')).map((e) => [e.title, e.projectName]),
      [
        ['1:1', 'Alpha'],
        ['1:1', 'Beta'],
      ],
    );
  });

  it('gives a new meeting the project of a meeting of the same title in the same calendar', async () => {
    const weekly: FeedEvent = { ...PLANNING, uid: 'planning-a', summary: 'Weekly planning' };
    feeds.feed.set([weekly]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

    // A meeting of the same name that is not part of the same series.
    feeds.feed.set([
      weekly,
      {
        ...weekly,
        uid: 'planning-b',
        start: '2026-10-15T16:00:00.000Z',
        end: '2026-10-15T16:30:00.000Z',
      },
    ]);
    await sync();

    assert.equal((await eventsOn('2026-10-15'))[0]?.projectId, alpha);
  });

  it('prefers the series a new meeting is part of to another of the same title', async () => {
    const beta = await makeProject('Beta');
    const adhoc: FeedEvent = {
      uid: 'sync-a',
      summary: 'Sync',
      start: '2026-10-13T15:00:00.000Z',
      end: '2026-10-13T15:30:00.000Z',
    };
    const series: FeedEvent = {
      uid: 'sync-b',
      summary: 'Sync',
      start: '2026-10-13T09:00:00.000Z',
      end: '2026-10-13T09:30:00.000Z',
      rrule: 'FREQ=WEEKLY;COUNT=1',
    };
    feeds.feed.set([adhoc, series]);
    await sync();
    const [early, late] = await eventsOn('2026-10-13');
    // The later one of the two (another meeting) is Alpha's and the series, earlier, is Beta's.
    await assign(late!.id, alpha);
    await assign(early!.id, beta);

    feeds.feed.set([adhoc, { ...series, rrule: 'FREQ=WEEKLY;COUNT=2' }]);
    await sync();

    // By title alone the latest meeting called Sync, which is Alpha's, would have been taken.
    assert.equal((await eventsOn('2026-10-20'))[0]?.projectName, 'Beta');
  });

  it('takes the project of the latest meeting of that title when meetings of the same title were given different ones', async () => {
    const beta = await makeProject('Beta');
    const named = (uid: string, day: string): FeedEvent => ({
      uid,
      summary: 'Office hours',
      start: `${day}T10:00:00.000Z`,
      end: `${day}T10:30:00.000Z`,
    });
    feeds.feed.set([named('oh-1', '2026-10-13'), named('oh-2', '2026-10-14')]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);
    await assign((await eventsOn('2026-10-14'))[0]!.id, beta);

    feeds.feed.set([
      named('oh-1', '2026-10-13'),
      named('oh-2', '2026-10-14'),
      named('oh-3', '2026-10-15'),
    ]);
    await sync();

    // Beta was given to the later of the two, so that is the one a new meeting follows.
    assert.equal((await eventsOn('2026-10-15'))[0]?.projectName, 'Beta');
  });

  /** A series given a project under one name, which the feed then renames to Sync and runs on a week. */
  async function renamedSeries(order: 'series first' | 'one-off first') {
    const series: FeedEvent = {
      uid: 'sync-s',
      summary: 'Old name',
      start: '2026-10-13T09:00:00.000Z',
      end: '2026-10-13T09:30:00.000Z',
      rrule: 'FREQ=WEEKLY;COUNT=1',
    };
    feeds.feed.set([series]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

    const renamed = { ...series, summary: 'Sync', rrule: 'FREQ=WEEKLY;COUNT=2' };
    const oneOff: FeedEvent = {
      uid: 'one-off',
      summary: 'Sync',
      start: '2026-10-15T10:00:00.000Z',
      end: '2026-10-15T10:30:00.000Z',
    };
    feeds.feed.set(order === 'series first' ? [renamed, oneOff] : [oneOff, renamed]);
    await sync();
    return projectsOf('2026-10-13', '2026-10-20');
  }

  it('gives a new meeting the project of a meeting of its title that the same sync wrote before it', async () => {
    // The series is written first: its first meeting is renamed, and its new one takes the
    // series' project, so by the time the one-off is written there are meetings called Sync.
    assert.deepEqual(await renamedSeries('series first'), [
      ['2026-10-13', alpha],
      ['2026-10-15', alpha],
      ['2026-10-20', alpha],
    ]);
  });

  it('does not give a new meeting the project of a meeting of its title that the same sync writes after it', async () => {
    assert.deepEqual(await renamedSeries('one-off first'), [
      ['2026-10-13', alpha],
      ['2026-10-15', null],
      ['2026-10-20', alpha],
    ]);
  });

  it('counts a meeting renamed by a sync for its new title, and no longer its old one, for the meetings after it', async () => {
    // A meeting on its own, given a project and then renamed: no other meeting of its series
    // brings either title with it.
    const once = (uid: string, summary: string, day: string): FeedEvent => ({
      uid,
      summary,
      start: `${day}T09:00:00.000Z`,
      end: `${day}T09:30:00.000Z`,
    });
    feeds.feed.set([once('x-1', 'Old name', '2026-10-13')]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

    feeds.feed.set([once('x-1', 'New name', '2026-10-13'), once('y-1', 'New name', '2026-10-15'), once('z-1', 'Old name', '2026-10-16')]);
    await sync();

    assert.deepEqual(
      (await eventsOn('2026-10-13', '2026-10-16')).map((e) => [e.title, e.projectId]),
      [
        ['New name', alpha],
        ['New name', alpha],
        ['Old name', null],
      ],
    );
  });

  it('does not give a new meeting the project of a meeting of the same title in another calendar', async () => {
    const other = await serveFeed([{ ...DESIGN_CRIT, uid: 'theirs-1', summary: 'Standup' }]);
    try {
      feeds.feed.set([{ ...DESIGN_CRIT, uid: 'mine-1', summary: 'Standup' }]);
      await sync();
      await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

      // Another calendar has a "Standup" of its own, and it is new.
      const { addSource } = await calendarMod();
      advance(1);
      addSource('Home', other.feed.url);
      await sync();

      const standups = (await eventsOn('2026-10-13')).map((e) => [e.calendarLabel, e.projectId]);
      assert.deepEqual(
        standups.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [
          ['Home', null],
          ['Work', alpha],
        ],
      );
    } finally {
      await other.close();
    }
  });

  it('does not give a new meeting the project of another series whose UID only begins with its own', async () => {
    // An id is the feed, the UID and the start, and a UID can have a colon in it.
    const longer: FeedEvent = { ...DESIGN_CRIT, uid: 'team:retro', summary: 'Retro' };
    feeds.feed.set([longer]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

    // A series whose UID is the first part of that one is a series of its own, and new.
    feeds.feed.set([longer, { ...PLANNING, uid: 'team', summary: 'Team sync' }]);
    await sync();

    assert.deepEqual(
      (await eventsOn('2026-10-13')).map((e) => [e.title, e.projectId]),
      [
        ['Retro', alpha],
        ['Team sync', null],
      ],
    );
  });

  it('does not give a new meeting the project of one whose title only resembles its own', async () => {
    const named = (uid: string, summary: string, day: string): FeedEvent => ({
      uid,
      summary,
      start: `${day}T10:00:00.000Z`,
      end: `${day}T10:30:00.000Z`,
    });
    feeds.feed.set([named('a-1', 'Sync A', '2026-10-13')]);
    await sync();
    await assign((await eventsOn('2026-10-13'))[0]!.id, alpha);

    // The same letters in another case, and titles a pattern would match, are other meetings.
    feeds.feed.set([
      named('a-1', 'Sync A', '2026-10-13'),
      named('a-2', 'SYNC A', '2026-10-14'),
      named('a-3', 'Sync %', '2026-10-15'),
      named('a-4', 'Sync _', '2026-10-16'),
    ]);
    await sync();

    assert.deepEqual(
      (await eventsOn('2026-10-13', '2026-10-16')).map((e) => [e.title, e.projectId]),
      [
        ['Sync A', alpha],
        ['SYNC A', null],
        ['Sync %', null],
        ['Sync _', null],
      ],
    );
  });

  it('leaves the calendar as it was when a feed cannot be read', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);
    const before = await eventsOn('2026-10-13');

    feeds.feed.status = 500;
    const results = await sync();

    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.error ?? '', /500/);
    assert.deepEqual(await eventsOn('2026-10-13'), before);
  });

  it('runs one sync at a time, however many are asked for at once', async () => {
    feeds.feed.delayMs = 60;
    const { addSource } = await calendarMod();
    advance(1); // a second feed needs an id of its own
    addSource('Home', feeds.feed.url);

    const [a, b, c] = await Promise.all([sync(), sync(), sync()]);

    // Three syncs of two feeds each, and never more than one request in flight.
    assert.equal(feeds.feed.hits, 6);
    assert.equal(feeds.feed.mostAtOnce, 1);
    for (const results of [a, b, c]) assert.equal(results.length, 2);
    assert.ok(a.every((r) => r.ok) && b.every((r) => r.ok) && c.every((r) => r.ok));
  });

  it('runs the next sync even after one failed', async () => {
    const { syncCalendars } = await calendarMod();
    feeds.feed.status = 500;
    const failed = await syncCalendars();
    assert.equal(failed[0]?.ok, false);

    feeds.feed.status = 200;
    const fine = await syncCalendars();
    assert.equal(fine[0]?.ok, true);
  });

  it('leaves the calendar, and the projects given by hand, alone when a feed answers 200 with something that is not a calendar', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);
    const before = await eventsOn('2026-09-01', '2026-12-31');
    assert.equal(before.length, 2);

    const whole = ics([DESIGN_CRIT, PLANNING]);
    const answers: [string, string, string][] = [
      [
        'an error page',
        '<!doctype html><html><body>Your session has expired.</body></html>',
        'text/html',
      ],
      ['nothing at all', '', 'text/calendar'],
      ['JSON', '{"error":"invalid token"}', 'application/json'],
      [
        'a calendar that stops short of its end',
        whole.slice(0, whole.indexOf('END:VCALENDAR')),
        'text/calendar',
      ],
      ['a calendar cut off in a meeting', whole.slice(0, whole.indexOf('DTEND')), 'text/calendar'],
      [
        'the end of a calendar that has lost its beginning',
        whole.slice(whole.indexOf('BEGIN:VEVENT')),
        'text/calendar',
      ],
    ];
    for (const [what, body, contentType] of answers) {
      feeds.feed.raw = body;
      feeds.feed.contentType = contentType;

      const results = await sync();

      assert.deepEqual(
        results.map((r) => r.ok),
        [false],
        what,
      );
      assert.match(results[0]?.error ?? '', /complete calendar/, what);
      assert.deepEqual(await eventsOn('2026-09-01', '2026-12-31'), before, what);
    }

    // Once the feed is a calendar again, the meetings and the project are as they were.
    feeds.feed.raw = null;
    assert.equal((await sync())[0]?.ok, true);
    assert.deepEqual(await eventsOn('2026-09-01', '2026-12-31'), before);
  });

  it('keeps what the window held when a feed comes back as a calendar with nothing in it', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
    await assign(crit!.id, alpha);
    const before = await eventsOn('2026-09-01', '2026-12-31');
    const warned = mock.method(console, 'warn', () => {});
    try {
      feeds.feed.set([]);

      const results = await sync();

      assert.deepEqual(
        results.map((r) => [r.ok, r.events]),
        [[true, 0]],
      );
      assert.deepEqual(await eventsOn('2026-09-01', '2026-12-31'), before);
      // It says so, naming the feed by its label and not by its address.
      assert.equal(warned.mock.callCount(), 1);
      const line = String(warned.mock.calls[0]?.arguments[0]);
      assert.match(line, /"Work"/);
      assert.ok(!line.includes('127.0.0.1'), line);

      // A feed that has some meetings again is read as usual, and removes what it no longer has.
      feeds.feed.set([DESIGN_CRIT]);
      await sync();
      assert.deepEqual(
        (await eventsOn('2026-09-01', '2026-12-31')).map((e) => [e.title, e.projectName]),
        [['Design crit', 'Alpha']],
      );
    } finally {
      warned.mock.restore();
    }
  });

  it('has nothing to keep, and says nothing, when an empty calendar comes back and the window was empty', async () => {
    const warned = mock.method(console, 'warn', () => {});
    try {
      feeds.feed.set([]);

      const results = await sync();

      assert.deepEqual(
        results.map((r) => [r.ok, r.events]),
        [[true, 0]],
      );
      assert.equal(warned.mock.callCount(), 0);
    } finally {
      warned.mock.restore();
    }
  });

  it('removes the meetings of a feed whose events are all outside the window now, as a series that has ended', async () => {
    await sync();
    assert.equal((await eventsOn('2026-09-01', '2026-12-31')).length, 2);
    // The calendar still has an event in it, years back: the meetings in the window are over,
    // which is not the empty answer that something wrong at the other end gives.
    feeds.feed.set([
      { ...DESIGN_CRIT, start: '2020-01-07T14:00:00.000Z', end: '2020-01-07T15:00:00.000Z' },
    ]);

    const results = await sync();

    assert.deepEqual(
      results.map((r) => [r.ok, r.events]),
      [[true, 0]],
    );
    assert.deepEqual(await eventsOn('2026-09-01', '2026-12-31'), []);
  });

  it('leaves out an event whose id would be too long to answer or log against', async () => {
    const warned = mock.method(console, 'warn', () => {});
    try {
      feeds.feed.set([DESIGN_CRIT, { ...PLANNING, uid: 'u'.repeat(2_100) }]);

      await sync();

      assert.deepEqual(
        (await eventsOn('2026-10-13')).map((e) => e.title),
        ['Design crit'],
      );
      assert.ok(
        warned.mock.calls.some((c) => /too long/.test(String(c.arguments[0]))),
        'it says so',
      );
    } finally {
      warned.mock.restore();
    }
  });

  it('never removes the meetings of one feed while it syncs another', async () => {
    const home = await serveFeed([{ ...PLANNING, uid: 'home-1', summary: 'Dentist' }]);
    try {
      const { addSource } = await calendarMod();
      advance(1); // a second feed needs an id of its own
      addSource('Home', home.feed.url);
      await sync();
      const dentist = (await eventsOn('2026-10-13')).find((e) => e.title === 'Dentist')!;
      await assign(dentist.id, alpha);

      // Work loses a meeting, and Home cannot be read.
      feeds.feed.set([DESIGN_CRIT]);
      home.feed.status = 500;
      const results = await sync();

      assert.deepEqual(
        results.map((r) => [r.label, r.ok]),
        [
          ['Work', true],
          ['Home', false],
        ],
      );
      assert.deepEqual(
        (await eventsOn('2026-10-13')).map((e) => [e.calendarLabel, e.title, e.projectName]),
        [
          ['Work', 'Design crit', null],
          ['Home', 'Dentist', 'Alpha'],
        ],
      );

      // And the other way about: Work cannot be read, and Home loses its meeting to another.
      feeds.feed.status = 500;
      home.feed.status = 200;
      home.feed.set([{ ...PLANNING, uid: 'home-2', summary: 'Gym' }]);
      await sync();

      assert.deepEqual(
        (await eventsOn('2026-10-13')).map((e) => [e.calendarLabel, e.title]),
        [
          ['Work', 'Design crit'],
          ['Home', 'Gym'],
        ],
      );
    } finally {
      await home.close();
    }
  });

  it('writes nothing for a feed that is removed while it is being read', async () => {
    const { readSources, removeSource } = await calendarMod();
    const [source] = readSources();
    feeds.feed.delayMs = 200;
    const syncing = sync();
    await until(() => feeds.feed.hits >= 1, 'the feed to be asked');

    removeSource(source!.id);
    const results = await syncing;

    // Nothing of it is left, and it has no result: there is no feed for one to be about.
    assert.equal(await meetingsOf(source!.id), 0);
    assert.deepEqual(results, []);
    assert.deepEqual(readSources(), []);
  });

  it('does not read a feed that was removed before its turn came', async () => {
    const home = await serveFeed([{ ...PLANNING, uid: 'home-1', summary: 'Dentist' }]);
    try {
      const { addSource, readSources, removeSource } = await calendarMod();
      advance(1); // a second feed needs an id of its own
      const second = addSource('Home', home.feed.url);
      feeds.feed.delayMs = 200;
      const syncing = sync();
      await until(() => feeds.feed.hits >= 1, 'the first feed to be asked');

      // Home is next in line, and is removed while Work is still being read.
      removeSource(second.id);
      const results = await syncing;

      assert.deepEqual(
        results.map((r) => r.label),
        ['Work'],
      );
      assert.equal(home.feed.hits, 0, 'a feed that was removed was still asked');
      assert.equal(readSources().length, 1);
    } finally {
      await home.close();
    }
  });

  it('writes nothing when the server closes just as the feed has been read', async () => {
    const { readSources, stopCalendarSyncs } = await calendarMod();
    const [source] = readSources();
    const lastSync = (await settingsMod()).getSetting('calendar_last_sync');
    // A minute on, so that a sync that was stamped would be seen to have been.
    advance(MINUTE);
    let closing: Promise<void> | undefined;
    // The whole answer arrives, and the server is closed in the moment between that and the write.
    const answering = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              closing = stopCalendarSyncs();
              controller.enqueue(new TextEncoder().encode(ics([DESIGN_CRIT, PLANNING])));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/calendar' } },
        ),
    );
    try {
      const results = await sync();
      await closing;

      assert.deepEqual(results, []);
      assert.equal(await meetingsOf(source!.id), 0);
      assert.equal((await settingsMod()).getSetting('calendar_last_sync'), lastSync);
    } finally {
      answering.mock.restore();
    }
  });

  it('writes nothing for a feed that is switched off while it is being read', async () => {
    const { readSources, updateSource } = await calendarMod();
    const [source] = readSources();
    feeds.feed.delayMs = 200;
    const syncing = sync();
    await until(() => feeds.feed.hits >= 1, 'the feed to be asked');

    updateSource(source!.id, { enabled: false });
    await syncing;

    assert.equal(await meetingsOf(source!.id), 0);
  });

  it('writes nothing from the old address of a feed whose address is changed while it is being read', async () => {
    const { readSources, updateSource } = await calendarMod();
    const [source] = readSources();
    feeds.feed.delayMs = 200;
    const syncing = sync();
    await until(() => feeds.feed.hits >= 1, 'the feed to be asked');

    updateSource(source!.id, { url: `${feeds.feed.url}?moved=1` });
    await syncing;
    assert.equal(await meetingsOf(source!.id), 0);

    // The next sync reads the new address.
    feeds.feed.delayMs = 0;
    assert.equal((await sync())[0]?.ok, true);
    assert.equal(await meetingsOf(source!.id), 2);
  });
});

/* --------------------------------------------------- logging a meeting by hand */

describe('logging a meeting as time spent', () => {
  let api: Api;

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const body = (extra: Record<string, unknown> = {}) => ({
    title: 'Design crit',
    startedAt: at('09:00'),
    minutes: 60,
    ...extra,
  });
  const sessionCount = async () => {
    const { db } = await dbMod();
    return (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  };

  it('links the block to the meeting, which then shows what was logged on it', async () => {
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });
    assert.equal((await eventsOn(at('09:00').slice(0, 10)))[0]?.loggedSeconds, 0);

    const res = await api.call('POST', '/sessions/manual', body({ calendarEventId: event }));

    assert.equal(res.status, 201);
    assert.equal(res.body.calendarEventId, event);
    assert.equal(res.body.elapsedSeconds, 3600);
    assert.equal((await eventsOn('2026-10-12'))[0]?.loggedSeconds, 3600);
  });

  it('is unchanged without a meeting: the block is linked to nothing', async () => {
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });

    for (const extra of [{}, { calendarEventId: null }]) {
      const res = await api.call('POST', '/sessions/manual', body(extra));
      assert.equal(res.status, 201);
      assert.equal(res.body.calendarEventId, null);
    }

    assert.equal((await eventsOn('2026-10-12'))[0]?.loggedSeconds, 0);
    assert.ok(event);
  });

  it('answers 400 to a meeting that is not there, and logs nothing', async () => {
    const before = await sessionCount();

    const res = await api.call(
      'POST',
      '/sessions/manual',
      body({ calendarEventId: 'ics:nope:1:2' }),
    );

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown calendar event');
    assert.equal(await sessionCount(), before);
  });

  it('refuses a meeting id that is not text, or is far too long', async () => {
    // Two thousand characters is as long as an id can be, so one more is too long.
    for (const calendarEventId of [5, ['a'], 'x'.repeat(2001)]) {
      const res = await api.call('POST', '/sessions/manual', body({ calendarEventId }));
      assert.equal(res.status, 400, JSON.stringify(calendarEventId).slice(0, 20));
    }
    assert.equal(await sessionCount(), 0);
  });

  it('starts a block on a meeting whose id is as long as an id can be, and refuses a longer one', async () => {
    const longest = 'x'.repeat(2000);

    const refused = await api.call('POST', '/sessions', {
      title: 'Design crit',
      mode: 'stopwatch',
      calendarEventId: `${longest}x`,
    });
    assert.equal(refused.status, 400);
    assert.equal(await sessionCount(), 0);

    const started = await api.call('POST', '/sessions', {
      title: 'Design crit',
      mode: 'stopwatch',
      calendarEventId: longest,
    });
    assert.equal(started.status, 201);
    assert.equal(started.body.calendarEventId, longest);
    assert.equal(await sessionCount(), 1);
  });

  it('takes the meeting through the library as well', async () => {
    const { logManualSession } = await import('../src/lib/sessions.js');
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });

    const logged = logManualSession({
      title: 'Design crit',
      startedAt: at('09:00'),
      minutes: 60,
      calendarEventId: event,
    });

    assert.equal(logged.calendarEventId, event);
    assert.throws(
      () =>
        logManualSession({
          title: 'Design crit',
          startedAt: at('09:00'),
          minutes: 60,
          calendarEventId: 'missing',
        }),
      { status: 400, message: 'Unknown calendar event' },
    );
  });

  it('refuses with a 409 a meeting that already has time logged on it, and logs nothing more', async () => {
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });
    const first = await api.call('POST', '/sessions/manual', body({ calendarEventId: event }));
    assert.equal(first.status, 201);
    const before = await sessionCount();

    const second = await api.call('POST', '/sessions/manual', body({ calendarEventId: event }));

    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'That meeting is already logged');
    assert.equal(await sessionCount(), before);
    assert.equal((await eventsOn('2026-10-12'))[0]?.loggedSeconds, 3600);
  });

  it('refuses with a 409, through the library as well, a meeting that already has time logged on it', async () => {
    const { logManualSession } = await import('../src/lib/sessions.js');
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });
    const log = () =>
      logManualSession({
        title: 'Design crit',
        startedAt: at('09:00'),
        minutes: 60,
        calendarEventId: event,
      });
    log();

    assert.throws(log, { status: 409, message: 'That meeting is already logged' });
    assert.equal(await sessionCount(), 1);
  });

  it('refuses to log by hand a meeting that the prompt logged', async () => {
    // Ended half an hour ago, so it is being asked about.
    const event = await addEvent({ title: 'Design crit', start: at('11:00'), end: at('11:30') });
    const logged = await api.call('POST', '/prompts/act', {
      id: `meeting-end:${event}`,
      action: 'log',
    });
    assert.equal(logged.status, 200);
    assert.equal(await sessionCount(), 1);

    const res = await api.call(
      'POST',
      '/sessions/manual',
      body({ startedAt: at('11:00'), minutes: 30, calendarEventId: event }),
    );

    assert.equal(res.status, 409);
    assert.equal(await sessionCount(), 1);
  });

  it('counts a block that is still on the clock as the meeting being logged', async () => {
    const { startSession } = await import('../src/lib/sessions.js');
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });
    startSession({ title: 'Taking notes', calendarEventId: event });

    const res = await api.call('POST', '/sessions/manual', body({ calendarEventId: event }));

    assert.equal(res.status, 409);
    assert.equal(await sessionCount(), 1);
  });

  it('does not count a block that was thrown away as the meeting being logged', async () => {
    const { startSession, stopSession } = await import('../src/lib/sessions.js');
    const event = await addEvent({ title: 'Design crit', start: at('09:00'), end: at('10:00') });
    const notes = startSession({ title: 'Taking notes', calendarEventId: event });
    stopSession(notes.id, 'abandoned');

    const res = await api.call('POST', '/sessions/manual', body({ calendarEventId: event }));

    assert.equal(res.status, 201);
    assert.equal(res.body.calendarEventId, event);
  });
});

/* ----------------------------------------------------------- the address of a feed */

describe('the address of a feed', () => {
  let api: Api;

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    await noFeeds();
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const add = (url: string) => api.call('POST', '/calendar/sources', { label: 'Work', url });
  const stored = async () => (await calendarMod()).readSources();

  it('is refused when it has a user name or a password in it, when a feed is added', async () => {
    for (const url of [
      'https://alice:SECRETPW@example.com/feed.ics',
      'https://alice@example.com/feed.ics',
      'https://:SECRETPW@example.com/feed.ics',
      'webcal://alice:SECRETPW@example.com/feed.ics',
      'http://alice:SECRETPW@127.0.0.1:9/feed.ics?token=SECRETTOKEN',
    ]) {
      const res = await add(url);

      assert.equal(res.status, 400, url);
      assert.match(res.body.error, /user name or password/, url);
      // The refusal does not repeat what it refuses.
      assert.ok(!JSON.stringify(res.body).includes('SECRETPW'), url);
    }
    assert.deepEqual(await stored(), []);
  });

  it('is refused when it has a user name or a password in it, when a feed is changed', async () => {
    const added = await add('https://example.com/feed.ics?token=abc');
    assert.equal(added.status, 201);

    const res = await api.call('PATCH', `/calendar/sources/${added.body.id}`, {
      url: 'https://bob:SECRETPW@example.com/other.ics',
      label: 'Renamed',
    });

    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes('SECRETPW'));
    // Nothing of the change was made, the label included.
    const [source] = await stored();
    assert.equal(source?.url, 'https://example.com/feed.ics?token=abc');
    assert.equal(source?.label, 'Work');
  });

  it('is taken as it is when it has neither', async () => {
    const res = await add('https://calendar.example.com/private/abc123/basic.ics');
    assert.equal(res.status, 201);
    assert.equal(res.body.host, 'calendar.example.com');
    assert.equal((await stored())[0]?.url, 'https://calendar.example.com/private/abc123/basic.ics');
  });

  it('takes a webcal address as the https address it stands for', async () => {
    const res = await add('webcal://example.com/cal/feed.ics?x=1');

    assert.equal(res.status, 201);
    assert.equal(res.body.host, 'example.com');
    assert.equal((await stored())[0]?.url, 'https://example.com/cal/feed.ics?x=1');
  });

  it('is refused when it is not a web address, such as an ftp address or a file', async () => {
    for (const url of ['ftp://example.com/feed.ics', 'file:///home/someone/calendar.ics']) {
      const res = await add(url);

      assert.equal(res.status, 400, url);
      assert.match(res.body.error, /https or webcal/, url);
    }
    assert.deepEqual(await stored(), []);
  });

  it('answers 400, not 500, to text that is not an address', async () => {
    const res = await add('this is not an address');

    assert.equal(res.status, 400);
    assert.deepEqual(await stored(), []);
  });

  /** What there is to be afraid of leaking: the parts of an address a calendar hands out as secrets. */
  const SECRETS = ['SECRETPW', 'SECRETTOKEN', 'http://', 'https://'];
  const leaksIn = (text: string) => SECRETS.filter((secret) => text.includes(secret));

  it('is never in a sync result or a log line, even for one that was stored with a password in it', async () => {
    const { setSettings } = await settingsMod();
    const { syncCalendars, startCalendarSync } = await calendarMod();
    // Stored before addresses like this were refused. Reading it fails, and says why.
    setSettings({
      calendar_sources: JSON.stringify([
        {
          id: 'cal_legacy',
          label: 'Work',
          url: 'http://alice:SECRETPW@127.0.0.1:9/feed.ics?token=SECRETTOKEN',
          enabled: true,
        },
      ]),
    });

    const results = await syncCalendars();
    assert.equal(results[0]?.ok, false);
    assert.deepEqual(leaksIn(JSON.stringify(results)), []);
    assert.deepEqual(leaksIn(JSON.stringify((await api.call('POST', '/calendar/sync')).body)), []);

    // The same through the look that is made in the background.
    const warned = mock.method(console, 'warn', () => {});
    const clock = handClock();
    const stop = startCalendarSync({ everyMs: 15 * MINUTE, timers: clock.timers });
    try {
      clock.tick(30_000);
      await until(() => warned.mock.callCount() > 0, 'the failure to be logged');
      const lines = warned.mock.calls.map((c) => c.arguments.map(String).join(' '));
      assert.match(lines[0] ?? '', /could not sync "Work"/);
      assert.deepEqual(leaksIn(lines.join('\n')), []);
    } finally {
      await stop();
      warned.mock.restore();
    }
  });

  it('is taken out of what is logged when the whole look fails, as well', async () => {
    const { startCalendarSync, addSource } = await calendarMod();
    addSource('Work', 'https://calendar.example.com/private/SECRETTOKEN/basic.ics');
    const logged = mock.method(console, 'error', () => {});
    const clock = handClock();
    const stop = startCalendarSync({
      everyMs: 15 * MINUTE,
      timers: clock.timers,
      sync: async () => {
        throw new Error(
          'broke while reading https://calendar.example.com/private/SECRETTOKEN/basic.ics',
        );
      },
    });
    try {
      clock.tick(30_000);
      await until(() => logged.mock.callCount() > 0, 'the failure to be logged');

      const lines = logged.mock.calls.map((c) => c.arguments.map(String).join(' '));
      assert.match(lines.join('\n'), /background sync failed/);
      assert.deepEqual(leaksIn(lines.join('\n')), []);
    } finally {
      await stop();
      logged.mock.restore();
    }
  });

  it('is taken out of whatever an error says, whatever raised it', async () => {
    const { addSource, syncCalendars } = await calendarMod();
    addSource('Work', 'https://calendar.example.com/private/SECRETTOKEN/basic.ics');
    const failing = mock.method(globalThis, 'fetch', async (input: unknown) => {
      throw new TypeError(
        `could not read ${String(input)} and then https://other.example.com/help?code=SECRETPW.`,
      );
    });
    try {
      const results = await syncCalendars();

      assert.equal(results[0]?.ok, false);
      // Both addresses are gone, and the full stop that ended the sentence is not part of one.
      assert.equal(results[0]?.error, 'could not read the feed address and then the feed address.');
    } finally {
      failing.mock.restore();
    }
  });
});

/* ---------------------------------------------------------- the background timer */

/**
 * A clock that moves only when it is told to, for the waiting the background sync does. The
 * global setTimeout is left alone on purpose: faking it would hand it to the sockets of every
 * fetch that is still closing, which clear timers of their own and can take a fake one with them.
 */
function handClock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  return {
    /** Every wait that has been asked for, in order. */
    delays,
    /** How many waits are still outstanding. */
    waiting: () => pending.size,
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = next++;
        delays.push(ms);
        pending.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout: (id: unknown) => void pending.delete(id as number),
    },
    /** Move on by `ms`, running whatever falls due as it falls due, soonest first. */
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, wait]) => wait.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
  };
}

describe('syncing in the background', () => {
  beforeEach(async () => {
    await reset();
    await noFeeds();
  });

  /** A sync that counts itself and can be held open, with no network behind it. */
  function stub() {
    const state = {
      calls: 0,
      inFlight: 0,
      mostAtOnce: 0,
      hold: false,
      fail: false,
      release: [] as (() => void)[],
    };
    const sync = (): Promise<SyncResult[]> => {
      state.calls++;
      state.inFlight++;
      state.mostAtOnce = Math.max(state.mostAtOnce, state.inFlight);
      const done = () => {
        state.inFlight--;
        if (state.fail) throw new Error('the feed fell over');
        return [] as SyncResult[];
      };
      if (!state.hold) return Promise.resolve().then(done);
      return new Promise((resolve, reject) =>
        state.release.push(() => {
          try {
            resolve(done());
          } catch (err) {
            reject(err);
          }
        }),
      );
    };
    return { state, sync };
  }

  async function withFeed() {
    const { addSource } = await calendarMod();
    return addSource('Work', 'http://127.0.0.1:9/feed.ics');
  }

  it('is off when the interval is 0', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    const clock = handClock();

    const stop = startCalendarSync({ everyMs: 0, sync, timers: clock.timers });
    clock.tick(24 * 60 * MINUTE);
    await flush();

    assert.equal(state.calls, 0);
    assert.deepEqual(clock.delays, [], 'it did not even start waiting');
    stop();
  });

  it('first looks after thirty seconds, then at every interval', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    const clock = handClock();

    const stop = startCalendarSync({ everyMs: 15 * MINUTE, sync, timers: clock.timers });
    assert.deepEqual(clock.delays, [30_000]);
    clock.tick(29_999);
    await flush();
    assert.equal(state.calls, 0);
    clock.tick(1);
    await flush();
    assert.equal(state.calls, 1);

    // Having looked, it waits a full interval.
    assert.deepEqual(clock.delays, [30_000, 15 * MINUTE]);
    clock.tick(15 * MINUTE - 1);
    await flush();
    assert.equal(state.calls, 1);
    clock.tick(1);
    await flush();
    assert.equal(state.calls, 2);
    clock.tick(15 * MINUTE);
    await flush();
    assert.equal(state.calls, 3);
    stop();
  });

  it('first looks after one interval when that is shorter than thirty seconds', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    const clock = handClock();

    const stop = startCalendarSync({ everyMs: 10_000, sync, timers: clock.timers });
    assert.deepEqual(clock.delays, [10_000]);
    clock.tick(9_999);
    await flush();
    assert.equal(state.calls, 0);
    clock.tick(1);
    await flush();
    assert.equal(state.calls, 1);
    stop();
  });

  it('can be told when to first look', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    const clock = handClock();

    const stop = startCalendarSync({
      everyMs: 15 * MINUTE,
      firstRunMs: 5_000,
      sync,
      timers: clock.timers,
    });
    clock.tick(5_000);
    await flush();

    assert.equal(state.calls, 1);
    assert.deepEqual(clock.delays, [5_000, 15 * MINUTE]);
    stop();
  });

  it('reads nothing while no feed is switched on, and starts once there is one', async () => {
    const { startCalendarSync, updateSource } = await calendarMod();
    const { state, sync } = stub();
    const clock = handClock();
    const stop = startCalendarSync({ everyMs: 15 * MINUTE, sync, timers: clock.timers });

    clock.tick(40 * MINUTE);
    await flush();
    assert.equal(state.calls, 0, 'no feed at all');
    // It keeps coming back to look, though: a feed can be added at any time.
    assert.ok(clock.waiting() > 0);

    const source = await withFeed();
    updateSource(source.id, { enabled: false });
    clock.tick(15 * MINUTE);
    await flush();
    assert.equal(state.calls, 0, 'a feed that is switched off');

    updateSource(source.id, { enabled: true });
    clock.tick(15 * MINUTE);
    await flush();
    assert.equal(state.calls, 1);
    stop();
  });

  it('never has two running, however slow the feed is', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    state.hold = true;
    const clock = handClock();

    const stop = startCalendarSync({ everyMs: 15 * MINUTE, sync, timers: clock.timers });
    clock.tick(30_000);
    await flush();
    assert.equal(state.calls, 1);

    // Hours pass with the first still open: no second one starts, and none is even waiting.
    for (let i = 0; i < 10; i++) {
      clock.tick(15 * MINUTE);
      await flush();
    }
    assert.equal(state.calls, 1);
    assert.equal(state.mostAtOnce, 1);
    assert.equal(clock.waiting(), 0);

    // The next is only set once it has finished, a full interval later.
    state.release.shift()!();
    await flush();
    assert.equal(clock.waiting(), 1);
    clock.tick(15 * MINUTE - 1);
    await flush();
    assert.equal(state.calls, 1);
    clock.tick(1);
    await flush();
    assert.equal(state.calls, 2);
    assert.equal(state.mostAtOnce, 1);
    state.release.shift()!();
    stop();
  });

  it('logs a failure and carries on', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    state.fail = true;
    const clock = handClock();
    const logged = mock.method(console, 'error', () => {});
    const warned = mock.method(console, 'warn', () => {});
    try {
      const stop = startCalendarSync({ everyMs: 15 * MINUTE, sync, timers: clock.timers });
      clock.tick(30_000);
      await flush();
      assert.equal(state.calls, 1);
      assert.equal(logged.mock.callCount(), 1);

      state.fail = false;
      clock.tick(15 * MINUTE);
      await flush();
      assert.equal(state.calls, 2);
      stop();
    } finally {
      logged.mock.restore();
      warned.mock.restore();
    }
  });

  it('says so when a feed could not be read, without failing', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const clock = handClock();
    const warned = mock.method(console, 'warn', () => {});
    try {
      let calls = 0;
      const stop = startCalendarSync({
        everyMs: 15 * MINUTE,
        timers: clock.timers,
        sync: async () => {
          calls++;
          return [
            { sourceId: 'x', label: 'Work', ok: false, events: 0, error: 'feed responded 503' },
          ];
        },
      });
      clock.tick(30_000);
      await flush();
      clock.tick(15 * MINUTE);
      await flush();

      assert.equal(calls, 2);
      assert.equal(warned.mock.callCount(), 2);
      assert.match(String(warned.mock.calls[0]?.arguments[0]), /Work.*503/);
      stop();
    } finally {
      warned.mock.restore();
    }
  });

  it('stops when told to, including a look that is already under way', async () => {
    const { startCalendarSync } = await calendarMod();
    await withFeed();
    const { state, sync } = stub();
    const clock = handClock();

    const stop = startCalendarSync({ everyMs: 15 * MINUTE, sync, timers: clock.timers });
    clock.tick(30_000);
    await flush();
    assert.equal(state.calls, 1);
    assert.equal(clock.waiting(), 1);
    stop();
    assert.equal(clock.waiting(), 0, 'the wait that was pending was cancelled');
    clock.tick(60 * MINUTE);
    await flush();
    assert.equal(state.calls, 1);

    // Stopped while a look is open: it finishes, and nothing is set after it.
    const held = stub();
    held.state.hold = true;
    const heldClock = handClock();
    const stopHeld = startCalendarSync({
      everyMs: 15 * MINUTE,
      sync: held.sync,
      timers: heldClock.timers,
    });
    heldClock.tick(30_000);
    await flush();
    assert.equal(held.state.calls, 1);
    stopHeld();
    held.state.release.shift()!();
    await flush();
    assert.equal(heldClock.waiting(), 0);
    heldClock.tick(60 * MINUTE);
    await flush();
    assert.equal(held.state.calls, 1);
  });

  describe('with the server', () => {
    let feeds: Awaited<ReturnType<typeof serveFeed>>;
    const saved = process.env.FOCUSDESK_CALENDAR_SYNC_MS;

    beforeEach(async () => {
      // These run on the real clock, so the meeting is two days from whenever they run and
      // inside the window a sync reads.
      const start = Date.now() + 2 * 86_400_000;
      feeds = await serveFeed([
        {
          ...DESIGN_CRIT,
          start: new Date(start).toISOString(),
          end: new Date(start + 3_600_000).toISOString(),
        },
      ]);
      const { addSource } = await calendarMod();
      addSource('Work', feeds.feed.url);
    });
    afterEach(async () => {
      if (saved === undefined) delete process.env.FOCUSDESK_CALENDAR_SYNC_MS;
      else process.env.FOCUSDESK_CALENDAR_SYNC_MS = saved;
      await feeds.close();
    });

    it('reads the feed on its own while the server is up, and stops when it closes', async () => {
      const { startServer } = await import('../src/app.js');
      const { db } = await dbMod();
      const running = await startServer({ port: 0, calendarSyncMs: 40 });
      try {
        await until(() => feeds.feed.hits >= 2, 'the feed to be read twice');
        const titles = db.prepare('SELECT title FROM calendar_events').all();
        assert.deepEqual(titles, [{ title: 'Design crit' }]);
      } finally {
        await running.close();
      }

      // A look that was under way when the server closed is cut short, and nothing new
      // starts after it.
      await until(() => feeds.feed.inFlight === 0, 'the last look to finish');
      await sleep(100);
      const hits = feeds.feed.hits;
      await sleep(250);
      assert.equal(feeds.feed.hits, hits, 'it kept reading after the server closed');
    });

    it('reads the interval from the environment, falling back to fifteen minutes', async () => {
      const { calendarSyncMs } = await import('../src/app.js');
      const cases: [string | undefined, number][] = [
        [undefined, 15 * MINUTE],
        ['', 15 * MINUTE],
        ['  ', 15 * MINUTE],
        ['0', 0],
        ['40', 40],
        ['60000', 60_000],
        ['1500.7', 1501],
        ['-5', 15 * MINUTE],
        ['abc', 15 * MINUTE],
        ['Infinity', 15 * MINUTE],
      ];
      for (const [value, expected] of cases) {
        if (value === undefined) delete process.env.FOCUSDESK_CALENDAR_SYNC_MS;
        else process.env.FOCUSDESK_CALENDAR_SYNC_MS = value;
        assert.equal(
          calendarSyncMs(),
          expected,
          `FOCUSDESK_CALENDAR_SYNC_MS=${JSON.stringify(value)}`,
        );
      }
    });

    it('does not read the feed at all when the interval is 0', async () => {
      const { startServer } = await import('../src/app.js');
      const running = await startServer({ port: 0, calendarSyncMs: 0 });
      try {
        await sleep(250);
        assert.equal(feeds.feed.hits, 0);
      } finally {
        await running.close();
      }
    });

    it('takes its interval from FOCUSDESK_CALENDAR_SYNC_MS, where 0 is off', async () => {
      const { startServer } = await import('../src/app.js');

      process.env.FOCUSDESK_CALENDAR_SYNC_MS = '0';
      const off = await startServer({ port: 0 });
      try {
        await sleep(250);
        assert.equal(feeds.feed.hits, 0);
      } finally {
        await off.close();
      }

      process.env.FOCUSDESK_CALENDAR_SYNC_MS = '40';
      const on = await startServer({ port: 0 });
      try {
        await until(() => feeds.feed.hits >= 1, 'the feed to be read');
      } finally {
        await on.close();
      }
    });

    it('does not let a slow feed run two syncs at once', async () => {
      const { startServer } = await import('../src/app.js');
      feeds.feed.delayMs = 120;
      const running = await startServer({ port: 0, calendarSyncMs: 20 });
      try {
        await until(() => feeds.feed.hits >= 2, 'the feed to be read twice');
      } finally {
        await running.close();
      }
      assert.equal(feeds.feed.mostAtOnce, 1);
    });

    it('cuts a read that is under way short when the server closes, and writes nothing once it has', async () => {
      const { startServer } = await import('../src/app.js');
      const { db } = await dbMod();
      const { getSetting } = await settingsMod();
      // A feed that would answer in three seconds, and a look that has started on it.
      feeds.feed.delayMs = 3_000;
      const lastSync = getSetting('calendar_last_sync');
      const running = await startServer({ port: 0, calendarSyncMs: 20 });
      await until(() => feeds.feed.hits >= 1, 'the feed to be asked');

      const started = Date.now();
      await running.close();
      const took = Date.now() - started;

      // It did not wait for the feed: the read was dropped, and the feed saw it dropped.
      assert.ok(took < 1_500, `closing took ${took} ms with the feed answering in 3000`);
      await until(() => feeds.feed.abandoned === 1, 'the feed to see the read dropped');
      assert.equal(feeds.feed.hits, 1, 'nothing new was started');
      // And nothing has been written for it, now or since.
      await sleep(100);
      assert.deepEqual(db.prepare('SELECT title FROM calendar_events').all(), []);
      assert.equal(getSetting('calendar_last_sync'), lastSync);
    });

    it('does not wait for a Sync now that is still reading when the server closes', async () => {
      const { startServer } = await import('../src/app.js');
      feeds.feed.delayMs = 3_000;
      const running = await startServer({ port: 0, calendarSyncMs: 0 });
      const click = fetch(`${running.url}/api/calendar/sync`, { method: 'POST' }).then(
        (res) => res.json() as Promise<{ results: unknown[] }>,
      );
      await until(() => feeds.feed.hits >= 1, 'the feed to be asked');

      const started = Date.now();
      await running.close();
      const took = Date.now() - started;

      assert.ok(took < 1_500, `closing took ${took} ms with the feed answering in 3000`);
      // The click is still answered, and has nothing to report of the feed that was cut short.
      assert.deepEqual((await click).results, []);
      await until(() => feeds.feed.abandoned === 1, 'the feed to see the read dropped');
    });

    /** close-child.ts in a process of its own: what it has said, and when it ended. */
    function spawnChild(mode: string, dataDir: string, feedUrl = '') {
      const env = { ...process.env };
      // Not a test of the test runner's, whatever it is run by.
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'close-child.ts', mode, dataDir, feedUrl],
        {
          cwd: path.dirname(fileURLToPath(import.meta.url)),
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
        },
      );
      const said = new Set<string>();
      let partial = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const lines = (partial + chunk.toString()).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) said.add(line.trim());
      });
      const ended = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { child, said, ended };
    }
    /** How a process ends within `ms`, or that it was still going. */
    const endsWithin = (ended: Promise<number | null>, ms: number) =>
      Promise.race([ended, sleep(ms).then(() => 'still running')]);

    it('lets a process end by itself while the background sync is started and has not been stopped', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-timer-'));
      const run = spawnChild('timer', dir);
      try {
        await until(() => run.said.has('ready'), 'the process to be set up', 30_000);

        // The first look is thirty seconds away, and the process is not waiting for it.
        assert.equal(await endsWithin(run.ended, 5_000), 0);
      } finally {
        run.child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('lets a process end promptly once the server is closed, though a feed was being read', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-close-'));
      // A feed that would answer in twenty seconds, far longer than anything here waits.
      feeds.feed.delayMs = 20_000;
      const run = spawnChild('close', dir, feeds.feed.url);
      try {
        await until(() => run.said.has('ready'), 'the process to be set up', 30_000);
        await until(() => feeds.feed.hits >= 1, 'the feed to be asked', 10_000);

        run.child.stdin.write('close\n');

        assert.equal(await endsWithin(run.ended, 5_000), 0);
        assert.ok(run.said.has('closed'));
        assert.equal(feeds.feed.abandoned, 1);
      } finally {
        run.child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
