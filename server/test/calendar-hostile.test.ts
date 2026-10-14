import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import zlib from 'node:zlib';
import type { SyncResult } from '../src/lib/calendar.js';
import { at, type Api, freeze, makeProject, reset, serve } from './prompt-helpers.js';

/*
 * What a calendar feed cannot do to the server, however it is written or wherever it sends the
 * reader: the feed's host is someone else's machine, and what it answers is not to be trusted.
 */

const calendarMod = () => import('../src/lib/calendar.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

const MB = 1024 * 1024;

/** A calendar of the given lines. */
const calendar = (lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

/** A meeting, at times written as ICS UTC date-times. */
const meeting = (uid: string, summary: string, start: string, end: string, extra: string[] = []) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `SUMMARY:${summary}`,
  `DTSTART:${start}`,
  `DTEND:${end}`,
  ...extra,
  'END:VEVENT',
];

/** A meeting the day after the clock is frozen on, well inside the window a sync reads. */
const TOMORROW = meeting('good-1@test', 'Design crit', '20261013T140000Z', '20261013T150000Z');

/** A server on a loopback port that answers as `answer` says, and keeps the paths it was asked for. */
async function host(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    answer(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Send `total` bytes of padding inside a calendar, as fast as the reader takes them. */
function pour(res: http.ServerResponse, total: number) {
  res.writeHead(200, { 'content-type': 'text/calendar' });
  res.write('BEGIN:VCALENDAR\r\n');
  const chunk = Buffer.from(`X-PAD:${'A'.repeat(64 * 1024 - 9)}\r\n`);
  let sent = 0;
  const pump = () => {
    while (sent < total && !res.destroyed) {
      sent += chunk.length;
      if (!res.write(chunk)) return void res.once('drain', pump);
    }
    if (!res.destroyed) res.end('END:VCALENDAR\r\n');
  };
  pump();
}

/** Watch every request fetch makes, and still make it. */
function watchFetch() {
  const real = globalThis.fetch;
  const asked: string[] = [];
  const watching = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return real(input, init);
  });
  return { asked, restore: () => watching.mock.restore() };
}

/** Answer every fetch with a calendar, and keep what was asked for: nothing leaves the machine. */
function answerFetch(body: string) {
  const asked: URL[] = [];
  const answering = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    asked.push(new URL(String(input instanceof Request ? input.url : input)));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/calendar' } });
  });
  return { asked, restore: () => answering.mock.restore() };
}

async function noFeeds() {
  (await settingsMod()).setSettings({ calendar_sources: '[]' });
}

const sync = async (): Promise<SyncResult[]> => (await calendarMod()).syncCalendars();

async function titles() {
  const { db } = await dbMod();
  return (db.prepare('SELECT title FROM calendar_events ORDER BY starts_at, title').all() as { title: string }[]).map(
    (r) => r.title,
  );
}

/* ----------------------------------------------------------- where a feed is read from */

