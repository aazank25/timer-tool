import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { elapsedSeconds, formatClock, menuBarText, WAITING_MARK } from '../menu-bar.mjs';

const stopwatch = { title: 'Deep work', projectName: 'ROI Dashboard', plannedSeconds: null, status: 'running' };
const pomodoro = { ...stopwatch, plannedSeconds: 25 * 60 };

describe('a clock', () => {
  it('is minutes and seconds up to an hour, then hours as well', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(5), '00:05');
    assert.equal(formatClock(59), '00:59');
    assert.equal(formatClock(60), '01:00');
    assert.equal(formatClock(25 * 60), '25:00');
    assert.equal(formatClock(3599), '59:59');
    assert.equal(formatClock(3600), '1:00:00');
    assert.equal(formatClock(3661), '1:01:01');
    assert.equal(formatClock(10 * 3600 + 5), '10:00:05');
  });

  it('rounds to the second, and is never negative', () => {
    assert.equal(formatClock(59.4), '00:59');
    assert.equal(formatClock(59.6), '01:00');
    assert.equal(formatClock(-30), '00:00');
    assert.equal(formatClock(Number.NaN), '00:00');
  });
});

describe('how long a block has run', () => {
  const read = (session, elapsedAtPoll = 100, polledAt = 1_000_000) => ({
    session,
    elapsedAtPoll,
    polledAt,
  });

  it('is nothing with nothing on the clock', () => {
    assert.equal(elapsedSeconds(read(null), 2_000_000), 0);
  });

  it('goes on at the rate of the clock from the last read while it is running', () => {
    assert.equal(elapsedSeconds(read({ status: 'running' }), 1_000_000), 100);
    assert.equal(elapsedSeconds(read({ status: 'running' }), 1_004_500), 104.5);
  });

  it('stands still while it is paused, however long it has been', () => {
    assert.equal(elapsedSeconds(read({ status: 'paused' }), 5_000_000), 100);
  });

  it('does not take time off for a clock that was set back', () => {
    assert.equal(elapsedSeconds(read({ status: 'running' }), 900_000), 100);
  });
});

describe('what the menu-bar item says', () => {
  it('has no title and says nothing is running, when nothing is and nothing waits', () => {
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 0 }), {
      title: '',
      toolTip: 'FocusDesk - nothing running',
    });
  });

  it('is only the dot, and says how many wait, when nothing is running and something is', () => {
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 1 }), {
      title: WAITING_MARK,
      toolTip: 'FocusDesk - nothing running\n1 thing needs your attention',
    });
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 3 }), {
      title: '•',
      toolTip: 'FocusDesk - nothing running\n3 things need your attention',
    });
  });

  it('counts a stopwatch up, unsigned, with its block and project in the tooltip', () => {
    assert.deepEqual(menuBarText({ session: stopwatch, elapsed: 754, waiting: 0 }), {
      title: ' 12:34',
      toolTip: 'Deep work\nROI Dashboard · stopwatch 12:34',
    });
  });

  it('counts a Pomodoro down to its end, and past it with a plus', () => {
    assert.deepEqual(menuBarText({ session: pomodoro, elapsed: 600, waiting: 0 }), {
      title: ' 15:00',
      toolTip: 'Deep work\nROI Dashboard - 15:00',
    });
    assert.equal(menuBarText({ session: pomodoro, elapsed: 25 * 60, waiting: 0 }).title, ' 00:00');
    assert.equal(menuBarText({ session: pomodoro, elapsed: 25 * 60 + 90, waiting: 0 }).title, ' +01:30');
    assert.equal(
      menuBarText({ session: pomodoro, elapsed: 25 * 60 + 90, waiting: 0 }).toolTip,
      'Deep work\nROI Dashboard - +01:30',
    );
  });

  it('says || for a paused block, which keeps the time it had', () => {
    assert.equal(
      menuBarText({ session: { ...stopwatch, status: 'paused' }, elapsed: 754, waiting: 0 }).title,
      '|| 12:34',
    );
    assert.equal(
      menuBarText({ session: { ...pomodoro, status: 'paused' }, elapsed: 600, waiting: 0 }).title,
      '|| 15:00',
    );
  });

  it('puts the dot before the clock when something waits, running or paused', () => {
    assert.equal(menuBarText({ session: stopwatch, elapsed: 754, waiting: 2 }).title, '• 12:34');
    assert.equal(
      menuBarText({ session: { ...stopwatch, status: 'paused' }, elapsed: 754, waiting: 2 }).title,
      '• || 12:34',
    );
  });

  it('says in the tooltip how many wait, in the singular and the plural, after the block', () => {
    assert.equal(
      menuBarText({ session: stopwatch, elapsed: 754, waiting: 1 }).toolTip,
      'Deep work\nROI Dashboard · stopwatch 12:34\n1 thing needs your attention',
    );
    assert.equal(
      menuBarText({ session: pomodoro, elapsed: 600, waiting: 4 }).toolTip,
      'Deep work\nROI Dashboard - 15:00\n4 things need your attention',
    );
  });

  it('names a block with no project as having none', () => {
    const bare = { ...stopwatch, projectName: null };
    assert.equal(
      menuBarText({ session: bare, elapsed: 60, waiting: 0 }).toolTip,
      'Deep work\nNo project · stopwatch 01:00',
    );
    assert.equal(
      menuBarText({ session: { ...bare, projectName: undefined, plannedSeconds: 60 }, elapsed: 0, waiting: 0 })
        .toolTip,
      'Deep work\nNo project - 01:00',
    );
  });
});
