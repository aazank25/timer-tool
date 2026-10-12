import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { SyncResult } from '../src/lib/calendar.js';
import {
  addEvent,
  advance,
  at,
  type Api,
  freeze,
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
    delayMs: 0,
    status: 200,
    set: (events: FeedEvent[]) => {
      body = ics(events);
    },
  };
  const server = http.createServer((_req, res) => {
    feed.hits++;
    feed.inFlight++;
    feed.mostAtOnce = Math.max(feed.mostAtOnce, feed.inFlight);
    setTimeout(() => {
      res.statusCode = feed.status;
      res.setHeader('content-type', 'text/calendar');
      res.end(body);
      feed.inFlight--;
    }, feed.delayMs);
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

  it('keeps the time logged on a meeting through a sync', async () => {
    await sync();
    const [crit] = await eventsOn('2026-10-13');
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

  it('gives later instances of a series the project it was given, and keeps it on the one that has it', async () => {
    const series: FeedEvent = {
      uid: 'standup',
      summary: 'Standup',
      start: '2026-10-13T09:00:00.000Z',
      end: '2026-10-13T09:15:00.000Z',
      rrule: 'FREQ=WEEKLY;COUNT=2',
    };
    feeds.feed.set([series]);
    await sync();
    const first = (await eventsOn('2026-10-13'))[0]!;
    await assign(first.id, alpha);

    // The series is extended: a third instance appears in the feed.
    feeds.feed.set([{ ...series, rrule: 'FREQ=WEEKLY;COUNT=3' }]);
    await sync();

    const all = await eventsOn('2026-10-13', '2026-10-27');
    assert.deepEqual(
      all.map((e) => [e.day, e.projectId]),
      [
        ['2026-10-13', alpha],
        ['2026-10-20', alpha],
        ['2026-10-27', alpha],
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
    for (const calendarEventId of [5, ['a'], 'x'.repeat(301)]) {
      const res = await api.call('POST', '/sessions/manual', body({ calendarEventId }));
      assert.equal(res.status, 400, JSON.stringify(calendarEventId).slice(0, 20));
    }
    assert.equal(await sessionCount(), 0);
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

    /** Wait, in real time, for a condition: these tests run the real timer on a short interval. */
    async function until(condition: () => boolean, what: string) {
      for (let waited = 0; waited < 5_000; waited += 10) {
        if (condition()) return;
        await sleep(10);
      }
      assert.fail(`timed out waiting for ${what}`);
    }

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

      // A look that was already under way when the server closed is let finish; nothing
      // new starts after it.
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
  });
});