describe('where a feed is read from', () => {
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

  it('takes a plain http address on another machine as the https address it stands for', async () => {
    for (const url of [
      'http://calendar.example.com/private/SECRETTOKEN/basic.ics',
      'HTTP://calendar.example.com/private/SECRETTOKEN/basic.ics',
    ]) {
      const res = await add(url);
      assert.equal(res.status, 201, url);
      assert.equal(res.body.host, 'calendar.example.com');
    }
    assert.deepEqual(
      (await stored()).map((s) => s.url),
      [
        'https://calendar.example.com/private/SECRETTOKEN/basic.ics',
        'https://calendar.example.com/private/SECRETTOKEN/basic.ics',
      ],
    );
  });

  it('reads a feed added as plain http over https', async () => {
    assert.equal((await add('http://calendar.example.com/private/SECRETTOKEN/basic.ics')).status, 201);
    const feed = answerFetch(calendar(TOMORROW));
    try {
      const results = await sync();

      assert.deepEqual(
        results.map((r) => [r.ok, r.events]),
        [[true, 1]],
      );
      assert.deepEqual(
        feed.asked.map((u) => [u.protocol, u.host, u.pathname]),
        [['https:', 'calendar.example.com', '/private/SECRETTOKEN/basic.ics']],
      );
    } finally {
      feed.restore();
    }
  });

  it('reads a feed whose address was stored as plain http over https all the same', async () => {
    (await settingsMod()).setSettings({
      calendar_sources: JSON.stringify([
        { id: 'cal_old', label: 'Work', url: 'http://calendar.example.com/private/SECRETTOKEN/basic.ics', enabled: true },
      ]),
    });
    const feed = answerFetch(calendar(TOMORROW));
    try {
      const results = await sync();

      assert.equal(results[0]?.ok, true);
      assert.deepEqual(
        feed.asked.map((u) => u.protocol),
        ['https:'],
      );
    } finally {
      feed.restore();
    }
  });

  it('keeps plain http for a feed on this machine, where it crosses no network', async () => {
    for (const url of ['http://127.0.0.1:9/feed.ics', 'http://localhost:9/feed.ics', 'http://[::1]:9/feed.ics']) {
      assert.equal((await add(url)).status, 201, url);
    }
    assert.deepEqual(
      (await stored()).map((s) => s.url),
      ['http://127.0.0.1:9/feed.ics', 'http://localhost:9/feed.ics', 'http://[::1]:9/feed.ics'],
    );
  });

  it('follows a redirect to an address a feed can be read from, a relative one included', async () => {
    const feeds = await host((req, res) => {
      if (req.url === '/old.ics') {
        res.writeHead(301, { location: '/new.ics' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(calendar(TOMORROW));
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/old.ics`);

      const results = await sync();

      assert.deepEqual(
        results.map((r) => [r.ok, r.events]),
        [[true, 1]],
      );
      assert.deepEqual(feeds.asked, ['/old.ics', '/new.ics']);
      assert.deepEqual(await titles(), ['Design crit']);
    } finally {
      await feeds.close();
    }
  });

  it('refuses a redirect to plain http on another machine, and does not ask it', async () => {
    const feeds = await host((_req, res) => {
      res.writeHead(302, { location: 'http://calendar.example.com/private/SECRETTOKEN/basic.ics' });
      res.end();
    });
    const watched = watchFetch();
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);

      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /redirected to an address it cannot be read from/);
      assert.deepEqual(watched.asked, [`${feeds.base}/feed.ics`]);
    } finally {
      watched.restore();
      await feeds.close();
    }
  });

  it('refuses a redirect with a user name or a password in it', async () => {
    const feeds = await host((req, res) => {
      if (req.url === '/feed.ics') {
        res.writeHead(302, { location: `http://someone:SECRETPW@127.0.0.1:${req.socket.localPort}/other.ics` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(calendar(TOMORROW));
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);

      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /redirected to an address it cannot be read from/);
      assert.ok(!JSON.stringify(results).includes('SECRETPW'));
      assert.deepEqual(feeds.asked, ['/feed.ics']);
    } finally {
      await feeds.close();
    }
  });

  it('refuses a redirect from another machine to this one', async () => {
    const asked: string[] = [];
    const answering = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/api/settings' } });
    });
    try {
      (await calendarMod()).addSource('Work', 'https://calendar.example.com/private/SECRETTOKEN/basic.ics');

      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /redirected to an address it cannot be read from/);
      assert.equal(asked.length, 1);
    } finally {
      answering.mock.restore();
    }
  });

  /** Where a feed on another machine that redirects to `location` is read from: the addresses asked, in turn. */
  async function redirectedTo(location: string) {
    const asked: string[] = [];
    const answering = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      asked.push(String(input instanceof Request ? input.url : input));
      if (asked.length === 1) return new Response(null, { status: 302, headers: { location } });
      return new Response(calendar(TOMORROW), { status: 200, headers: { 'content-type': 'text/calendar' } });
    });
    try {
      await noFeeds();
      (await calendarMod()).addSource('Work', 'https://calendar.example.com/private/SECRETTOKEN/basic.ics');
      const [result] = await sync();
      return { result, asked };
    } finally {
      answering.mock.restore();
    }
  }

  it("refuses a redirect from another machine to this one however this machine's address is written", async () => {
    for (const location of [
      'https://127.0.0.2:9/',
      'https://127.255.255.254/feed.ics',
      'http://127.1:9/',
      'https://0x7f000001:9/',
      'https://2130706433/',
      'https://0.0.0.0:9/',
      'http://0.0.0.0:9/',
      'https://0.1.2.3/',
      'https://localhost:9/',
      'https://LOCALHOST./',
      'https://feed.localhost/',
      'https://[::]:9/',
      'https://[::1]:9/',
      'http://[0:0:0:0:0:0:0:1]:9/',
      'https://[::ffff:127.0.0.1]:9/',
      'https://[::ffff:7f00:1]:9/',
      'https://[::FFFF:7F00:0001]/',
      'https://[0:0:0:0:0:ffff:127.0.0.2]/',
      'https://[::ffff:0.0.0.0]/',
      'https://[::127.0.0.1]/',
      'https://[::7f00:1]/',
      // Not bracketed, it is not an address at all.
      'https://::1/',
      'https://::ffff:127.0.0.1/',
      '//127.0.0.2:9/feed.ics',
    ]) {
      const { result, asked } = await redirectedTo(location);

      assert.equal(result?.ok, false, location);
      assert.match(result?.error ?? '', /redirected to an address it cannot be read from/, location);
      assert.equal(asked.length, 1, location);
    }
  });

  it('follows a redirect from another machine to others, the owner\'s own network among them', async () => {
    for (const location of [
      'https://calendar.example.net/feed.ics',
      'https://128.0.0.1/feed.ics',
      'https://10.0.0.7/feed.ics',
      'https://[::ffff:8.8.8.8]/feed.ics',
      'https://[2001:db8::1]/feed.ics',
      'https://localhost.example.com/feed.ics',
    ]) {
      const { result, asked } = await redirectedTo(location);

      assert.deepEqual([result?.ok, result?.events], [true, 1], location);
      assert.equal(asked.length, 2, location);
    }
  });

  it('follows five redirects in a row, and gives up at the sixth', async () => {
    // /hop/N redirects to /hop/N-1, and /hop/0 is the calendar.
    const feeds = await host((req, res) => {
      const hop = Number(req.url?.split('/')[2] ?? 0);
      if (hop > 0) {
        res.writeHead(307, { location: `/hop/${hop - 1}` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(calendar(TOMORROW));
    });
    try {
      const { addSource, updateSource } = await calendarMod();
      const source = addSource('Work', `${feeds.base}/hop/5`);
      assert.deepEqual(
        (await sync()).map((r) => [r.ok, r.events]),
        [[true, 1]],
      );

      updateSource(source.id, { url: `${feeds.base}/hop/6` });
      feeds.asked.length = 0;
      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /redirected too many times/);
      // The first request and five redirects, and not the sixth.
      assert.equal(feeds.asked.length, 6);
    } finally {
      await feeds.close();
    }
  });
});

/* ------------------------------------------------------------- how much of a feed is read */

