import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAwayTracker } from '../away.mjs';

/** Ten o'clock on a Monday, and minutes after it: nothing here is about what day it is. */
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const min = (n) => T0 + n * 60_000;
const iso = (ms) => new Date(ms).toISOString();

const FOCUS = { id: 7, kind: 'focus', status: 'running' };

/**
 * A tracker over a clock and an idle time that the test sets, and a server that remembers what it
 * was told. The clock starts a day on, so that no report is cut short by it; a test about that
 * sets it where it wants it.
 */
function setup(over = {}) {
  const world = {
    now: T0 + 24 * 60 * 60_000,
    idle: 0,
    live: FOCUS,
    settings: { away_minutes: '10' },
    failWith: null,
    ...over,
  };
  const reports = [];
  const logs = [];
  const tracker = createAwayTracker({
    now: () => world.now,
    getIdleSeconds: () => {
      if (world.idle instanceof Error) throw world.idle;
      return world.idle;
    },
    getLive: () => world.live,
    getSettings: () => {
      if (world.settings instanceof Error) throw world.settings;
      return world.settings;
    },
    report: (stretch) => {
      reports.push(stretch);
      if (world.failWith) throw world.failWith;
      return Promise.resolve();
    },
    log: (...args) => logs.push(args),
  });
  return { world, reports, logs, tracker };
}

/** What the server is told about a stretch of block 7. */
const told = (from, to, sessionId = 7) => ({
  sessionId,
  startedAt: iso(from),
  endedAt: iso(to),
});

describe('the screen locking', () => {
  it('reports a stretch of at least away_minutes with a focus block running, from lock to unlock', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    assert.deepEqual(reports, [], 'nothing is reported while it is going on');
    await tracker.onUnlock(min(12));

    assert.deepEqual(reports, [told(min(0), min(12))]);
  });

  it('takes the time from the clock when the event does not say when', async () => {
    const { world, tracker, reports } = setup();

    world.now = min(5);
    tracker.onLock();
    world.now = min(25);
    await tracker.onUnlock();

    assert.deepEqual(reports, [told(min(5), min(25))]);
  });

  it('does not report a stretch shorter than away_minutes, and reports one that is exactly as long', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    await tracker.onUnlock(min(9.99));
    assert.deepEqual(reports, [], 'a second short');

    tracker.onLock(min(20));
    await tracker.onUnlock(min(30));
    assert.deepEqual(reports, [told(min(20), min(30))], 'exactly ten minutes');
  });

  it('follows away_minutes as it is when the stretch ends', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));

    world.settings = { away_minutes: '30' };
    await tracker.onUnlock(min(20));
    assert.deepEqual(reports, [], 'twenty minutes is not enough for thirty');

    tracker.onLock(min(40));
    world.settings = { away_minutes: 5 };
    await tracker.onUnlock(min(46));
    assert.deepEqual(reports, [told(min(40), min(46))], 'and is plenty for five, given as a number');
  });

  it('reports nothing when away_minutes is 0, which is off', async () => {
    const { tracker, reports } = setup({ settings: { away_minutes: '0' } });

    tracker.onLock(min(0));
    await tracker.onUnlock(min(120));

    assert.deepEqual(reports, []);
  });

  it('reports nothing when the settings are not known, or cannot be read, or say nothing sensible', async () => {
    for (const settings of [null, undefined, {}, { away_minutes: 'soon' }, { away_minutes: -5 }]) {
      const { tracker, reports } = setup({ settings });
      tracker.onLock(min(0));
      await tracker.onUnlock(min(60));
      assert.deepEqual(reports, [], JSON.stringify(settings));
    }

    const { tracker, reports, logs } = setup({ settings: new Error('no settings') });
    tracker.onLock(min(0));
    await tracker.onUnlock(min(60));
    assert.deepEqual(reports, []);
    assert.equal(logs.length, 1);
  });

  it('reports nothing when no block was running as it began', async () => {
    for (const live of [null, undefined]) {
      const { tracker, reports } = setup({ live });
      tracker.onLock(min(0));
      await tracker.onUnlock(min(30));
      assert.deepEqual(reports, [], String(live));
    }
  });

  it('reports nothing for a paused block, which was not running up the clock', async () => {
    const { tracker, reports } = setup({ live: { ...FOCUS, status: 'paused' } });

    tracker.onLock(min(0));
    await tracker.onUnlock(min(30));

    assert.deepEqual(reports, []);
  });

  it('reports nothing for a break: it is not time to keep or drop from a block', async () => {
    const { tracker, reports } = setup({ live: { id: 8, kind: 'break', status: 'running' } });

    tracker.onLock(min(0));
    await tracker.onUnlock(min(30));

    assert.deepEqual(reports, []);
  });

  it('goes by the block that was running as it began, not the one at the end', async () => {
    const { world, tracker, reports } = setup();

    tracker.onLock(min(0));
    // Another block is on the clock by the time it is over.
    world.live = { id: 9, kind: 'focus', status: 'running' };
    await tracker.onUnlock(min(30));
    assert.deepEqual(reports, [told(min(0), min(30), 7)]);

    // And a block that was not running as it began is not one it is reported against.
    world.live = null;
    tracker.onLock(min(40));
    world.live = FOCUS;
    await tracker.onUnlock(min(80));
    assert.deepEqual(reports, [told(min(0), min(30), 7)]);
  });

  it('is one stretch however many times the lock and the unlock are seen, from the first lock', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    tracker.onLock(min(3));
    await tracker.onUnlock(min(15));
    await tracker.onUnlock(min(16));

    assert.deepEqual(reports, [told(min(0), min(15))]);
  });

  it('does nothing about an unlock with no lock before it', async () => {
    const { tracker, reports } = setup();

    await tracker.onUnlock(min(30));

    assert.deepEqual(reports, []);
    assert.equal(tracker.state().away, false);
  });

  it('starts a new stretch after one has ended', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    await tracker.onUnlock(min(15));
    tracker.onLock(min(30));
    await tracker.onUnlock(min(50));

    assert.deepEqual(reports, [told(min(0), min(15)), told(min(30), min(50))]);
  });

  it('does not report in the future: the end is no later than now', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(12);

    tracker.onLock(min(0));
    await tracker.onUnlock(min(100));

    assert.deepEqual(reports, [told(min(0), min(12))]);
  });
});

