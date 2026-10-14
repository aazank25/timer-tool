import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { freshDb } from './setup.js';

/**
 * GET /api/stats/range works out every day of the window it is asked for, one by one, so the
 * window is checked first: real days, no more than 370 of them, counted from the two dates.
 */

/** The API on a loopback port of its own, so the route's checks are what is tested. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    /** A GET of /api/stats/range with this query, or of another path under /api. */
    get: async (query: string, path = '/stats/range') => {
      const res = await fetch(`http://127.0.0.1:${port}/api${path}${query}`);
      const text = await res.text();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, text, body: JSON.parse(text) as any };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

type Api = Awaited<ReturnType<typeof serve>>;

describe('the window /api/stats/range answers for', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  async function window(query: string) {
    const res = await api.get(query);
    assert.equal(res.status, 200, `${query}: ${res.text.slice(0, 200)}`);
    return { from: res.body.from as string, to: res.body.to as string, days: res.body.days.length };
  }

  async function refused(query: string) {
    const res = await api.get(query);
    assert.equal(res.status, 400, `${query}: ${res.text.slice(0, 200)}`);
    assert.equal(typeof res.body.error, 'string', query);
    return res.body.error as string;
  }

  it('is up to 370 days, counted from the two dates', async () => {
    // 2025-10-08 to 2026-10-12 is 370 days, the first and the last both counted.
    assert.deepEqual(await window('?from=2025-10-08&to=2026-10-12'), {
      from: '2025-10-08',
      to: '2026-10-12',
      days: 370,
    });
    assert.match(await refused('?from=2025-10-07&to=2026-10-12'), /at most 370 days/);

    // The same across a February 29th, which is one more day to count.
    assert.equal((await window('?from=2024-01-02&to=2025-01-05')).days, 370);
    assert.match(await refused('?from=2024-01-01&to=2025-01-05'), /at most 370 days/);

    // A single day is a window.
    assert.equal((await window('?from=2026-10-12&to=2026-10-12')).days, 1);
  });

  it('is refused at centuries long, before any of it is worked out', async () => {
    for (const query of [
      '?from=0000-01-01&to=9999-12-31',
      '?from=1000-01-01&to=2100-12-31',
      '?from=1970-01-01',
    ]) {
      const started = performance.now();
      const res = await api.get(query);
      const took = performance.now() - started;
      assert.equal(res.status, 400, query);
      assert.match(res.body.error, /at most 370 days/, query);
      // Working the days out took seconds and hundreds of megabytes; refusing takes neither.
      assert.ok(took < 1_000, `${query} took ${Math.round(took)} ms`);
      assert.ok(res.text.length < 200, query);
    }
  });

  it('goes back `days` from `to` when there is no `from`: 7 unless asked, 1 to 370', async () => {
    const { today } = await import('../src/lib/settings.js');
    assert.deepEqual(await window(''), {
      from: (await window('?days=7')).from,
      to: today(),
      days: 7,
    });
    assert.deepEqual(await window('?to=2026-10-12&days=30'), {
      from: '2026-09-13',
      to: '2026-10-12',
      days: 30,
    });
    // As before: an empty days is no days at all, and more than 370 is 370.
    assert.equal((await window('?to=2026-10-12&days=')).days, 7);
    assert.equal((await window('?to=2026-10-12&days=370')).days, 370);
    assert.equal((await window('?to=2026-10-12&days=371')).days, 370);
    assert.equal((await window('?to=2026-10-12&days=99999999999999999999')).days, 370);
    assert.equal((await window('?to=2026-10-12&days=0')).days, 1);
  });

  it('is refused with a 400, never a 500, when a day or a number of days is not one', async () => {
    for (const query of [
      // Not on the calendar. Date reads 2024-13-45 as Invalid Date, and 2026-02-30 as March 2nd.
      '?to=2024-13-45',
      '?to=2026-02-30',
      '?from=2026-02-30&to=2026-03-02',
      '?from=2025-12-32&to=2026-01-05',
      // Not written as a day.
      '?to=2024-1-1',
      '?to=20241001',
      '?to=2024-10-01T00:00:00Z',
      '?from=',
      '?to=',
      // Given twice, or as an object.
      '?to=2026-10-01&to=2026-10-02',
      '?from[x]=2026-10-01',
      // Not a whole number of days.
      '?days=abc',
      '?days=1.5',
      '?days=-3',
      '?days=1e2',
      '?days=0x10',
      '?days=%207',
      '?days=1&days=2',
      '?days[x]=7',
    ]) {
      await refused(query);
    }
    assert.match(await refused('?from=2026-10-12&to=2026-10-11'), /from must not be after to/);
  });

  it('does not reach back before the year 0000', async () => {
    assert.equal((await window('?to=0000-01-07')).days, 7);
    await refused('?to=0000-01-06');
  });
});

describe('the day /api/stats/day answers for', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  it('is a day on the calendar, or a 400', async () => {
    const leap = await api.get('?day=2024-02-29', '/stats/day');
    assert.equal(leap.status, 200);
    assert.equal(leap.body.day, '2024-02-29');

    // Answered for as if they were days, before: 2024-13-45, and 2026-02-30 for March 2nd.
    for (const day of ['2024-13-45', '2026-02-30', '2025-02-29', '2024-1-1', '']) {
      const res = await api.get(`?day=${day}`, '/stats/day');
      assert.equal(res.status, 400, day);
      assert.equal(typeof res.body.error, 'string', day);
    }
  });
});