describe('how much of a feed is read', () => {
  beforeEach(async () => {
    await reset();
    await noFeeds();
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  it('stops reading a feed larger than 100 MB, and keeps what the calendar had', async () => {
    let flood = false;
    const feeds = await host((_req, res) => {
      if (flood) return pour(res, 101 * MB);
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(calendar(TOMORROW));
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);
      assert.equal((await sync())[0]?.ok, true);

      flood = true;
      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /larger than 100 MB/);
      assert.deepEqual(await titles(), ['Design crit']);

      // Nothing is the worse for it: the feed is read as usual once it is a calendar again.
      flood = false;
      assert.deepEqual(
        (await sync()).map((r) => [r.ok, r.events]),
        [[true, 1]],
      );
    } finally {
      await feeds.close();
    }
  });

  it('reads a work calendar exported whole, years of meetings with their guests, past ten megabytes', async () => {
    // What Google sends for every meeting: guests, the conference details and a reminder.
    const guests = Array.from({ length: 6 }, (_, k) =>
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=person${k}@example.com;X-NUM-GUESTS=0:mailto:person${k}@example.com`);
    const details = (i: number) => [
      'ORGANIZER;CN=organizer@example.com:mailto:organizer@example.com',
      ...guests,
      `DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-${i}-xyz\\nOr dial: (US) +1 555-0100 PIN: 123456789#\\n${'Agenda. '.repeat(100)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P0DT0H10M0S',
      'END:VALARM',
    ];
    const lines: string[] = [];
    for (let i = 0; i < 8_000; i++) {
      const day = new Date(Date.UTC(2020, 0, 6) + (i % 2_000) * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
      lines.push(...meeting(`past${i}@test`, `Past ${i}`, `${day}T090000Z`, `${day}T093000Z`, details(i)));
    }
    for (let i = 0; i < 20; i++) {
      const day = new Date(Date.UTC(2026, 9, 13) + i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
      lines.push(...on(`soon${i}@test`, `Soon ${i}`, day, 9, details(i)));
    }
    const text = calendar(lines);
    const feeds = await host((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(text);
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);
      assert.ok(Buffer.byteLength(text) > 12 * MB, `${Buffer.byteLength(text)} bytes`);

      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 20, 0]);
      assert.equal((await titles()).length, 20);
    } finally {
      await feeds.close();
    }
  });

  it('does not start reading a feed that says it is larger than 100 MB', async () => {
    const feeds = await host((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(101 * MB) });
      // A start, and then nothing more: a reader that waited for the rest would wait out the timeout.
      res.write('BEGIN:VCALENDAR\r\n');
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);

      const started = performance.now();
      const results = await sync();

      assert.ok(performance.now() - started < 2_000);
      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /larger than 100 MB/);
    } finally {
      await feeds.close();
    }
  });

  it('counts a compressed feed as it is once unpacked', async () => {
    // A hundred and one megabytes that compress to a tenth of one on the wire.
    const packed = zlib.gzipSync(
      Buffer.concat([Buffer.from('BEGIN:VCALENDAR\r\nX-PAD:'), Buffer.alloc(101 * MB, 'A'), Buffer.from('\r\nEND:VCALENDAR\r\n')]),
    );
    const feeds = await host((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
      res.end(packed);
    });
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/feed.ics`);
      assert.ok(packed.length < 200 * 1024);

      const results = await sync();

      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /larger than 100 MB/);
    } finally {
      await feeds.close();
    }
  });
});

/* ---------------------------------------------------------------- what an error says */

describe('what a sync says when a feed fails', () => {
  beforeEach(async () => {
    await reset();
    await noFeeds();
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  it('never repeats the address of the feed or the secret in it, whatever went wrong', async () => {
    let mode = '';
    const feeds = await host((req, res) => {
      switch (mode) {
        case 'status':
          // A reason phrase is the server's own text, and this one quotes the address.
          res.writeHead(500, `Server Error for http://127.0.0.1${req.url}`);
          return res.end('<html>SECRETTOKEN</html>');
        case 'redirect-out':
          res.writeHead(302, { location: `http://calendar.example.com${req.url}` });
          return res.end();
        case 'redirect-loop':
          res.writeHead(302, { location: req.url });
          return res.end();
        case 'flood':
          return pour(res, 101 * MB);
        default:
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>Sign in again: SECRETTOKEN</html>');
      }
    });
    const warned = mock.method(console, 'warn', () => {});
    try {
      (await calendarMod()).addSource('Work', `${feeds.base}/private/SECRETTOKEN/basic.ics`);
      const errors: string[] = [];
      for (mode of ['status', 'redirect-out', 'redirect-loop', 'flood', 'not-a-calendar']) {
        const [result] = await sync();
        assert.equal(result?.ok, false, mode);
        errors.push(result?.error ?? '');
      }

      assert.deepEqual(errors, [
        'feed responded 500',
        'The feed redirected to an address it cannot be read from',
        'The feed redirected too many times',
        'The feed is larger than 100 MB, more than a calendar is',
        'The feed did not contain a complete calendar',
      ]);
      const said = errors.join('\n') + warned.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
      for (const secret of ['SECRETTOKEN', 'http://', '127.0.0.1', '/private/']) {
        assert.ok(!said.includes(secret), secret);
      }
    } finally {
      warned.mock.restore();
      await feeds.close();
    }
  });
});

/* -------------------------------------------------------------- what a feed holds */

/** A feed on a loopback port, added as the calendar Work, whose text can be changed between syncs. */
async function feedOf(text: string) {
  const feed = { text };
  const server = await host((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(feed.text);
  });
  const source = (await calendarMod()).addSource('Work', `${server.base}/feed.ics`);
  return { feed, source, close: server.close };
}

/** The meetings the calendar holds, as [title, start] in order. */
async function stored() {
  const { db } = await dbMod();
  return db.prepare('SELECT id, title, starts_at, ends_at, location, description, attendees, project_id FROM calendar_events ORDER BY starts_at, title').all() as {
    id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    location: string | null;
    description: string | null;
    attendees: string | null;
    project_id: number | null;
  }[];
}