describe('the machine sleeping', () => {
  it('is one stretch from the lock to the unlock when it sleeps in between, and not three', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    tracker.onSuspend(min(2));
    await tracker.onResume(min(40));
    assert.deepEqual(reports, [], 'waking up is not coming back while the screen is still locked');
    assert.equal(tracker.state().away, true);
    await tracker.onUnlock(min(45));

    assert.deepEqual(reports, [told(min(0), min(45))]);
  });

  it('is over at wake-up when the screen is not locked', async () => {
    const { tracker, reports } = setup();

    tracker.onSuspend(min(0));
    await tracker.onResume(min(60));

    assert.deepEqual(reports, [told(min(0), min(60))]);
  });

  it('is over at wake-up only once the unlock has been seen too, whichever came first', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    tracker.onSuspend(min(2));
    await tracker.onUnlock(min(30));
    assert.deepEqual(reports, [], 'unlocked, but the machine is still asleep');
    await tracker.onResume(min(31));

    assert.deepEqual(reports, [told(min(0), min(31))]);
  });

  it('begins at the sleep when there was no lock, and keeps the earlier start when there was', async () => {
    const { tracker, reports } = setup();

    tracker.onSuspend(min(5));
    tracker.onLock(min(6));
    await tracker.onResume(min(20));
    await tracker.onUnlock(min(22));

    assert.deepEqual(reports, [told(min(5), min(22))]);
  });

  it('does not report a short sleep', async () => {
    const { tracker, reports } = setup();

    tracker.onSuspend(min(0));
    await tracker.onResume(min(3));

    assert.deepEqual(reports, []);
  });

  it('does nothing about a wake-up with no sleep before it', async () => {
    const { tracker, reports } = setup();

    await tracker.onResume(min(30));

    assert.deepEqual(reports, []);
    assert.equal(tracker.state().away, false);
  });
});

