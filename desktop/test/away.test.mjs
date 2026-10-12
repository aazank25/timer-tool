import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAwayTracker, MAX_STRETCH_HOURS } from '../away.mjs';

/** Ten o'clock on a Monday, and minutes after it: nothing here is about what day it is. */
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const min = (n) => T0 + n * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60;
const CAP = MAX_STRETCH_HOURS * HOUR;

const FOCUS = { id: 7, kind: 'focus', status: 'running' };

/**
 * A tracker over a clock and an idle time that the test sets, and a server that remembers what it
 * was told. The clock starts a day on, so that no report is cut short by it; a test about that
 * sets it where it wants it. The screen is locked unless a test says it is not, which is what the
 * system would say after a lock; `liveAsked` counts the times the block on the clock was asked for.
 */
function setup(over = {}) {
  const world = {
    now: T0 + 24 * 60 * 60_000,
    idle: 0,
    live: FOCUS,
    liveAsked: 0,
    locked: true,
    lockedAsked: 0,
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
    getLive: () => {
      world.liveAsked++;
      const live = typeof world.live === 'function' ? world.live() : world.live;
      if (live instanceof Error) throw live;
      return live;
    },
    isLocked: () => {
      world.lockedAsked++;
      if (world.locked instanceof Error) throw world.locked;
      return world.locked;
    },
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
    assert.deepEqual(
      reports,
      [told(min(40), min(46))],
      'and is plenty for five, given as a number',
    );
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

  it('is over at the unlock even when the wake-up was never seen, and a wake-up after it changes nothing', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    tracker.onSuspend(min(2));
    // Somebody who has unlocked the screen is awake, whatever the events said.
    await tracker.onUnlock(min(30));
    assert.deepEqual(reports, [told(min(0), min(30))]);
    assert.equal(tracker.state().away, false);

    await tracker.onResume(min(31));
    assert.deepEqual(reports, [told(min(0), min(30))], 'nothing new began');
  });

  it('ends at the latest return it was told of, whichever order the events came in', async () => {
    const { tracker, reports } = setup();

    tracker.onLock(min(0));
    tracker.onSuspend(min(2));
    await tracker.onResume(min(40));
    // The unlock is stamped before the wake-up: two clocks are never quite alike.
    await tracker.onUnlock(min(38));

    assert.deepEqual(reports, [told(min(0), min(40))]);
  });

  it('is over at the unlock for a sleep that had no lock before it, and no wake-up seen', async () => {
    const { tracker, reports } = setup();

    tracker.onSuspend(min(0));
    await tracker.onUnlock(min(25));

    assert.deepEqual(reports, [told(min(0), min(25))]);
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

  it('is not over at a wake-up: the other user still has the Mac until this session is back', async () => {
    const { tracker, reports } = setup();

    tracker.onResignActive(min(0));
    tracker.onSuspend(min(10));
    await tracker.onResume(min(50));
    assert.deepEqual(reports, []);
    assert.equal(tracker.state().switched, true);
    await tracker.onBecomeActive(min(60));

    assert.deepEqual(reports, [told(min(0), min(60))]);
  });

  it('is over when this session is back even if the wake-up was never seen', async () => {
    const { tracker, reports } = setup();

    tracker.onSuspend(min(0));
    await tracker.onBecomeActive(min(30));

    assert.deepEqual(reports, [told(min(0), min(30))]);
  });

  it('is over at the unlock when the switch back was never seen', async () => {
    const { tracker, reports } = setup();

    tracker.onResignActive(min(0));
    tracker.onLock(min(1));
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
    for (const live of [
      null,
      { ...FOCUS, status: 'paused' },
      { id: 8, kind: 'break', status: 'running' },
    ]) {
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

  it('is one stretch with the lock that came in the middle of it, from the first input to the unlock', async () => {
    const { world, tracker, reports } = setup();
    // Untouched since 20 minutes past, noticed at half past.
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();
    tracker.onLock(min(35));
    assert.equal(tracker.state().since, min(20), 'the lock did not start another');
    world.now = min(60);
    await tracker.onUnlock(min(60));

    assert.deepEqual(reports, [told(min(20), min(60))]);
    assert.equal(tracker.state().away, false);
  });

  it('is over at the unlock, and the input that comes after it begins nothing new', async () => {
    const { world, tracker, reports } = setup();
    // Untouched since 20 minutes past, noticed at half past, and locked at 35.
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();
    tracker.onLock(min(35));
    world.now = min(60);
    await tracker.onUnlock(min(60));

    // The next look: the password was typed five seconds ago.
    world.now = min(60) + 10_000;
    world.idle = 5;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(60))]);
    assert.equal(tracker.state().away, false);
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

describe('where a stretch begins', () => {
  it('is at the last input and not at the lock, when the Mac locks itself after being left alone', async () => {
    const { world, tracker, reports } = setup();
    // Last touched at 10:00. The Mac locks itself at 10:05, and is unlocked at 10:14.
    world.now = min(5);
    world.idle = 300;
    tracker.onLock(min(5));
    assert.equal(tracker.state().since, min(0));

    world.now = min(14);
    world.idle = 0;
    await tracker.onUnlock(min(14));

    assert.deepEqual(reports, [told(min(0), min(14))], 'fourteen minutes away, and not nine');
  });

  it('is at the last input for a sleep and for another user taking over as well', async () => {
    for (const [begin, end] of [
      ['onSuspend', 'onResume'],
      ['onResignActive', 'onBecomeActive'],
    ]) {
      const { world, tracker, reports } = setup();
      world.now = min(5);
      world.idle = 300;
      tracker[begin](min(5));
      assert.equal(tracker.state().since, min(0), begin);

      world.now = min(14);
      world.idle = 0;
      await tracker[end](min(14));

      assert.deepEqual(reports, [told(min(0), min(14))], begin);
    }
  });

  it('is at the event when the last input is not before it, or when the idle time cannot be read', () => {
    // Touched a moment ago: the lock is where it began.
    const touched = setup();
    touched.world.now = min(5);
    touched.world.idle = 0;
    touched.tracker.onLock(min(5));
    assert.equal(touched.tracker.state().since, min(5));

    // No idea when it was last touched: the event is all there is to go by.
    const unknown = setup();
    unknown.world.now = min(5);
    unknown.world.idle = Number.NaN;
    unknown.tracker.onLock(min(5));
    assert.equal(unknown.tracker.state().since, min(5));
  });

  it('is at the earlier of the event and the last input, when the event is stamped before the input', () => {
    const { world, tracker } = setup();
    world.now = min(5);
    world.idle = 60;

    tracker.onLock(min(3));

    assert.equal(tracker.state().since, min(3), 'the last input was at 10:04');
  });
});

describe('after a return', () => {
  it('does not begin a new stretch before it: an unlock with no input at all, as with a watch, is not a second absence', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onLock(min(0));

    // Unlocked at 10:30 by a watch or a fingerprint: the keyboard and the pointer were not touched.
    world.now = min(30);
    world.idle = 30 * 60;
    await tracker.onUnlock(min(30));
    assert.deepEqual(reports, [told(min(0), min(30))]);

    // A quarter of a minute on, the machine says it was last touched half an hour ago: before the
    // stretch that has just been reported. This one begins at the return, and not on top of it.
    world.now = min(30) + 15_000;
    world.idle = 30 * 60 + 15;
    await tracker.tick();
    assert.equal(tracker.state().away, true);
    assert.equal(tracker.state().since, min(30));

    // The first input, at 10:31:55: it is too short to be one of its own.
    world.now = min(32);
    world.idle = 5;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(30))], 'not a second report over the same time');
    assert.equal(tracker.state().away, false);
  });

  it('is reported all the same when what follows the return is a whole threshold of quiet', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onLock(min(0));
    world.now = min(30);
    world.idle = 30 * 60;
    await tracker.onUnlock(min(30));

    world.now = min(30) + 15_000;
    world.idle = 30 * 60 + 15;
    await tracker.tick();
    // Nobody touches it until 10:46.
    world.now = min(46) + 5_000;
    world.idle = 5;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(30)), told(min(30), min(46))]);
  });

  it('holds a lock that follows it to the return too', async () => {
    const { world, tracker } = setup();
    tracker.onLock(min(0));
    world.now = min(30);
    world.idle = 30 * 60;
    await tracker.onUnlock(min(30));

    world.now = min(31);
    world.idle = 31 * 60;
    tracker.onLock(min(31));

    assert.equal(tracker.state().since, min(30));
  });

  it('is not held off by a clock that was put back to before the return', async () => {
    const { world, tracker } = setup();
    tracker.onLock(min(0));
    world.now = min(30);
    await tracker.onUnlock(min(30));

    // It is 10:10 again, and nobody has touched it since 10:00.
    world.now = min(10);
    world.idle = 10 * 60;
    await tracker.tick();

    assert.equal(tracker.state().away, true);
    assert.ok(tracker.state().since <= world.now, 'it began no later than now');
  });
});