/** A one-hour meeting on a day of the window, at a UTC hour. */
const on = (uid: string, summary: string, day: string, hour = 14, extra: string[] = []) => {
  const h = String(hour).padStart(2, '0');
  const e = String(hour + 1).padStart(2, '0');
  return meeting(uid, summary, `${day}T${h}0000Z`, `${day}T${e}0000Z`, extra);
};

describe('a feed written to do harm', () => {
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

  /** The requests the app makes all through the day, which a corrupted server answers with 500s. */
  async function stillAnswers() {
    assert.equal((await api.call('GET', '/health')).status, 200);
    const task = await api.call('POST', '/tasks', { title: 'Write it up' });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const project = await api.call('POST', '/projects', { name: 'Client work' });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    assert.equal(project.body.description, null);
    const settings = await api.call('PATCH', '/settings', { focus_minutes: 40 });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.equal(settings.body.timezone, 'UTC');
    assert.equal((await api.call('GET', '/calendar/events?from=2026-10-01&to=2026-10-31')).status, 200);
  }

  it('cannot reach every object in the server through a meeting whose UID is __proto__', async () => {
    const { feed, close } = await feedOf(
      calendar([
        ...on('__proto__', 'Standup', '20261013', 14, [
          'STATUS:CONFIRMED',
          'DESCRIPTION:HOSTILE-DESCRIPTION',
          'LOCATION:Room 1',
          'PRIORITY:5',
          'X-origin:http://evil.example',
          'X-projectId:x',
          'timezone:Pacific/Kiritimati',
          'notifications:false',
          'X-hasOwnProperty:x',
          'X-toString:x',
        ]),
        ...on('real-1@test', 'Planning', '20261014'),
      ]),
    );
    try {
      // Twice: a feed is read at every sync.
      for (let i = 0; i < 2; i++) assert.equal((await sync())[0]?.ok, true);

      const blank = {} as Record<string, unknown>;
      for (const key of ['status', 'description', 'location', 'origin', 'projectId', 'timezone', 'notifications', 'summary', 'uid']) {
        assert.equal(blank[key], undefined, key);
      }
      assert.equal(typeof Object.prototype.hasOwnProperty, 'function');
      assert.equal(typeof Object.prototype.toString, 'function');
      await stillAnswers();
      // The meeting itself is read as any other, under the UID it gave.
      assert.deepEqual(
        (await stored()).map((e) => [e.title, e.id.split(':')[2]]),
        [
          ['Standup', '__proto__'],
          ['Planning', 'real-1@test'],
        ],
      );
      assert.equal(feed.text.length > 0, true);
    } finally {
      await close();
    }
  });

  it('cannot reach Object through a meeting whose UID is constructor', async () => {
    const { close } = await feedOf(
      calendar([
        ...on('constructor', 'Standup', '20261013', 14, ['X-keys:nope', 'X-assign:nope', 'keys:nope']),
        ...on('real-1@test', 'Planning', '20261014'),
      ]),
    );
    try {
      assert.equal((await sync())[0]?.ok, true);

      assert.equal(typeof Object.keys, 'function');
      assert.equal(typeof Object.assign, 'function');
      assert.deepEqual(Object.keys({ a: 1 }), ['a']);
      await stillAnswers();
      assert.equal((await stored()).length, 2);
    } finally {
      await close();
    }
  });

  it('reads a meeting whose UID is a name the parser keeps for the calendar itself', async () => {
    const uids = ['prototype', 'prodid', 'version', 'method', 'type', 'params', 'vcalendar', 'toString', 'valueOf', 'hasOwnProperty'];
    const { close } = await feedOf(
      calendar(['METHOD:PUBLISH', ...uids.flatMap((uid, i) => on(uid, `Meeting ${uid}`, '20261013', 8 + i)), ...on('real-1@test', 'Planning', '20261014')]),
    );
    try {
      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, uids.length + 1, 0]);
      assert.deepEqual(
        (await stored()).map((e) => e.id.split(':')[2]),
        [...uids, 'real-1@test'],
      );
    } finally {
      await close();
    }
  });

  it('cannot keep the server busy with a series that never ends, and the rest of the feed is read', async () => {
    const series = (uid: string, start: string, rule: string) => meeting(uid, `Series ${uid}`, start, start.replace(/T(\d\d)/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, '0')}`), [`RRULE:${rule}`]);
    const { close } = await feedOf(
      calendar([
        ...series('secondly', '20261011T000000Z', 'FREQ=SECONDLY'),
        ...series('daily-1000', '10000101T100000Z', 'FREQ=DAILY'),
        ...series('minutely', '20261011T000000Z', 'FREQ=MINUTELY;COUNT=200000'),
        ...series('hourly', '19960101T000000Z', 'FREQ=HOURLY'),
        ...series('weekly', '20261005T090000Z', 'FREQ=WEEKLY;COUNT=4'),
        ...on('real-1@test', 'Planning', '20261014'),
      ]),
    );
    try {
      const started = performance.now();
      const [result] = await sync();
      const took = performance.now() - started;

      assert.ok(took < 5_000, `the sync took ${took.toFixed(0)} ms`);
      assert.equal(result?.ok, true);
      const counts = new Map<string, number>();
      for (const e of await stored()) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
      // Every second, and every minute: set aside. Every hour since 1996: its first 500 in the
      // window. Every day since the year 1000: the 66 in the window. And the rest as they are.
      assert.deepEqual(Object.fromEntries(counts), {
        'Series daily-1000': 66,
        'Series hourly': 500,
        'Series weekly': 4,
        Planning: 1,
      });
      assert.equal(result?.skipped, 3);
    } finally {
      await close();
    }
  });

  it('cannot keep the server busy with hundreds of such series, ahead of the meetings that matter', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(...meeting(`s${i}@test`, 'Every second', `20261011T0000${String(i % 60).padStart(2, '0')}Z`, '20261011T010000Z', ['RRULE:FREQ=SECONDLY']));
    }
    const { close } = await feedOf(calendar([...lines, ...on('real-1@test', 'Planning', '20261014'), ...meeting('weekly@test', 'Weekly', '20261005T090000Z', '20261005T093000Z', ['RRULE:FREQ=WEEKLY'])]));
    try {
      const started = performance.now();
      const [result] = await sync();
      const took = performance.now() - started;

      assert.ok(took < 5_000, `the sync took ${took.toFixed(0)} ms`);
      assert.equal(result?.ok, true);
      assert.equal(result?.skipped, 300);
      assert.deepEqual([...new Set((await stored()).map((e) => e.title))].sort(), ['Planning', 'Weekly']);
    } finally {
      await close();
    }
  });

  it('does not work out a rule that would take seconds to, and reads the rules calendars make', async () => {
    const months = '1,2,3,4,5,6,7,8,9,10,11,12';
    const series = (uid: string, start: string, rule: string) =>
      meeting(uid, `Series ${uid}`, start, start.replace(/T(\d\d)/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, '0')}`), [`RRULE:${rule}`]);
    const { close } = await feedOf(
      calendar([
        // Counted from the year 1000, every day of every week.
        ...series('weekly-1000', '10000101T100000Z', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=1000000000'),
        // Counted from the year 1000, 144 dates a year.
        ...series('yearly-1000', '10000101T100000Z', `FREQ=YEARLY;BYMONTH=${months};BYMONTHDAY=${months};COUNT=1000000000`),
        // Counted from 1990, a day at a time.
        ...series('daily-1990', '19900105T100000Z', `FREQ=DAILY;BYMONTH=${months};COUNT=1000000000`),
        // Every second of every day, by its BY lists.
        ...series(
          'seconds',
          '20261011T000000Z',
          `FREQ=DAILY;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(',')};BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(',')};BYSECOND=${Array.from({ length: 60 }, (_, i) => i).join(',')}`,
        ),
        // What calendars make: one counted series that ended years ago, and one that runs on.
        ...series('ten-weeks-2015', '20150105T090000Z', 'FREQ=WEEKLY;COUNT=10'),
        ...series('this-year', '20260105T080000Z', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=200'),
        ...on('real-1@test', 'Planning', '20261014'),
      ]),
    );
    try {
      const started = performance.now();
      const [result] = await sync();
      const took = performance.now() - started;

      assert.ok(took < 1_000, `the sync took ${took.toFixed(0)} ms`);
      assert.equal(result?.ok, true);
      // The four are set aside; the series that ended long ago has nothing in the window, and
      // is not counted as set aside.
      assert.equal(result?.skipped, 4);
      const counts = new Map<string, number>();
      for (const e of await stored()) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
      assert.deepEqual(Object.fromEntries(counts), { 'Series this-year': 19, Planning: 1 });
    } finally {
      await close();
    }
  });

  it('refuses at once a feed that is BEGIN:VCALENDAR over and over with no end', async () => {
    const { parseFeed } = await calendarMod();
    const window = [new Date('2026-09-21T00:00:00Z'), new Date('2026-11-26T00:00:00Z')] as const;
    for (const [repeats, limitMs] of [
      [12_000, 200], // 200 KB
      [6_000_000, 1_000], // 100 MB, as much as is read of a feed
    ] as const) {
      const text = 'BEGIN:VCALENDAR\r\n'.repeat(repeats);
      const started = performance.now();
      assert.throws(() => parseFeed(text, ...window), /did not contain a complete calendar/);
      const took = performance.now() - started;
      assert.ok(took < limitMs, `${text.length} bytes took ${took.toFixed(0)} ms`);
    }
  });

  it('reads 20,000 meetings at floating times in under two seconds, and as many as a feed can hold', async () => {
    const { parseFeed } = await calendarMod();
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const day = String(13 + (i % 15)).padStart(2, '0');
      const hour = String(8 + (i % 8)).padStart(2, '0');
      // No Z and no zone: the time is wherever the meeting is.
      lines.push('BEGIN:VEVENT', `UID:f${i}@test`, `SUMMARY:Meeting ${i}`, `DTSTART:202610${day}T${hour}0000`, `DTEND:202610${day}T${hour}3000`, 'END:VEVENT');
    }
    const text = calendar(lines);

    const started = performance.now();
    const events = parseFeed(text, new Date('2026-09-21T00:00:00Z'), new Date('2026-11-26T00:00:00Z'));
    const took = performance.now() - started;

    assert.ok(took < 2_000, `20,000 meetings took ${took.toFixed(0)} ms`);
    assert.equal(events.length, 5_000);
  });
});