describe('another user taking over the Mac', () => {
  it('is a stretch from the one session leaving to it coming back', async () => {
    const { tracker, reports } = setup();

    tracker.onResignActive(min(0));
    assert.equal(tracker.state().switched, true);
    await tracker.onBecomeActive(min(20));

    assert.deepEqual(reports, [told(min(0), min(20))]);
  });

  it('is not over while the screen is still locked', async () => {
    const { tracker, reports } = setup();

    tracker.onResignActive(min(0));
    tracker.onLock(min(1));
    await tracker.onBecomeActive(min(20));
    assert.deepEqual(reports, []);
    await tracker.onUnlock(min(22));

    assert.deepEqual(reports, [told(min(0), min(22))]);
  });
});

describe('being idle', () => {
  it('does not begin below the threshold', async () => {
    const { world, tracker } = setup();
    world.now = min(30);

    world.idle = 599;
    await tracker.tick();

    assert.equal(tracker.state().away, false);
  });

  it('begins at the threshold, at the last input and not at the moment it is noticed', async () => {
    const { world, tracker } = setup();
    world.now = min(30);
    world.idle = 600;

    await tracker.tick();

    assert.deepEqual(tracker.state(), {
      away: true,
      since: min(20),
      sessionId: 7,
      locked: false,
      suspended: false,
      switched: false,
      idle: true,
    });
  });

  it('ends at the first input, which is where it ended, not when it is noticed', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();

    // Fifteen seconds on, the machine says it was last touched five seconds ago.
    world.now = min(30) + 15_000;
    world.idle = 5;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(30) + 10_000)]);
    assert.equal(tracker.state().away, false);
  });

  it('goes on while the machine stays untouched, however many times it is looked at', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();

    for (let n = 1; n <= 8; n++) {
      world.now = min(30) + n * 15_000;
      world.idle = 600 + n * 15;
      await tracker.tick();
    }

    assert.deepEqual(reports, []);
    assert.equal(tracker.state().since, min(20), 'the start has not moved');
  });

  it('is not fooled by an idle time that is a second short of the time since it began', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();

    // Whole seconds are read a moment late: 614 s idle for 615 s of waiting is still no input.
    world.now = min(30) + 15_000;
    world.idle = 614;
    await tracker.tick();

    assert.deepEqual(reports, []);
    assert.equal(tracker.state().idle, true);
  });

  it('is reported only when a focus block was running as it began', async () => {
    for (const live of [null, { ...FOCUS, status: 'paused' }, { id: 8, kind: 'break', status: 'running' }]) {
      const { world, tracker, reports } = setup({ live });
      world.now = min(30);
      world.idle = 600;
      await tracker.tick();
      world.now = min(40);
      world.idle = 2;
      await tracker.tick();
      assert.deepEqual(reports, [], JSON.stringify(live));
    }
  });

  it('is not looked for when away_minutes is 0', async () => {
    const { world, tracker, reports } = setup({ settings: { away_minutes: '0' } });
    world.now = min(300);
    world.idle = 100_000;

    await tracker.tick();

    assert.equal(tracker.state().away, false);
    assert.deepEqual(reports, []);
  });

  it('follows the threshold in the settings', async () => {
    const { world, tracker } = setup({ settings: { away_minutes: '3' } });
    world.now = min(30);

    world.idle = 179;
    await tracker.tick();
    assert.equal(tracker.state().away, false);

    world.idle = 180;
    await tracker.tick();
    assert.equal(tracker.state().since, min(27));
  });

  it('does not begin a second stretch inside the one that a lock began', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));

    // Locked for a quarter of an hour, so the machine has been untouched for as long.
    world.now = min(15);
    world.idle = 900;
    await tracker.tick();
    assert.equal(tracker.state().since, min(0));
    assert.equal(tracker.state().idle, false, 'the lock is the reason, not the idle time');
    world.now = min(16);
    await tracker.onUnlock();

    assert.deepEqual(reports, [told(min(0), min(16))]);
  });

  it('is one stretch with the lock that came in the middle of it, from the first input after the unlock', async () => {
    const { world, tracker, reports } = setup();
    // Untouched since 20 minutes past, noticed at half past.
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();
    tracker.onLock(min(35));
    await tracker.onUnlock(min(60));
    assert.deepEqual(reports, [], 'the machine has not been touched since the unlock was seen, as far as it has been asked');

    // The next look: the unlock was typed at five seconds ago.
    world.now = min(60) + 10_000;
    world.idle = 5;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(60) + 5_000)]);
  });

  it('is over at the unlock at the earliest, even if the machine says its last input was before that', async () => {
    const { world, tracker, reports } = setup();
    // Untouched since 20 minutes past, noticed at half past, and locked at 35.
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();
    tracker.onLock(min(35));
    // Unlocked with a fingerprint, which is not input: the machine still counts from long before.
    await tracker.onUnlock(min(60));

    world.now = min(60) + 10_000;
    world.idle = 40;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(60))]);
  });

  it('takes an idle time it cannot read, while it is already away, as input: back now', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();

    world.now = min(45);
    world.idle = Number.NaN;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(45))]);
    assert.equal(tracker.state().away, false);
  });

  it('reads an idle time that cannot be read, or is not a number, as none', async () => {
    for (const idle of [new Error('not on this platform'), Number.NaN, undefined, -3]) {
      const { world, tracker } = setup();
      world.now = min(30);
      world.idle = idle;
      await tracker.tick();
      assert.equal(tracker.state().away, false, String(idle));
    }
  });
});