describe('a stretch that an event never ended', () => {
  it('ends a lock at the last input when the unlock was never seen and the screen is not locked', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onLock(min(0));

    // Back at 10:20 and typing: the look at 10:20:15 finds the last input eight seconds old.
    world.now = min(20) + 15_000;
    world.idle = 8;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(20) + 7_000)]);
    assert.equal(tracker.state().away, false);
    assert.equal(tracker.state().locked, false, 'and the lock is not left standing');
  });

  it('ends a sleep at the last input when the wake-up was never seen and the screen is not locked', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onSuspend(min(0));

    world.now = min(45) + 15_000;
    world.idle = 8;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(45) + 7_000)]);
    assert.equal(tracker.state().away, false);
    assert.equal(tracker.state().suspended, false);
  });

  it('ends a switch of users at the last input when the switch back was never seen', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onResignActive(min(0));

    world.now = min(25) + 15_000;
    world.idle = 8;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(25) + 7_000)]);
    assert.equal(tracker.state().switched, false);
  });

  it('ends all of a lock, a sleep and a switch at once, and an idle stretch that came before them', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    // Untouched since 10:20, noticed at 10:30, and then locked and put to sleep.
    world.now = min(30);
    world.idle = 600;
    await tracker.tick();
    tracker.onLock(min(35));
    tracker.onSuspend(min(36));
    tracker.onResignActive(min(37));

    world.now = min(60) + 15_000;
    world.idle = 8;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(20), min(60) + 7_000)]);
    assert.deepEqual(tracker.state(), {
      away: false,
      since: null,
      sessionId: null,
      locked: false,
      suspended: false,
      switched: false,
      idle: false,
    });
  });

  it('does not end a lock for input while the screen is locked: a password being typed is not being back', async () => {
    const { world, tracker, reports } = setup({ locked: true });
    tracker.onLock(min(0));

    world.now = min(20) + 15_000;
    world.idle = 3;
    await tracker.tick();
    assert.deepEqual(reports, []);
    assert.equal(tracker.state().locked, true);

    // The unlock itself comes a moment later, and is the end.
    world.locked = false;
    world.now = min(20) + 20_000;
    await tracker.onUnlock();
    assert.deepEqual(reports, [told(min(0), min(20) + 20_000)]);
  });

  it('asks the system whether the screen is locked only when there has been input to ask about', async () => {
    const { world, tracker } = setup({ locked: false });
    tracker.onLock(min(0));

    // Five minutes in and nobody has touched it since the lock.
    world.now = min(5);
    world.idle = 5 * 60;
    await tracker.tick();
    assert.equal(world.lockedAsked, 0);
    assert.equal(tracker.state().away, true);

    // A second after the lock is not input after it either: whole seconds, read late.
    world.now = min(5) + 15_000;
    world.idle = 5 * 60 + 14;
    await tracker.tick();
    assert.equal(world.lockedAsked, 0);

    world.now = min(5) + 30_000;
    world.idle = 4;
    await tracker.tick();
    assert.equal(world.lockedAsked, 1);
    assert.equal(tracker.state().away, false);
  });

  it('takes a system that cannot say whether the screen is locked as locked, and says so in the log', async () => {
    const { world, tracker, reports, logs } = setup({ locked: new Error('not on this platform') });
    tracker.onLock(min(0));

    world.now = min(20);
    world.idle = 3;
    await assert.doesNotReject(tracker.tick());

    assert.equal(tracker.state().away, true);
    assert.deepEqual(reports, []);
    assert.equal(logs.length, 1);
  });

  it('is ended by the events alone when the system is never asked', async () => {
    const reports = [];
    const world = { now: min(20) + 15_000, idle: 8 };
    const tracker = createAwayTracker({
      now: () => world.now,
      getIdleSeconds: () => world.idle,
      getLive: () => FOCUS,
      getSettings: () => ({ away_minutes: '10' }),
      report: (stretch) => reports.push(stretch),
    });
    tracker.onLock(min(0));

    await tracker.tick();
    assert.equal(tracker.state().away, true, 'input says nothing when it cannot be asked about');

    world.now = min(21);
    await tracker.onUnlock(min(21));
    assert.deepEqual(reports, [told(min(0), min(21))]);
  });

  it('takes an idle time that cannot be read as no news about a lock, though it is input to an idle stretch', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onLock(min(0));
    world.now = min(20);
    world.idle = Number.NaN;
    await tracker.tick();
    assert.equal(tracker.state().away, true, 'nobody is let off by a reading that is not there');
    assert.deepEqual(reports, []);

    world.idle = new Error('not on this platform');
    await tracker.tick();
    assert.equal(tracker.state().away, true);
  });

  it('is a stretch of its own for the next lock, against the block that is running by then', async () => {
    const { world, tracker, reports } = setup({ locked: false });
    tracker.onLock(min(0));
    world.now = min(20) + 15_000;
    world.idle = 8;
    await tracker.tick();

    // Ten hours on: another block, another lock, another unlock. It used to be one stretch of
    // ten hours against the first block, which had long been finished.
    world.live = { id: 9, kind: 'focus', status: 'running' };
    world.locked = true;
    world.now = min(600);
    world.idle = 0;
    tracker.onLock(min(600));
    world.now = min(620);
    await tracker.onUnlock(min(620));

    assert.deepEqual(reports, [told(min(0), min(20) + 7_000), told(min(600), min(620), 9)]);
  });

  it('is not ended while the screen is locked and nobody has touched it, however many times it is looked at', async () => {
    const { world, tracker, reports } = setup({ locked: true });
    tracker.onLock(min(0));

    for (let n = 1; n <= 20; n++) {
      world.now = min(0) + n * 15_000;
      world.idle = n * 15;
      await tracker.tick();
    }

    assert.equal(tracker.state().away, true);
    assert.equal(tracker.state().since, min(0));
    assert.deepEqual(reports, []);
  });
});