describe('a feed with something wrong in it', () => {
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

  it('reads the rest of a feed when one meeting of it cannot be read, and says how many could not', async () => {
    for (const bad of [
      meeting('bad@test', 'Bad rule', '20261013T090000Z', '20261013T100000Z', ['RRULE:FREQ=FOO']),
      ['BEGIN:VEVENT', 'UID:bad@test', 'SUMMARY:Twice started', 'DTSTART:20261013T090000Z', 'DTSTART:20261013T100000Z', 'END:VEVENT'],
    ]) {
      await reset();
      await noFeeds();
      const { close } = await feedOf(calendar([...on('real-1@test', 'Planning', '20261014'), ...bad]));
      try {
        const [result] = await sync();

        assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 1, 1]);
        assert.deepEqual(
          (await stored()).map((e) => e.title),
          ['Planning'],
        );
      } finally {
        await close();
      }
    }
  });

  it('reads every other meeting of a piece that has one that cannot be read', async () => {
    const good = Array.from({ length: 30 }, (_, i) => on(`m${i}@test`, `Meeting ${i}`, '20261015', 0 + (i % 20)));
    const { close } = await feedOf(
      calendar([...good.slice(0, 15).flat(), ...meeting('bad@test', 'Bad', '20261013T090000Z', '20261013T100000Z', ['RRULE:FREQ=FOO']), ...good.slice(15).flat()]),
    );
    try {
      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 30, 1]);
    } finally {
      await close();
    }
  });

  it('keeps what the calendar had of a meeting that can no longer be read', async () => {
    const alpha = await makeProject('Alpha');
    const weekly = (rule: string) => meeting('weekly@test', 'Weekly sync', '20261013T090000Z', '20261013T093000Z', [`RRULE:${rule}`]);
    const { feed, close } = await feedOf(calendar([...weekly('FREQ=WEEKLY;COUNT=3'), ...on('real-1@test', 'Planning', '20261014')]));
    try {
      await sync();
      const first = (await stored()).find((e) => e.title === 'Weekly sync')!;
      assert.equal((await api.call('PATCH', `/calendar/events/${encodeURIComponent(first.id)}`, { projectId: alpha })).status, 200);
      const before = (await stored()).filter((e) => e.title === 'Weekly sync');
      assert.equal(before.length, 3);

      // The series is broken at the other end, and Planning is gone from the feed.
      feed.text = calendar(weekly('FREQ=FOO;COUNT=3'));
      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.skipped], [true, 1]);
      // The series is as it was, project and all; the meeting that went is gone.
      assert.deepEqual(
        (await stored()).map((e) => [e.title, e.project_id]),
        before.map((e) => [e.title, e.project_id]),
      );
    } finally {
      await close();
    }
  });

  it('stores an Outlook title, place and description with a language on them as their text', async () => {
    const outlook = (uid: string, title: string, day: string) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `SUMMARY;LANGUAGE=en-US:${title}`,
      'LOCATION;LANGUAGE=en-US:Room 4',
      'DESCRIPTION;LANGUAGE=en-US:Agenda',
      `DTSTART:${day}T140000Z`,
      `DTEND:${day}T150000Z`,
      'ATTENDEE;CN=12345:mailto:numbers@example.com',
      'ATTENDEE;CN=TRUE:mailto:yes@example.com',
      'ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:plain@example.com',
      'END:VEVENT',
    ];
    const { feed, close } = await feedOf(calendar(outlook('a@test', 'Standup', '20261013')));
    try {
      await sync();
      const [standup] = await stored();
      assert.deepEqual(
        [standup?.title, standup?.location, standup?.description, JSON.parse(standup?.attendees ?? '[]')],
        ['Standup', 'Room 4', 'Agenda', ['12345', 'true', 'plain@example.com']],
      );

      // A meeting of another name does not take Standup's project: it is told apart from
      // Standup by its title, which is its text and not the object the text came in.
      const alpha = await makeProject('Alpha');
      await api.call('PATCH', `/calendar/events/${encodeURIComponent(standup!.id)}`, { projectId: alpha });
      feed.text = calendar([...outlook('a@test', 'Standup', '20261013'), ...outlook('b@test', 'Dentist', '20261014')]);
      await sync();
      assert.deepEqual(
        (await stored()).map((e) => [e.title, e.project_id]),
        [
          ['Standup', alpha],
          ['Dentist', null],
        ],
      );
    } finally {
      await close();
    }
  });

  it('cuts a title to 300 characters and the name of an attendee to 200', async () => {
    const { close } = await feedOf(
      calendar(on('long@test', 'T'.repeat(1_000_000), '20261013', 14, [`ATTENDEE;CN=${'N'.repeat(5_000)}:mailto:a@example.com`])),
    );
    try {
      await sync();
      const [long] = await stored();

      assert.equal(long?.title.length, 300);
      assert.deepEqual(JSON.parse(long?.attendees ?? '[]'), ['N'.repeat(200)]);
    } finally {
      await close();
    }
  });

  it('ends a meeting at an END with a space after it or in small letters, and reads the meetings after it', async () => {
    const { close } = await feedOf(
      calendar([
        'BEGIN:VEVENT',
        'UID:a@test',
        'SUMMARY:First',
        'DTSTART:20261013T090000Z',
        'DTEND:20261013T100000Z',
        'END:VEVENT ',
        'BEGIN:VEVENT\t',
        'UID:b@test',
        'SUMMARY:Second',
        'DTSTART:20261014T090000Z',
        'DTEND:20261014T100000Z',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'BEGIN:VALARM ',
        'ACTION:DISPLAY',
        'TRIGGER:-PT10M',
        'END:valarm',
        'END:vevent',
        'BEGIN:vevent',
        'UID:c@test',
        'SUMMARY:Third',
        'DTSTART:20261015T090000Z',
        'DTEND:20261015T100000Z',
        'END:Vevent\t ',
        ...on('d@test', 'Fourth', '20261016'),
      ]),
    );
    try {
      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 5, 0]);
      assert.deepEqual(
        (await stored()).map((e) => [e.title, e.starts_at]),
        [
          ['First', '2026-10-13T09:00:00.000Z'],
          ['Second', '2026-10-14T09:00:00.000Z'],
          ['Third', '2026-10-15T09:00:00.000Z'],
          ['Fourth', '2026-10-16T14:00:00.000Z'],
          ['Second', '2026-10-21T09:00:00.000Z'],
        ],
      );
    } finally {
      await close();
    }
  });

  it('sets aside a meeting that never ends, keeps what the calendar had of it, and reads the meetings after it', async () => {
    const first = on('a@test', 'First', '20261013');
    const second = on('b@test', 'Second', '20261014');
    const third = on('c@test', 'Third', '20261015');
    const { feed, close } = await feedOf(calendar([...first, ...second, ...third]));
    try {
      await sync();

      // Second's END is lost, so Third begins while it is still open.
      feed.text = calendar([...first, ...second.slice(0, -1), ...third]);
      const [result] = await sync();
      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 2, 1]);
      assert.deepEqual(
        (await stored()).map((e) => e.title),
        ['First', 'Second', 'Third'],
      );

      // Third's END is lost, so the calendar ends while it is still open.
      feed.text = calendar([...first, ...second, ...third.slice(0, -1)]);
      const [last] = await sync();
      assert.deepEqual([last?.ok, last?.events, last?.skipped], [true, 2, 1]);
      assert.deepEqual(
        (await stored()).map((e) => e.title),
        ['First', 'Second', 'Third'],
      );
    } finally {
      await close();
    }
  });

  it('sets aside, before reading it, a meeting with a line longer than any real one, and reads the rest at once', async () => {
    // One line of eight megabytes, of parameters that never close their quotes.
    const huge = `DTSTART${';X="'.repeat(2_000_000)}:20261013T090000Z`;
    const ten = Array.from({ length: 10 }, (_, i) => on(`m${i}@test`, `Meeting ${i}`, '20261015', 8 + i)).flat();
    const { close } = await feedOf(calendar(['BEGIN:VEVENT', 'UID:huge@test', 'SUMMARY:Huge', huge, 'END:VEVENT', ...ten]));
    try {
      const started = performance.now();
      const [result] = await sync();
      const took = performance.now() - started;

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 10, 1]);
      assert.ok(took < 1_000, `the sync took ${took.toFixed(0)} ms`);
      assert.equal((await stored()).length, 10);
    } finally {
      await close();
    }
  });

  it('cuts a description longer than any line is read to, and reads its meeting', async () => {
    const { close } = await feedOf(
      calendar([
        ...on('long@test', 'Long agenda', '20261013', 14, [`DESCRIPTION:${'Agenda\\, minutes\\n'.repeat(20_000)}`]),
        ...on('m@test', 'Planning', '20261014'),
      ]),
    );
    try {
      const [result] = await sync();

      assert.deepEqual([result?.ok, result?.events, result?.skipped], [true, 2, 0]);
      const [long] = await stored();
      assert.equal(long?.description, 'Agenda, minutes\n'.repeat(250));
    } finally {
      await close();
    }
  });

  it('reads none of a feed, and keeps all the calendar had of it, when the time runs out before it is cut into meetings', async () => {
    const alpha = await makeProject('Alpha');
    const many = Array.from({ length: 300 }, (_, i) => on(`m${i}@test`, `Meeting ${i}`, '20261015', 8 + (i % 10))).flat();
    const { feed, close } = await feedOf(calendar([...on('a@test', 'Standup', '20261013'), ...many]));
    try {
      await sync();
      const standup = (await stored()).find((e) => e.title === 'Standup')!;
      await api.call('PATCH', `/calendar/events/${encodeURIComponent(standup.id)}`, { projectId: alpha });

      // Standup is gone from the feed. The clock runs on past the time a read has while the feed
      // is being cut up, as it would on a feed far too slow to cut up.
      feed.text = calendar(many);
      const real = performance.now.bind(performance);
      const clock = mock.method(performance, 'now', () => real() + (/\bat scan\b/.test(new Error().stack ?? '') ? 60_000 : 0));
      let result: SyncResult | undefined;
      try {
        [result] = await sync();
      } finally {
        clock.mock.restore();
      }

      assert.equal(result?.ok, true);
      assert.equal(result?.events, 0);
      assert.ok((result?.skipped ?? 0) >= 1, JSON.stringify(result));
      const after = await stored();
      assert.equal(after.length, 301);
      assert.equal(after.find((e) => e.title === 'Standup')?.project_id, alpha);
    } finally {
      await close();
    }
  });

  it('logs how many meetings were set aside, and nothing of what they say', async () => {
    const { close } = await feedOf(
      calendar([
        ...meeting('bad@test', 'SECRET-TITLE', '20261013T090000Z', '20261013T100000Z', ['RRULE:FREQ=FOO', 'DESCRIPTION:SECRET-NOTES']),
        // node-ical warns of a DURATION it cannot read by quoting it.
        ['BEGIN:VEVENT', 'UID:odd@test', 'SUMMARY:Odd', 'DTSTART:20261013T110000Z', 'DURATION:SECRET-DURATION', 'END:VEVENT'],
        ...on('real-1@test', 'Planning', '20261014'),
      ].flat()),
    );
    const warned = mock.method(console, 'warn', () => {});
    try {
      const [result] = await sync();

      assert.equal(result?.skipped, 1);
      const lines = warned.mock.calls.map((c) => c.arguments.map(String).join(' '));
      assert.deepEqual(lines, [
        '[calendar] "Work" has 1 meeting(s) that could not be read, or went past what one feed can hold; what the calendar had of them is kept',
      ]);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    } finally {
      warned.mock.restore();
      await close();
    }
  });
});