describe('reporting', () => {
  it('swallows a report that the server refuses, however it is refused, and carries on', async () => {
    const refusals = [
      Object.assign(new Error('That block was discarded'), { status: 400 }),
      Object.assign(new Error('Session not found'), { status: 404 }),
      Object.assign(new Error('Internal error'), { status: 500 }),
      new TypeError('fetch failed'),
    ];
    for (const failWith of refusals) {
      const { world, tracker, reports, logs } = setup({ failWith });

      tracker.onLock(min(0));
      await assert.doesNotReject(tracker.onUnlock(min(20)), failWith.message);

      assert.equal(reports.length, 1, failWith.message);
      assert.equal(logs.length, 1, 'it is logged');
      assert.equal(tracker.state().away, false, 'and it is over');

      // The next one is reported as if nothing had happened.
      world.failWith = null;
      tracker.onLock(min(40));
      await tracker.onUnlock(min(60));
      assert.equal(reports.length, 2, failWith.message);
    }
  });

  it('swallows a report that throws before it returns anything', async () => {
    let called = 0;
    const tracker = createAwayTracker({
      now: () => min(120),
      getIdleSeconds: () => 0,
      getLive: () => FOCUS,
      getSettings: () => ({ away_minutes: '10' }),
      report: () => {
        called++;
        throw new Error('not even a promise');
      },
    });

    tracker.onLock(min(0));
    await assert.doesNotReject(tracker.onUnlock(min(20)));

    assert.equal(called, 1);
  });

  it('does not throw when the block on the clock cannot be read, and tells nobody anything', async () => {
    const tracker = createAwayTracker({
      now: () => min(120),
      getIdleSeconds: () => 0,
      getLive: () => {
        throw new Error('no clock');
      },
      getSettings: () => ({ away_minutes: '10' }),
      report: () => assert.fail('nothing was known to be running, so there is nothing to tell'),
    });

    tracker.onLock(min(0));

    await assert.doesNotReject(tracker.onUnlock(min(20)));
  });

  it('says only the block and the two instants, as the server takes them', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    await tracker.onUnlock(min(12));

    assert.deepEqual(Object.keys(reports[0]).sort(), ['endedAt', 'sessionId', 'startedAt']);
    assert.equal(reports[0].startedAt, '2026-10-12T10:00:00.000Z');
    assert.equal(reports[0].endedAt, '2026-10-12T10:12:00.000Z');
  });

  it('resolves only once the report has been sent', async () => {
    let sent = false;
    const tracker = createAwayTracker({
      now: () => min(120),
      getIdleSeconds: () => 0,
      getLive: () => FOCUS,
      getSettings: () => ({ away_minutes: '10' }),
      report: () => new Promise((resolve) => setTimeout(() => ((sent = true), resolve()), 20)),
    });

    tracker.onLock(min(0));
    await tracker.onUnlock(min(20));

    assert.equal(sent, true);
  });
});
