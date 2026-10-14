import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import ical, { type VEvent } from 'node-ical';
import { at, freeze, makeProject, reset } from './prompt-helpers.js';

/*
 * How far a recurring meeting's rule is worked out, and which rules are set aside as too costly
 * to work out at all. What node-ical makes of a whole feed is what the app must make of it a
 * meeting at a time: the window the app reads is the only thing that may differ.
 */

const calendarMod = () => import('../src/lib/calendar.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

/** A calendar of the given lines. */
const calendar = (lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

/** A series: its start as written, with or without a zone, and its rule. */
const series = (uid: string, dtstart: string, rule: string, extra: string[] = []) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `SUMMARY:Series ${uid}`,
  dtstart,
  `RRULE:${rule}`,
  ...extra,
  'END:VEVENT',
];

/** The window a sync reads with the clock at noon on 12 October 2026, as parseFeed is given it. */
const WINDOW = [new Date('2026-09-21T12:00:00Z'), new Date('2026-11-26T12:00:00Z')] as const;

/** The instants node-ical puts in the window, reading the whole feed at once. */
function wholeFeed(text: string, from: Date, to: Date): string[] {
  const out: string[] = [];
  for (const entry of Object.values(ical.sync.parseICS(text))) {
    if (!entry || entry.type !== 'VEVENT') continue;
    const event = entry as VEvent;
    if (event.rrule) for (const d of event.rrule.between(from, to, true)) out.push(d.toISOString());
    else if (event.start && event.start >= from && event.start <= to) out.push(event.start.toISOString());
  }
  return out.sort();
}

async function app(text: string) {
  const events = (await calendarMod()).parseFeed(text, ...WINDOW);
  return events.map((e) => e.start.toISOString()).sort();
}

/** A feed on a loopback port, added as the calendar Work, whose text can be changed between syncs. */
async function feedOf(text: string) {
  const feed = { text };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(feed.text);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = (await calendarMod()).addSource('Work', `${base}/feed.ics`);
  return {
    feed,
    source,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function stored() {
  const { db } = await dbMod();
  return db.prepare('SELECT id, title, starts_at, project_id FROM calendar_events ORDER BY starts_at, title').all() as {
    id: string;
    title: string;
    starts_at: string;
    project_id: number | null;
  }[];
}

const sync = async () => (await calendarMod()).syncCalendars();

describe('a series that counts its dates', () => {
  beforeEach(async () => {
    await reset();
    (await settingsMod()).setSettings({ calendar_sources: '[]' });
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  // Rules whose periods do not all have a date: their count says little of when they end.
  const NY = 'DTSTART;TZID=America/New_York';
  const sparse: [string, string][] = [
    // The fifth Friday of the month: the 8th of 9 is 30 October 2026.
    [`${NY}:20250131T150000`, 'FREQ=MONTHLY;BYDAY=5FR;COUNT=9'],
    [`${NY}:20250129T150000`, 'FREQ=MONTHLY;BYDAY=5TH;COUNT=8'],
    [`${NY}:20250102T150000`, 'FREQ=MONTHLY;BYDAY=-5TH;COUNT=10'],
    // Friday the 13th.
    [`${NY}:20250613T150000`, 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=6'],
    // Only in October, or only in November, whatever the frequency.
    [`${NY}:20231002T090000`, 'FREQ=WEEKLY;BYMONTH=10;COUNT=14'],
    [`${NY}:20231101T090000`, 'FREQ=DAILY;BYMONTH=11;COUNT=100'],
    [`${NY}:20151002T090000`, 'FREQ=MONTHLY;BYMONTH=10;COUNT=15'],
    // Daily, on Mondays only: one date a week.
    ['DTSTART:20260105T090000Z', 'FREQ=DAILY;BYDAY=MO;COUNT=60'],
    // The last weekday of the month, a week and a day of the year by number.
    [`${NY}:20250131T150000`, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=22'],
    [`${NY}:20151026T090000`, 'FREQ=YEARLY;BYWEEKNO=44;BYDAY=MO;COUNT=12'],
    [`${NY}:20151027T090000`, 'FREQ=YEARLY;BYYEARDAY=300;COUNT=12'],
  ];

  for (const [dtstart, rule] of sparse) {
    it(`puts in the window what node-ical does for ${rule}`, async () => {
      const text = calendar(series('s@test', dtstart, rule));

      const whole = wholeFeed(text, ...WINDOW);
      assert.ok(whole.length > 0, 'the series has dates in the window');
      assert.deepEqual(await app(text), whole);
    });
  }

  it('reads a series of fifth Fridays the calendar has already, and keeps the project it was given', async () => {
    const alpha = await makeProject('Alpha');
    const { db } = await dbMod();
    const { close, source } = await feedOf(calendar(series('fifth@test', `${NY}:20250131T150000`, 'FREQ=MONTHLY;BYDAY=5FR;COUNT=9')));
    try {
      // What an earlier version of the app stored of it, with a project given by hand.
      const id = `ics:${source.id}:fifth@test:2026-10-30T19:00:00.000Z`;
      db.prepare(
        `INSERT INTO calendar_events (id, provider, calendar_id, title, starts_at, ends_at, all_day, local_day, project_id, synced_at)
         VALUES (?, ?, 'Work', 'Series fifth@test', '2026-10-30T19:00:00.000Z', '2026-10-30T19:30:00.000Z', 0, '2026-10-30', ?, '2026-10-01T00:00:00.000Z')`,
      ).run(id, `ics:${source.id}`, alpha);

      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 1, 0]);
      assert.deepEqual(
        (await stored()).map((e) => [e.id, e.project_id]),
        [[id, alpha]],
      );
    } finally {
      await close();
    }
  });

  it('reads a series of weekdays counted 1,500 times from 2022, which is quick to work out', async () => {
    const text = calendar(series('weekdays@test', `${NY}:20220103T090000`, 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=1500'));
    const reading = (await calendarMod()).readFeed(text, ...WINDOW);

    assert.equal(reading.skipped, 0);
    assert.deepEqual(
      reading.events.map((e) => e.start.toISOString()).sort(),
      wholeFeed(text, ...WINDOW),
    );
    assert.equal(reading.events.length, 48);
  });

  it('passes over a series whose count ended it before the window, unread', async () => {
    // Weekly ten times from 2015: over in March 2015. The rule cannot be read, and is not.
    const text = calendar([
      ...series('old@test', 'DTSTART:20150105T090000Z', 'FREQ=WEEKLY;COUNT=10;BYDAY=MO;INTERVAL=1;X-NOT-A-PART'),
      ...series('broken@test', 'DTSTART:20150105T090000Z', 'FREQ=DAILY;COUNT=20', ['DTSTART:20150106T090000Z']),
    ]);
    const reading = (await calendarMod()).readFeed(text, ...WINDOW);

    assert.deepEqual([reading.events.length, reading.skipped], [0, 0]);
  });
});

describe('a series that would take long to work out', () => {
  beforeEach(async () => {
    await reset();
    (await settingsMod()).setSettings({ calendar_sources: '[]' });
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  const values = (n: number) => Array.from({ length: n }, (_, i) => i).join(',');
  const list = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).join(',');

  it('is set aside at once, and counted, and the rest of the feed is read', async () => {
    // Every second of the first 25 of every minute of every day of the year: a few hundred bytes
    // that would hold the server for twenty seconds and more.
    const rule = `FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${values(24)};BYMINUTE=${values(60)};BYSECOND=${values(25)}`;
    const { close } = await feedOf(
      calendar([
        ...series('costly@test', 'DTSTART:20261009T090000Z', rule),
        'BEGIN:VEVENT',
        'UID:planning@test',
        'SUMMARY:Planning',
        'DTSTART:20261014T090000Z',
        'DTEND:20261014T100000Z',
        'END:VEVENT',
      ]),
    );
    try {
      const started = performance.now();
      const [result] = await sync();
      const took = performance.now() - started;

      assert.ok(took < 1_000, `the sync took ${took.toFixed(0)} ms`);
      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 1, 1]);
      assert.deepEqual(
        (await stored()).map((e) => e.title),
        ['Planning'],
      );
    } finally {
      await close();
    }
  });

  // What the engine took to work each out was measured the first time a process did so: the
  // costly ones took from 150 milliseconds to many seconds, the quick ones a few.
  const NY = 'DTSTART;TZID=America/New_York';
  const costly: [string, string][] = [
    ['DTSTART:20261009T090000Z', `FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${values(24)};BYMINUTE=${values(60)}`],
    ['DTSTART:20261009T090000Z', `FREQ=YEARLY;BYMONTHDAY=${values(31)};BYHOUR=${values(24)};BYMINUTE=${values(60)}`],
    ['DTSTART:20261009T090000Z', `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${values(24)};BYMINUTE=${values(60)}`],
    ['DTSTART:20261009T090000Z', `FREQ=DAILY;BYHOUR=${values(24)};BYMINUTE=${values(60)}`],
    ['DTSTART:20261009T090000Z', `FREQ=YEARLY;BYHOUR=${values(24)};BYMINUTE=${values(60)};BYSECOND=${values(60)}`],
    ['DTSTART:20261009T090000Z', `FREQ=HOURLY;BYMINUTE=${values(60)}`],
    [`${NY}:20200106T090000`, `FREQ=DAILY;BYHOUR=${values(24)};COUNT=100000`],
    // Counted far into the future, in a zone.
    [`${NY}:20150105T090000`, 'FREQ=YEARLY;COUNT=400'],
    [`${NY}:20190131T160000`, 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=120'],
    [`${NY}:20250131T150000`, 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=2000'],
    [`${NY}:20190131T160000`, 'FREQ=MONTHLY;BYDAY=5MO;COUNT=2000'],
    [`${NY}:20150105T090000`, 'FREQ=DAILY;COUNT=100000'],
    // Counted a day at a time from years before the window.
    [`${NY}:20150105T090000`, 'FREQ=DAILY;BYMONTH=10,11;COUNT=800'],
    ['DTSTART:20160229T170000Z', 'FREQ=DAILY;BYMONTH=10,11;COUNT=2000'],
    [`${NY}:20150105T090000`, 'FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=100000'],
    [`${NY}:20150105T090000`, `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYMONTH=${list(1, 12)};COUNT=10000`],
    ['DTSTART:20150105T140000Z', `FREQ=YEARLY;BYYEARDAY=${list(1, 366)};COUNT=10000`],
    ['DTSTART:20150105T140000Z', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,2,3,4,5;COUNT=10000'],
    // Counted far enough on that the engine counts by arithmetic only after working out
    // centuries of periods, or not at all.
    ['DTSTART:20150105T140000Z', 'FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=100000'],
    ['DTSTART:20080107T090000Z', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=0,1,2,3;COUNT=300000'],
  ];
  const quick: [string, string][] = [
    [`${NY}:20261005T090000`, 'FREQ=WEEKLY;BYDAY=MO,WE'],
    [`${NY}:20150105T090000`, 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=200'],
    [`${NY}:20150105T090000`, 'FREQ=MONTHLY;BYDAY=2TU'],
    [`${NY}:20150105T090000`, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    [`${NY}:20150105T090000`, 'FREQ=YEARLY'],
    [`${NY}:20150105T090000`, 'FREQ=YEARLY;COUNT=25'],
    [`${NY}:20150105T090000`, 'FREQ=DAILY;COUNT=5000'],
    [`${NY}:20190131T160000`, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=2000'],
    [`${NY}:20220103T090000`, 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=1500'],
    [`${NY}:20250131T150000`, 'FREQ=MONTHLY;BYDAY=5FR;COUNT=9'],
    ['DTSTART:20261009T090000Z', 'FREQ=DAILY;BYHOUR=9,17'],
    ['DTSTART:20261009T090000Z', 'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30'],
    ['DTSTART:20261009T090000Z', 'FREQ=HOURLY'],
    ['DTSTART;VALUE=DATE:20120229', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2000'],
    // Many dates a period, all counted within a few years.
    [`${NY}:20261005T090000`, 'FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=500'],
    [`${NY}:20150105T090000`, 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=500'],
    ['DTSTART;VALUE=DATE:20150105', `FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYMONTHDAY=${list(1, 31)};COUNT=10000`],
    ['DTSTART:20150105T140000Z', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,2,3,4,5,6,7,8,9,10;COUNT=10000'],
  ];
  // Calendars give a series one time of day, or a few; any more are refused, however quick.
  const manyTimes: [string, string][] = [
    ['DTSTART:20261009T090000Z', `FREQ=DAILY;BYHOUR=${values(24)}`],
    ['DTSTART:20261009T090000Z', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9,10;BYMINUTE=0,20,40'],
    ['DTSTART:20261009T090000Z', `FREQ=MONTHLY;BYDAY=2TU;BYSECOND=${values(60)};COUNT=10`],
  ];

  const named = (dtstart: string, rule: string) =>
    `${rule.length > 60 ? `${rule.slice(0, 60)}…` : rule} from ${dtstart.slice(dtstart.lastIndexOf(':') + 1)}`;
  for (const [dtstart, rule] of [...costly, ...manyTimes]) {
    it(`sets aside ${named(dtstart, rule)}`, async () => {
      assert.equal((await calendarMod()).seriesCost(dtstart, rule, ...WINDOW).setAside, true);
    });
  }
  for (const [dtstart, rule] of quick) {
    it(`works out ${named(dtstart, rule)}`, async () => {
      assert.equal((await calendarMod()).seriesCost(dtstart, rule, ...WINDOW).setAside, false);
    });
  }
});