/* ------------------------------------------- what a feed means, read a piece at a time */

describe('a feed read a piece at a time', () => {
  beforeEach(async () => {
    await reset();
    await noFeeds();
    freeze(at('12:00'));
  });
  afterEach(() => mock.timers.reset());

  const window = [new Date('2026-09-21T12:00:00Z'), new Date('2026-11-26T12:00:00Z')] as const;
  const read = async (lines: string[]) => (await calendarMod()).parseFeed(calendar(lines), ...window);
  const times = (events: { title: string; start: Date; end: Date }[]) =>
    events.map((e) => [e.title, e.start.toISOString(), e.end.toISOString()]);

  it('moves, renames and cancels the instances of a series that the feed says were changed', async () => {
    const events = await read([
      'BEGIN:VEVENT',
      'UID:weekly@test',
      'SUMMARY:Weekly sync',
      'DTSTART:20261006T090000Z',
      'DTEND:20261006T093000Z',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE:20261020T090000Z',
      'END:VEVENT',
      // Moved to the afternoon and renamed.
      'BEGIN:VEVENT',
      'UID:weekly@test',
      'RECURRENCE-ID:20261013T090000Z',
      'SUMMARY:Weekly sync (moved)',
      'DTSTART:20261013T150000Z',
      'DTEND:20261013T160000Z',
      'END:VEVENT',
      // A change to an instance years ago, which says nothing of the window.
      'BEGIN:VEVENT',
      'UID:weekly@test',
      'RECURRENCE-ID:20200101T090000Z',
      'SUMMARY:Long ago',
      'DTSTART:20200101T100000Z',
      'END:VEVENT',
    ]);

    assert.deepEqual(times(events), [
      ['Weekly sync', '2026-10-06T09:00:00.000Z', '2026-10-06T09:30:00.000Z'],
      ['Weekly sync (moved)', '2026-10-13T15:00:00.000Z', '2026-10-13T16:00:00.000Z'],
      ['Weekly sync', '2026-10-27T09:00:00.000Z', '2026-10-27T09:30:00.000Z'],
    ]);
  });

  it('places the instances of a series in its time zone, the changed one included', async () => {
    const events = await read([
      'BEGIN:VEVENT',
      'UID:ny@test',
      'SUMMARY:New York standup',
      'DTSTART;TZID=America/New_York:20261026T090000',
      'DTEND;TZID=America/New_York:20261026T091500',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@test',
      'RECURRENCE-ID;TZID=America/New_York:20261102T090000',
      'SUMMARY:New York standup (late)',
      'DTSTART;TZID=America/New_York:20261102T110000',
      'DTEND;TZID=America/New_York:20261102T111500',
      'END:VEVENT',
    ]);

    // New York leaves summer time on 1 November: 13:00 UTC before it, 14:00 after.
    assert.deepEqual(times(events), [
      ['New York standup', '2026-10-26T13:00:00.000Z', '2026-10-26T13:15:00.000Z'],
      ['New York standup (late)', '2026-11-02T16:00:00.000Z', '2026-11-02T16:15:00.000Z'],
      ['New York standup', '2026-11-09T14:00:00.000Z', '2026-11-09T14:15:00.000Z'],
    ]);
  });

  it('changes an instance of an all-day series by its day', async () => {
    const events = await read([
      'BEGIN:VEVENT',
      'UID:allday@test',
      'SUMMARY:On call',
      'DTSTART;VALUE=DATE:20261013',
      'DTEND;VALUE=DATE:20261014',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:allday@test',
      'RECURRENCE-ID;VALUE=DATE:20261020',
      'SUMMARY:On call (swapped)',
      'DTSTART;VALUE=DATE:20261021',
      'DTEND;VALUE=DATE:20261022',
      'END:VEVENT',
    ]);

    assert.deepEqual(times(events), [
      ['On call', '2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z'],
      ['On call (swapped)', '2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z'],
    ]);
  });

  it("reads a meeting of a series the feed does not have, as an invitation to one instance is", async () => {
    const events = await read([
      'BEGIN:VEVENT',
      'UID:theirs@test',
      'RECURRENCE-ID:20261013T090000Z',
      'SUMMARY:Their weekly, this once',
      'DTSTART:20261013T090000Z',
      'DTEND:20261013T100000Z',
      'END:VEVENT',
    ]);

    assert.deepEqual(times(events), [['Their weekly, this once', '2026-10-13T09:00:00.000Z', '2026-10-13T10:00:00.000Z']]);
  });

  it("places a time with no zone of its own by the feed's one definition of a zone, and an Outlook zone by its definition", async () => {
    const zone = (tzid: string) => [
      'BEGIN:VTIMEZONE',
      `TZID:${tzid}`,
      'BEGIN:STANDARD',
      'DTSTART:16011104T020000',
      'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010311T020000',
      'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ];
    const floating = await read([...zone('Eastern'), ...meeting('f@test', 'Floating', '20261013T100000', '20261013T110000')]);
    const outlook = await read([
      ...zone('Customized Time Zone'),
      'BEGIN:VEVENT',
      'UID:o@test',
      'SUMMARY:Outlook',
      'DTSTART;TZID="Customized Time Zone":20261013T100000',
      'DTEND;TZID="Customized Time Zone":20261013T110000',
      'END:VEVENT',
    ]);

    // Ten in the morning in summer, four hours behind UTC.
    assert.deepEqual(times(floating), [['Floating', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z']]);
    assert.deepEqual(times(outlook), [['Outlook', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z']]);
  });

  it('passes over the years of meetings before the window, and reads the meetings in it', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 3_000; i++) {
      const day = new Date(Date.UTC(2016, 0, 1) + i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
      lines.push(...meeting(`old${i}@test`, 'Long ago', `${day}T090000Z`, `${day}T100000Z`));
    }
    const events = await read([...lines, ...meeting('soon@test', 'Soon', '20261013T090000Z', '20261013T100000Z')]);

    assert.deepEqual(times(events), [['Soon', '2026-10-13T09:00:00.000Z', '2026-10-13T10:00:00.000Z']]);
  });
});

/** Wait, in real time, for a condition. */
async function until(condition: () => boolean, what: string, limitMs = 5_000) {
  for (let waited = 0; waited < limitMs; waited += 10) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
void until;