describe('the longest stretch', () => {
  it('is twelve hours', () => {
    assert.equal(MAX_STRETCH_HOURS, 12);
  });

  it('is ended at its length by the next look, and reported up to there and no further', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;

    world.now = min(CAP) - 15_000;
    await tracker.tick();
    assert.equal(tracker.state().away, true, 'a quarter of a minute short of it');
    assert.deepEqual(reports, []);

    world.now = min(CAP) + 15_000;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(CAP))]);
    assert.deepEqual(tracker.state(), {
      away: false,
      since: null,
      sessionId: null,
      locked: false,
      suspended: false,
      switched: false,
      idle: false,
    });
  });

  it('is reported up to its length when an event ends it later, as for a Mac that slept for a day', async () => {
    const { world, tracker, reports } = setup();
    tracker.onSuspend(min(0));

    world.now = min(30 * HOUR);
    await tracker.onResume(min(30 * HOUR));

    assert.deepEqual(reports, [told(min(0), min(CAP))]);
  });

  it('is cut for an idle stretch too, at its length from the last input', async () => {
    const { world, tracker, reports } = setup();
    // Untouched for fifteen hours when it is first looked at.
    world.now = min(15 * HOUR);
    world.idle = 15 * 3600;
    await tracker.tick();
    assert.equal(tracker.state().since, min(0));

    world.now = min(15 * HOUR) + 15_000;
    world.idle = 15 * 3600 + 15;
    await tracker.tick();

    assert.deepEqual(reports, [told(min(0), min(CAP))]);
  });

  it('does not report what is left of the absence, however long it goes on', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;
    world.now = min(CAP) + 15_000;
    await tracker.tick();
    assert.equal(reports.length, 1);

    // Still nobody there, for hours: the idle time says so, and that is not a new stretch.
    for (const hours of [13, 14, 20]) {
      world.now = min(hours * HOUR);
      await tracker.tick();
      assert.equal(tracker.state().away, false, `${hours} hours in`);
    }
    // Nor is the lock being seen again, or the Mac going to sleep and waking up.
    await tracker.onSuspend(min(21 * HOUR));
    await tracker.onResume(min(22 * HOUR));
    await tracker.onUnlock(min(23 * HOUR));

    assert.deepEqual(reports, [told(min(0), min(CAP))]);
    assert.equal(tracker.state().away, false);
  });

  it('looks for a new stretch again once the machine has been touched, from that last input', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;
    world.now = min(CAP) + 15_000;
    await tracker.tick();
    await tracker.onUnlock(min(20 * HOUR));

    // Somebody is there at 20:00 on the clock, and goes away again after typing for a moment.
    world.now = min(20 * HOUR) + 15_000;
    world.idle = 10;
    await tracker.tick();
    assert.equal(tracker.state().away, false);
    const lastInput = world.now - 10_000;

    world.now = lastInput + 12 * 60_000;
    world.idle = 12 * 60;
    await tracker.tick();
    assert.equal(tracker.state().away, true);
    assert.equal(tracker.state().since, lastInput);

    world.now = lastInput + 13 * 60_000;
    world.idle = 3;
    await tracker.tick();
    assert.deepEqual(reports, [
      told(min(0), min(CAP)),
      told(lastInput, lastInput + 13 * 60_000 - 3_000),
    ]);
  });

  it('begins a new stretch for a lock that comes after the machine was touched, and not before', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;
    world.now = min(CAP) + 15_000;
    await tracker.tick();

    // Locked again with nobody having touched it since: the same absence.
    world.now = min(15 * HOUR);
    tracker.onLock(min(15 * HOUR));
    assert.equal(tracker.state().away, false);

    // Touched at 16:00 and locked at 16:05: the lock is somebody leaving.
    world.now = min(16 * HOUR) + 5 * 60_000;
    world.idle = 5 * 60;
    tracker.onLock(min(16 * HOUR) + 5 * 60_000);
    assert.equal(tracker.state().away, true);
    assert.equal(tracker.state().since, min(16 * HOUR), 'from the last input');

    world.now = min(16 * HOUR) + 30 * 60_000;
    world.idle = 0;
    await tracker.onUnlock(world.now);
    assert.deepEqual(reports, [
      told(min(0), min(CAP)),
      told(min(16 * HOUR), min(16 * HOUR) + 30 * 60_000),
    ]);
  });

  it('stops looking for the cut for good once somebody has touched the machine, so a clock put back later does not bring it back', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;
    world.now = min(CAP) + 15_000;
    await tracker.tick();
    assert.equal(reports.length, 1);

    // Somebody touches it at CAP + 5 minutes, locks it five minutes after that, and is back at CAP + 40.
    world.now = min(CAP) + 10 * 60_000;
    world.idle = 5 * 60;
    tracker.onLock(world.now);
    assert.equal(tracker.state().since, min(CAP) + 5 * 60_000, 'a new stretch, from that last input');
    world.now = min(CAP) + 40 * 60_000;
    world.idle = 0;
    await tracker.onUnlock(world.now);
    assert.equal(tracker.state().away, false);

    // A wrong clock is corrected, and it reads twenty minutes before the cut. Somebody leaving now
    // is a stretch like any other: the cut was dealt with when the machine was touched.
    world.now = min(CAP) - 20 * 60_000;
    world.idle = 0;
    tracker.onLock(world.now);
    assert.equal(tracker.state().away, true);
    assert.equal(tracker.state().since, min(CAP) - 20 * 60_000);

    world.now = min(CAP) - 5 * 60_000;
    await tracker.onUnlock(world.now);
    assert.deepEqual(reports, [
      told(min(0), min(CAP)),
      told(min(CAP) + 5 * 60_000, min(CAP) + 40 * 60_000),
      told(min(CAP) - 20 * 60_000, min(CAP) - 5 * 60_000),
    ]);
  });

  it('does not cut a stretch of ten hours', async () => {
    const { world, tracker, reports } = setup();
    tracker.onLock(min(0));
    world.idle = 99 * 3600;
    world.now = min(10 * HOUR);
    await tracker.tick();
    assert.equal(tracker.state().away, true);

    world.now = min(10 * HOUR) + 20 * 60_000;
    world.idle = 0;
    await tracker.onUnlock(world.now);
    assert.deepEqual(reports, [told(min(0), min(10 * HOUR) + 20 * 60_000)]);
  });
});

