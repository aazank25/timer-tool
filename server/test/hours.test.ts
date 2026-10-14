import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { serve } from './prompt-helpers.js';
import { freshDb } from './setup.js';

const dbMod = () => import('../src/db.js');
const stats = () => import('../src/lib/stats.js');
const settings = () => import('../src/lib/settings.js');

/*
 * The hour of an instant and the hour rollup as they were when every minute walked built a
 * formatter of its own, kept word for word to check against.
 */
function shippedLocalHour(iso: string | Date, tz: string): number {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return Number(h) % 24;
}

function shippedRollupHours(
  segments: { started_at: string; ended_at: string }[],
  zone: string,
): { hour: number; seconds: number }[] {
  const buckets = new Array<number>(24).fill(0);
  for (const seg of segments) {
    let cursor = Date.parse(seg.started_at);
    const end = Date.parse(seg.ended_at);
    while (cursor < end) {
      const hour = shippedLocalHour(new Date(cursor).toISOString(), zone);
      let boundary = Math.floor(cursor / 60_000) * 60_000 + 60_000;
      while (boundary < end && shippedLocalHour(new Date(boundary).toISOString(), zone) === hour) {
        boundary += 60_000;
      }
      const sliceEnd = Math.min(end, boundary);
      buckets[hour] = (buckets[hour] ?? 0) + Math.round((sliceEnd - cursor) / 1000);
      cursor = sliceEnd;
    }
  }
  return buckets.map((seconds, hour) => ({ hour, seconds }));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

/** The day every block here is filed under, whenever it ran: the rollup only reads its runs. */
const FILED = '2026-06-01';

/** When the clocks change in 2026, for the zones that change them. */
const CHANGES: Record<string, string[]> = {
  'America/New_York': ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z'],
  'Europe/London': ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  'Asia/Kathmandu': [],
  'Pacific/Chatham': ['2026-04-04T14:00:00Z', '2026-09-26T14:00:00Z'],
  'Australia/Lord_Howe': ['2026-04-04T15:00:00Z', '2026-10-03T15:30:00Z'],
  UTC: [],
};

/** A finished focus block made of these runs of the clock, written straight to the tables. */
async function block(runs: [number, number][]): Promise<void> {
  const { db } = await dbMod();
  const active = runs.reduce((sum, [from, to]) => sum + Math.round((to - from) / 1000), 0);
  const info = db
    .prepare(
      `INSERT INTO sessions
        (title, kind, planned_minutes, started_at, ended_at, local_day, active_seconds, status,
         created_at, updated_at)
       VALUES ('Seeded', 'focus', NULL, ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(iso(runs[0]![0]), iso(runs.at(-1)![1]), FILED, active, iso(runs[0]![0]), iso(runs[0]![0]));
  const segment = db.prepare(
    'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
  );
  for (const [from, to] of runs) segment.run(Number(info.lastInsertRowid), iso(from), iso(to));
}

describe('the hour rollup, with one formatter per zone', () => {
  before(async () => {
    await freshDb();
  });

  for (const [zone, own] of Object.entries(CHANGES)) {
    it(`spreads time across the hours of ${zone} exactly as it did, clock changes included`, async () => {
      const { db } = await dbMod();
      db.exec('DELETE FROM session_segments; DELETE FROM sessions;');
      (await settings()).setSettings({ timezone: zone });
      // A zone that never changes its clocks is walked over New York's changes all the same.
      for (const change of own.length ? own : CHANGES['America/New_York']!) {
        const at = Date.parse(change);
        // Across the change, starting and ending part of the way through a minute.
        await block([[at - 2 * HOUR - 13 * MINUTE + 17_250, at + 2 * HOUR + 41 * MINUTE]]);
        // Paused on one side of it and resumed on the other.
        await block([
          [at - 50 * MINUTE, at - 20 * MINUTE],
          [at + 5 * MINUTE, at + 35 * MINUTE + 500],
        ]);
      }
      // And an ordinary morning.
      const morning = Date.parse('2026-06-15T10:40:17.250Z');
      await block([[morning, morning + 95 * MINUTE]]);

      const runs = db
        .prepare('SELECT started_at, ended_at FROM session_segments ORDER BY id')
        .all() as { started_at: string; ended_at: string }[];
      const expected = shippedRollupHours(runs, zone);
      const { byHour } = (await stats()).dayStats(FILED);
      assert.deepEqual(byHour, expected);
      // The walk is not trivially empty: every run is in some hour.
      const total = byHour.reduce((sum, h) => sum + h.seconds, 0);
      assert.ok(total > 10 * 3600, `only ${total}s rolled up`);
    });
  }
});

describe('the hour rollup of a range with more blocks than one statement can name', () => {
  before(async () => {
    await freshDb();
    (await settings()).setSettings({ timezone: 'UTC' });
  });

  it('answers, and puts every second of every block in its hour', async () => {
    const { db } = await dbMod();
    // More blocks than the 32,766 variables SQLite takes in one statement, one every quarter
    // of an hour from the start of 2026, each a minute long.
    const count = 33_000;
    const start = Date.parse('2026-01-01T00:00:00Z');
    const session = db.prepare(
      `INSERT INTO sessions
        (title, kind, planned_minutes, started_at, ended_at, local_day, active_seconds, status,
         created_at, updated_at)
       VALUES ('Seeded', 'focus', NULL, ?, ?, ?, 60, 'completed', ?, ?)`,
    );
    const segment = db.prepare(
      'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (let n = 0; n < count; n++) {
        const from = iso(start + n * 15 * MINUTE);
        const to = iso(start + n * 15 * MINUTE + MINUTE);
        const id = Number(session.run(from, to, from.slice(0, 10), from, from).lastInsertRowid);
        segment.run(id, from, to);
      }
    })();

    const api = await serve();
    try {
      const res = await api.call('GET', '/stats/range?from=2026-01-01&to=2026-12-31');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.totalBlocks, count);
      assert.equal(res.body.totalFocusSeconds, count * 60);
      // Four blocks an hour for 343 whole days, and the last 72 blocks fill 18 more hours.
      for (const { hour, seconds } of res.body.byHour as { hour: number; seconds: number }[]) {
        assert.equal(seconds, (hour < 18 ? 344 : 343) * 4 * 60, `hour ${hour}`);
      }
    } finally {
      await api.close();
    }
  });
});