describe('the block a stretch is held against', () => {
  it('is asked for as the stretch begins, once, and not again while it goes on', async () => {
    const { world, tracker } = setup();

    tracker.onLock(min(0));
    tracker.onSuspend(min(1));
    tracker.onResignActive(min(2));
    assert.equal(world.liveAsked, 1);
    assert.equal(tracker.state().sessionId, 7);

    await tracker.onUnlock(min(15));
    tracker.onLock(min(20));
    assert.equal(world.liveAsked, 2, 'a new stretch asks again');
  });

  it('is asked of the clock itself each time, so what a window did a moment ago is known', async () => {
    const { world, tracker, reports } = setup();
    // The menu bar still says block 7 is running; the window has stopped it, and started block 8.
    world.live = () => ({ id: 8, kind: 'focus', status: 'running' });

    tracker.onLock(min(0));
    await tracker.onUnlock(min(20));

    assert.deepEqual(reports, [told(min(0), min(20), 8)]);

    // And one that was stopped a moment before the screen locked is not one it is held against.
    world.live = () => null;
    tracker.onLock(min(30));
    await tracker.onUnlock(min(50));
    assert.deepEqual(reports, [told(min(0), min(20), 8)]);
  });

  it('can be answered later, and what depends on it waits', async () => {
    let answer;
    const { world, tracker, reports } = setup({
      live: () => new Promise((resolve) => (answer = resolve)),
    });

    const asked = tracker.onLock(min(0));
    assert.equal(tracker.state().sessionId, null, 'not known yet');
    const over = tracker.onUnlock(min(20));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reports, [], 'the report waits for the answer');

    answer(FOCUS);
    await Promise.all([asked, over]);

    assert.deepEqual(reports, [told(min(0), min(20))]);
    assert.equal(world.liveAsked, 1);
  });

  it('is nothing, however late the answer comes, when what is running is not a focus block', async () => {
    let answer;
    const { tracker, reports } = setup({
      live: () => new Promise((resolve) => (answer = resolve)),
    });

    tracker.onLock(min(0));
    const over = tracker.onUnlock(min(20));
    answer({ id: 8, kind: 'break', status: 'running' });
    await over;

    assert.deepEqual(reports, []);
  });

  it('is nothing, and logged, when the answer is refused or cannot be asked for', async () => {
    for (const live of [
      () => Promise.reject(new Error('the server is away')),
      new Error('no clock'),
    ]) {
      const { tracker, reports, logs } = setup({ live });

      await assert.doesNotReject(tracker.onLock(min(0)));
      await assert.doesNotReject(tracker.onUnlock(min(20)));

      assert.deepEqual(reports, []);
      assert.equal(logs.length, 1);
    }
  });

  it('is asked for as an idle stretch is noticed, and held to the answer then', async () => {
    const { world, tracker, reports } = setup();
    world.now = min(30);
    world.idle = 600;

    await tracker.tick();
    assert.equal(world.liveAsked, 1);
    assert.equal(tracker.state().sessionId, 7);

    world.live = null;
    world.now = min(40);
    world.idle = 2;
    await tracker.tick();
    assert.deepEqual(reports, [told(min(20), min(40) - 2_000)]);
  });
});
