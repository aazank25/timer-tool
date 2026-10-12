import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import type { SessionRow, StartInput } from '../src/lib/sessions.js';
import { freshDb } from './setup.js';

const mod = () => import('../src/lib/sessions.js');
const stats = () => import('../src/lib/stats.js');
const settings = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeProject(name: string, color = '#0ea5e9'): Promise<number> {
  const { db } = await import('../src/db.js');
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, color, now, now);
  return Number(info.lastInsertRowid);
}

describe('focus score', () => {
  before(async () => {
    await freshDb();
  });

  it('is null until the block is rated', async () => {
    const { focusScore } = await mod();
    assert.equal(
      focusScore({ focus_rating: null, active_seconds: 2700, planned_minutes: 45, interruptions: 0 }),
      null,
    );
  });

  it('tops out at 100 for a rated, complete, uninterrupted block', async () => {
    const { focusScore } = await mod();
    assert.equal(
      focusScore({ focus_rating: 5, active_seconds: 2700, planned_minutes: 45, interruptions: 0 }),
      100,
    );
  });

  it('bottoms out at 0 for the worst possible block', async () => {
    const { focusScore } = await mod();
    assert.equal(
      focusScore({ focus_rating: 1, active_seconds: 0, planned_minutes: 45, interruptions: 0 }),
      15, // the calm term still pays out when nothing interrupted you
    );
    assert.equal(
      focusScore({ focus_rating: 1, active_seconds: 0, planned_minutes: 45, interruptions: 100 }),
      0,
    );
  });

  it('penalises interruptions and a block cut short', async () => {
    const { focusScore } = await mod();
    const clean = focusScore({
      focus_rating: 4,
      active_seconds: 2700,
      planned_minutes: 45,
      interruptions: 0,
    });
    const choppy = focusScore({
      focus_rating: 4,
      active_seconds: 2700,
      planned_minutes: 45,
      interruptions: 6,
    });
    const short = focusScore({
      focus_rating: 4,
      active_seconds: 600,
      planned_minutes: 45,
      interruptions: 0,
    });
    assert.ok(clean! > choppy!, 'interruptions should cost');
    assert.ok(clean! > short!, 'stopping early should cost');
  });
});

describe('timer accounting', () => {
  let projectId = 0;

  before(async () => {
    await freshDb();
    projectId = await makeProject('ROI Dashboard');
  });

  it('counts only time the clock was actually running', async () => {
    const { startSession, pauseSession, resumeSession, stopSession } = await mod();
    const started = startSession({ projectId, title: 'Competitor teardown', plannedMinutes: 45 });
    assert.equal(started.status, 'running');
    assert.equal(started.elapsedSeconds, 0);

    await sleep(1100);
    const paused = pauseSession(started.id);
    assert.equal(paused.status, 'paused');
    assert.ok(paused.elapsedSeconds >= 1, `expected >=1s, got ${paused.elapsedSeconds}`);

    // Paused time must not accrue.
    await sleep(1100);
    const { getSessionRow, toView } = await mod();
    const stillPaused = toView(getSessionRow(started.id));
    assert.equal(stillPaused.elapsedSeconds, paused.elapsedSeconds);

    resumeSession(started.id);
    const done = stopSession(started.id, 'completed', { focusRating: 4 });
    assert.equal(done.status, 'completed');
    assert.equal(done.focusRating, 4);
    assert.ok(done.elapsedSeconds >= paused.elapsedSeconds);
    assert.ok(done.elapsedSeconds < 3, 'paused seconds leaked into the total');
  });

  it('allows only one live block at a time', async () => {
    const { startSession, stopSession } = await mod();
    const first = startSession({ projectId, title: 'First' });
    assert.throws(() => startSession({ projectId, title: 'Second' }), /still on the clock/);
    stopSession(first.id, 'abandoned');
    const third = startSession({ projectId, title: 'Third' });
    assert.equal(third.status, 'running');
    stopSession(third.id, 'completed');
  });

  it('rejects pausing something that is not running', async () => {
    const { startSession, pauseSession, stopSession } = await mod();
    const s = startSession({ projectId, title: 'Pause twice' });
    pauseSession(s.id);
    assert.throws(() => pauseSession(s.id), /not running/);
    stopSession(s.id, 'completed');
  });

  it('rewrites elapsed time when the clock ran on unattended', async () => {
    const { startSession, stopSession, overwriteActiveSeconds, getSessionRow, toView } = await mod();
    const s = startSession({ projectId, title: 'Walked away', plannedMinutes: 45 });
    stopSession(s.id, 'completed', { activeSeconds: 45 * 60 });
    assert.equal(toView(getSessionRow(s.id)).elapsedSeconds, 2700);

    overwriteActiveSeconds(s.id, 600);
    const trimmed = toView(getSessionRow(s.id));
    assert.equal(trimmed.elapsedSeconds, 600);
    // Segments are rewritten too, so hour-by-hour reporting stays consistent.
    assert.equal(trimmed.remainingSeconds, 2100);
  });

  it('reports overrun once the planned block is exceeded', async () => {
    const { logManualSession, getSessionRow, toView, overwriteActiveSeconds } = await mod();
    const s = logManualSession({
      projectId,
      title: 'Ran long',
      startedAt: '2026-09-09T09:00:00.000Z',
      minutes: 45,
    });
    overwriteActiveSeconds(s.id, 60 * 60);
    const view = toView(getSessionRow(s.id));
    assert.equal(view.overrunSeconds, 900);
    assert.equal(view.remainingSeconds, 0);
  });
});

describe('day boundaries', () => {
  before(async () => {
    await freshDb();
  });

  it('counts an after-midnight block toward the day it felt like', async () => {
    const { focusDay } = await import('../src/lib/time.js');
    // 01:30 New York on the 11th, with the day starting at 04:00, is still the 10th.
    assert.equal(focusDay('2026-09-11T05:30:00.000Z', 'America/New_York', 4), '2026-09-10');
    // 09:00 the same morning is unambiguously the 11th.
    assert.equal(focusDay('2026-09-11T13:00:00.000Z', 'America/New_York', 4), '2026-09-11');
  });

  it('resolves the day in the configured timezone, not the host one', async () => {
    const { localDay } = await import('../src/lib/time.js');
    const instant = '2026-09-11T02:00:00.000Z';
    assert.equal(localDay(instant, 'UTC'), '2026-09-11');
    assert.equal(localDay(instant, 'America/Los_Angeles'), '2026-09-10');
    assert.equal(localDay(instant, 'Asia/Kolkata'), '2026-09-11');
  });
});

describe('daily rollups', () => {
  let roi = 0;
  let ops = 0;

  before(async () => {
    await freshDb();
    roi = await makeProject('ROI Dashboard', '#0ea5e9');
    ops = await makeProject('Crew Mgmt Ops', '#f59e0b');
    const { logManualSession } = await mod();
    const { setSettings } = await settings();
    setSettings({ timezone: 'UTC', day_start_hour: 4, daily_target_minutes: 300 });

    logManualSession({
      projectId: roi,
      title: 'Competitor teardown',
      startedAt: '2026-09-10T10:40:00.000Z',
      minutes: 45,
      focusRating: 4,
    });
    logManualSession({
      projectId: roi,
      title: 'Ticket taxonomy draft',
      startedAt: '2026-09-10T13:00:00.000Z',
      minutes: 50,
      focusRating: 5,
    });
    logManualSession({
      projectId: ops,
      title: 'Moderator escalations',
      startedAt: '2026-09-10T15:00:00.000Z',
      minutes: 30,
      focusRating: 2,
    });
  });

  it('totals the day and splits it by project, biggest first', async () => {
    const { dayStats } = await stats();
    const d = dayStats('2026-09-10');
    assert.equal(d.focusSeconds, (45 + 50 + 30) * 60);
    assert.equal(d.blocks, 3);
    assert.equal(d.targetMinutes, 300);
    assert.equal(d.byProject.length, 2);
    assert.equal(d.byProject[0]?.name, 'ROI Dashboard');
    assert.equal(d.byProject[0]?.seconds, 95 * 60);
    assert.equal(d.byProject[0]?.blocks, 2);
    assert.equal(d.byProject[1]?.name, 'Crew Mgmt Ops');
    // Shares are percentages of the day and add up.
    const shareTotal = d.byProject.reduce((a, p) => a + p.share, 0);
    assert.ok(Math.abs(shareTotal - 100) < 0.2, `shares summed to ${shareTotal}`);
  });

  it('averages the self-reported rating over rated blocks only', async () => {
    const { logManualSession } = await mod();
    logManualSession({
      projectId: roi,
      title: 'Unrated block',
      startedAt: '2026-09-10T17:00:00.000Z',
      minutes: 20,
    });
    const { dayStats } = await stats();
    const d = dayStats('2026-09-10');
    assert.equal(d.ratedBlocks, 3);
    assert.equal(d.avgFocusRating, 3.7); // (4 + 5 + 2) / 3
  });

  it('splits a block that crosses the hour across both hours', async () => {
    const { dayStats } = await stats();
    const byHour = new Map(dayStats('2026-09-10').byHour.map((h) => [h.hour, h.seconds]));
    // 10:40 + 45m => 20 minutes in hour 10, 25 in hour 11.
    assert.equal(byHour.get(10), 20 * 60);
    assert.equal(byHour.get(11), 25 * 60);
    // 13:00 + 50m ends at 13:50, so it stays wholly inside hour 13.
    assert.equal(byHour.get(13), 50 * 60);
    assert.equal(byHour.get(14), 0);
    // Nothing is attributed to hours that were never worked.
    assert.equal(byHour.get(3), 0);
    assert.equal(byHour.get(23), 0);
    // Every bucket together accounts for the whole day, and nothing more.
    const bucketed = [...byHour.values()].reduce((a, b) => a + b, 0);
    assert.equal(bucketed, (45 + 50 + 30 + 20) * 60);
  });

  it('finds the longest unbroken stretch of work', async () => {
    const { dayStats } = await stats();
    const d = dayStats('2026-09-10');
    // 13:00-13:50 then 15:00-15:30 is a 70-minute gap, so no streak spans it.
    assert.ok(d.longestStreakSeconds >= 50 * 60, `got ${d.longestStreakSeconds}`);
    assert.ok(d.longestStreakSeconds < 95 * 60, `got ${d.longestStreakSeconds}`);
  });

  it('rolls a date range up per day and per project', async () => {
    const { rangeStats } = await stats();
    const r = rangeStats('2026-09-04', '2026-09-10');
    assert.equal(r.days.length, 7);
    assert.equal(r.activeDays, 1);
    assert.equal(r.totalBlocks, 4);
    assert.equal(r.avgSecondsPerActiveDay, r.totalFocusSeconds);
    assert.equal(r.days.at(-1)?.day, '2026-09-10');
    assert.equal(r.days[0]?.focusSeconds, 0);
  });

  it('leaves abandoned blocks out of focused time', async () => {
    const { startSession, stopSession } = await mod();
    const { dayStats } = await stats();
    const { today } = await settings();
    // The block lands on the user's focus day, which turns over at the day-start hour in
    // their timezone and not at UTC midnight: for the first hours of every UTC day the UTC
    // date is already the next day. Ask the app which day it is rather than the clock.
    const day = today();
    const before = dayStats(day).focusSeconds;
    const s = startSession({ projectId: roi, title: 'Gave up', plannedMinutes: 45 });
    stopSession(s.id, 'abandoned', { activeSeconds: 600 });
    const d = dayStats(day);
    assert.equal(d.focusSeconds, before);
    assert.equal(d.abandonedBlocks, 1);
  });
});

describe('calendar feed parsing', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:standup-1',
    'SUMMARY:Team standup',
    'LOCATION:Zoom',
    'DTSTART:20260907T140000Z',
    'DTEND:20260907T143000Z',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE:20260914T140000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:oneoff-1',
    'SUMMARY:Vendor demo',
    'DTSTART:20260910T160000Z',
    'DTEND:20260910T170000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  before(async () => {
    await freshDb();
  });

  it('expands a recurring meeting and honours cancelled instances', async () => {
    const { parseFeed } = await import('../src/lib/calendar.js');
    const events = parseFeed(ics, new Date('2026-09-01T00:00:00Z'), new Date('2026-10-15T00:00:00Z'));
    const standups = events.filter((e) => e.title === 'Team standup');
    assert.equal(standups.length, 3, 'four weekly instances minus one EXDATE');
    assert.ok(!standups.some((s) => s.start.toISOString().startsWith('2026-09-14')));
    assert.equal(standups[0]?.location, 'Zoom');
    // Instances inherit the series duration.
    for (const s of standups) {
      assert.equal(s.end.getTime() - s.start.getTime(), 30 * 60_000);
    }
  });

  it('keeps one-off meetings and drops events outside the window', async () => {
    const { parseFeed } = await import('../src/lib/calendar.js');
    const inWindow = parseFeed(ics, new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'));
    assert.ok(inWindow.some((e) => e.title === 'Vendor demo'));
    const outOfWindow = parseFeed(ics, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-08T00:00:00Z'));
    assert.ok(!outOfWindow.some((e) => e.title === 'Vendor demo'));
  });
});

/* ---------------------------------------------------------------- stopwatch */

/** A failed assertion must not leave a block on the clock for the next test to trip over. */
async function clearLive() {
  const { db } = await dbMod();
  db.exec("DELETE FROM sessions WHERE status IN ('running','paused')");
}

/** Start a block, stop it, and hand back the finished view. */
async function finishedBlock(input: StartInput, activeSeconds: number, rating: number) {
  const { startSession, stopSession } = await mod();
  const started = startSession(input);
  return stopSession(started.id, 'completed', { focusRating: rating, activeSeconds });
}

/** The API on a loopback port of its own, so a route's validation and wiring are tested too. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as any };
  };

  return {
    call,
    /** For the cases where only the refusal matters. */
    status: async (method: string, url: string, body?: unknown) =>
      (await call(method, url, body)).status,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe('focus score without a planned length', () => {
  before(async () => {
    await freshDb();
  });

  const stopwatch = (focus_rating: number | null, active_seconds: number, interruptions = 0) => ({
    focus_rating,
    active_seconds,
    planned_minutes: null,
    interruptions,
  });

  it('counts a stopped stopwatch as complete, so the rating alone sets the score', async () => {
    const { focusScore } = await mod();
    assert.equal(focusScore(stopwatch(5, 1800)), 100);
    assert.equal(focusScore(stopwatch(4, 1800)), 85);
    assert.equal(focusScore(stopwatch(3, 1800)), 70);
    assert.equal(focusScore(stopwatch(1, 1800)), 40);
  });

  it('scores a stopwatch with nothing worked as complete, not as 0% done', async () => {
    const { focusScore } = await mod();
    // The one input where having no plan and having a one-second plan part ways.
    // Flooring the plan at a second made zero worked seconds 0% complete: 60, not 85.
    assert.equal(focusScore(stopwatch(4, 0)), 85);
  });

  it('does not depend on how long the block ran', async () => {
    const { focusScore } = await mod();
    // You stopped when you were done, however long that took.
    for (const seconds of [0, 30, 300, 3600, 3 * 3600]) {
      assert.equal(focusScore(stopwatch(4, seconds)), 85, `${seconds}s worked`);
    }
  });

  it('equals a fully worked pomodoro at the same rating and interruptions', async () => {
    const { focusScore } = await mod();
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const interruptions of [0, 1, 4]) {
        const fullPomodoro = {
          focus_rating: rating,
          active_seconds: 2700,
          planned_minutes: 45,
          interruptions,
        };
        for (const worked of [0, 300, 3600]) {
          assert.equal(
            focusScore(stopwatch(rating, worked, interruptions)),
            focusScore(fullPomodoro),
            `rating ${rating}, ${interruptions} interruptions, ${worked}s worked`,
          );
        }
      }
    }
  });

  it('still loses points to interruptions', async () => {
    const { focusScore } = await mod();
    const clean = focusScore(stopwatch(4, 1800, 0));
    const some = focusScore(stopwatch(4, 1800, 2));
    const choppy = focusScore(stopwatch(4, 1800, 6));
    assert.ok(clean! > some!, 'interruptions should cost');
    assert.ok(some! > choppy!, 'more interruptions should cost more');
  });

  it('is null until the block is rated', async () => {
    const { focusScore } = await mod();
    assert.equal(focusScore(stopwatch(null, 1800)), null);
  });
});

describe('stopwatch blocks', () => {
  let projectId = 0;

  before(async () => {
    await freshDb();
    projectId = await makeProject('ROI Dashboard');
  });

  beforeEach(clearLive);

  it('stores no planned length and reports none', async () => {
    const { startSession, stopSession } = await mod();
    const { db } = await dbMod();
    const s = startSession({ projectId, title: 'Open-ended', mode: 'stopwatch' });
    const row = db.prepare('SELECT planned_minutes FROM sessions WHERE id = ?').get(s.id) as {
      planned_minutes: number | null;
    };
    assert.equal(row.planned_minutes, null);
    assert.equal(s.mode, 'stopwatch');
    assert.equal(s.plannedMinutes, null);
    assert.equal(s.plannedSeconds, null);
    assert.equal(s.remainingSeconds, null);
    assert.equal(s.overrunSeconds, null);
    stopSession(s.id, 'abandoned');
  });

  it('refuses a stopwatch that is also given a length, as PATCH does', async () => {
    const { startSession, liveSessionRow } = await mod();
    assert.throws(
      () =>
        startSession({ projectId, title: 'Mixed signals', mode: 'stopwatch', plannedMinutes: 45 }),
      { status: 400, message: 'A stopwatch has no planned length' },
    );
    // Refused outright, not started with the length quietly dropped.
    assert.equal(liveSessionRow(), undefined);
  });

  it('follows default_timer_mode when the caller says nothing about length', async () => {
    const { startSession, stopSession } = await mod();
    const { DEFAULT_SETTINGS } = await dbMod();
    const { getNumber, getSetting, setSettings } = await settings();
    assert.equal(DEFAULT_SETTINGS.default_timer_mode, 'stopwatch');
    const original = getSetting('default_timer_mode') ?? 'stopwatch';
    try {
      const shipped = startSession({ projectId, title: 'Shipped default' });
      assert.equal(shipped.mode, 'stopwatch');
      assert.equal(shipped.plannedMinutes, null);
      stopSession(shipped.id, 'abandoned');

      setSettings({ default_timer_mode: 'pomodoro' });
      const switched = startSession({ projectId, title: 'Setting says pomodoro' });
      assert.equal(switched.mode, 'pomodoro');
      assert.equal(switched.plannedMinutes, getNumber('focus_minutes', 45));
      stopSession(switched.id, 'abandoned');

      // An explicit mode beats the setting in both directions.
      const forced = startSession({ projectId, title: 'Forced stopwatch', mode: 'stopwatch' });
      assert.equal(forced.mode, 'stopwatch');
      stopSession(forced.id, 'abandoned');

      setSettings({ default_timer_mode: 'stopwatch' });
      const counted = startSession({ projectId, title: 'Forced pomodoro', mode: 'pomodoro' });
      assert.equal(counted.mode, 'pomodoro');
      assert.equal(counted.plannedMinutes, getNumber('focus_minutes', 45));
      stopSession(counted.id, 'abandoned');
    } finally {
      setSettings({ default_timer_mode: original });
    }
  });

  it('still plans a break from the break setting when asked for a countdown', async () => {
    const { startSession, stopSession } = await mod();
    const { getNumber } = await settings();
    const s = startSession({ projectId, title: 'Stretch', kind: 'break', mode: 'pomodoro' });
    assert.equal(s.plannedMinutes, getNumber('short_break_minutes', 10));
    stopSession(s.id, 'abandoned');
  });

  it('keeps a break a countdown at the break length, whatever the default mode is', async () => {
    const { startSession, stopSession } = await mod();
    const { getSetting, setSettings } = await settings();
    const shipped = getSetting('default_timer_mode');
    assert.equal(shipped, 'stopwatch', 'precondition: the shipped default is a stopwatch');
    const original = getSetting('short_break_minutes') ?? '10';
    try {
      // Nothing said about mode or length: a rest still has an end, and the setting sets it.
      const standard = startSession({ title: 'Stretch', kind: 'break' });
      assert.equal(standard.mode, 'pomodoro');
      assert.equal(standard.plannedMinutes, 10);
      stopSession(standard.id, 'abandoned');

      setSettings({ short_break_minutes: 3 });
      const shorter = startSession({ title: 'Quick breather', kind: 'break' });
      assert.equal(shorter.mode, 'pomodoro');
      assert.equal(shorter.plannedMinutes, 3);
      stopSession(shorter.id, 'abandoned');
    } finally {
      setSettings({ short_break_minutes: original });
    }
  });

  it('treats a bare plannedMinutes as a countdown of that length', async () => {
    const { startSession, stopSession } = await mod();
    // The shipped default is a stopwatch; a caller that names a length still gets a countdown.
    const s = startSession({ projectId, title: 'Old-style start', plannedMinutes: 25 });
    assert.equal(s.mode, 'pomodoro');
    assert.equal(s.plannedMinutes, 25);
    assert.equal(s.plannedSeconds, 1500);
    assert.ok(s.remainingSeconds! > 1490 && s.remainingSeconds! <= 1500);
    assert.equal(s.overrunSeconds, 0);
    stopSession(s.id, 'abandoned');
  });

  it('stores the estimate and still measures the clock against the plan', async () => {
    const { getSessionRow } = await mod();
    // Same countdown, same work, wildly different guess: nothing else may differ.
    const plain = await finishedBlock(
      { projectId, title: 'No guess', plannedMinutes: 45 },
      3000,
      4,
    );
    const guessed = await finishedBlock(
      { projectId, title: 'Bad guess', plannedMinutes: 45, estimatedMinutes: 5 },
      3000,
      4,
    );
    assert.equal(plain.estimatedMinutes, null);
    assert.equal(guessed.estimatedMinutes, 5);
    assert.equal(getSessionRow(guessed.id).estimated_minutes, 5);
    assert.equal(guessed.remainingSeconds, plain.remainingSeconds);
    // Overrun is measured against the 45-minute plan, not the 5-minute guess.
    assert.equal(guessed.overrunSeconds, 300);
    assert.equal(guessed.overrunSeconds, plain.overrunSeconds);

    // A stopwatch has no plan, and a guess does not give it one.
    const estimated = await finishedBlock(
      { projectId, title: 'Open, estimated', mode: 'stopwatch', estimatedMinutes: 30 },
      3 * 3600,
      4,
    );
    assert.equal(estimated.estimatedMinutes, 30);
    assert.equal(estimated.remainingSeconds, null);
    assert.equal(estimated.overrunSeconds, null);
  });

  it('scores against the plan and never the estimate', async () => {
    // Each block is short of whatever it might be measured against, so a guess that
    // leaked in as the denominator would move the score.
    // 600s of a 45-minute plan is 600/2700 complete: 100 * (0.45 + 0.25 * 600/2700 + 0.15)
    // = 65.6, so 66. With the 5-minute guess standing in for the plan it would read as done: 85.
    const countdown = await finishedBlock(
      { projectId, title: 'Short of the plan', plannedMinutes: 45, estimatedMinutes: 5 },
      600,
      4,
    );
    assert.equal(countdown.focusScore, 66);

    // A stopwatch has nothing to fall short of: 85. Treating its 60-minute guess as a plan
    // would make 600s a sixth of the block and score 64.
    const open = await finishedBlock(
      { projectId, title: 'Open against a guess', mode: 'stopwatch', estimatedMinutes: 60 },
      600,
      4,
    );
    assert.equal(open.focusScore, 85);
  });

  it('refuses to extend, and stays a stopwatch', async () => {
    const { startSession, extendSession, getSessionRow, toView, stopSession } = await mod();
    const s = startSession({ projectId, title: 'No extending', mode: 'stopwatch' });
    assert.throws(() => extendSession(s.id, 5), {
      status: 409,
      message: /no planned length to extend/,
    });
    assert.throws(() => extendSession(s.id, -5), { status: 409 });
    assert.equal(getSessionRow(s.id).planned_minutes, null);
    assert.equal(toView(getSessionRow(s.id)).mode, 'stopwatch');
    stopSession(s.id, 'abandoned');

    // Countdowns still extend.
    const p = startSession({ projectId, title: 'Extendable', plannedMinutes: 45 });
    assert.equal(extendSession(p.id, 5).plannedMinutes, 50);
    stopSession(p.id, 'abandoned');
  });

  it('keeps its elapsed time when stopped and scores as complete', async () => {
    const { db } = await dbMod();
    const { startSession, stopSession, getSessionRow, toView } = await mod();
    const s = startSession({ projectId, title: 'A long open-ended stretch', mode: 'stopwatch' });
    // Backdate the open segment: forty minutes of work without waiting forty minutes.
    db.prepare('UPDATE session_segments SET started_at = ? WHERE session_id = ?').run(
      new Date(Date.now() - 40 * 60_000).toISOString(),
      s.id,
    );
    const done = stopSession(s.id, 'completed', { focusRating: 4 });
    assert.ok(Math.abs(done.elapsedSeconds - 2400) <= 2, `got ${done.elapsedSeconds}`);
    assert.equal(done.focusScore, 85);
    assert.equal(done.plannedSeconds, null);

    // Persisted, not just computed on the way out.
    const reread = toView(getSessionRow(s.id));
    assert.equal(reread.elapsedSeconds, done.elapsedSeconds);
    assert.equal(reread.status, 'completed');
    assert.equal(reread.mode, 'stopwatch');
  });

  it('lets interruptions lower the score of a stopped stopwatch', async () => {
    const { startSession, addInterruption, stopSession } = await mod();
    const s = startSession({ projectId, title: 'Fielding pings', mode: 'stopwatch' });
    addInterruption(s.id, 4);
    const done = stopSession(s.id, 'completed', { focusRating: 4, activeSeconds: 1800 });
    assert.ok(done.focusScore! < 85, `got ${done.focusScore}`);
  });
});

describe('saved timers keep their mode', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;
  let tick = 0;

  /** A finished block, placed at an explicit time so "most recent" never rests on a tie. */
  async function logRun(
    title: string,
    project: number | null,
    input: Partial<StartInput>,
    status: 'completed' | 'abandoned' = 'completed',
  ) {
    const { startSession, stopSession } = await mod();
    const { db } = await dbMod();
    const s = startSession({ projectId: project, title, ...input });
    stopSession(s.id, status);
    const startedAt = new Date(Date.UTC(2026, 8, 1) + ++tick * 3_600_000).toISOString();
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(startedAt, s.id);
  }

  type TimerJson = {
    title: string;
    mode: string;
    plannedMinutes: number | null;
    pinned: boolean;
    useCount: number;
  };
  const timer = (list: TimerJson[], title: string) => {
    const found = list.find((t) => t.title === title);
    assert.ok(found, `no timer titled "${title}" in ${list.map((t) => t.title).join(', ')}`);
    return found;
  };

  before(async () => {
    const db = await freshDb();
    db.exec('DELETE FROM saved_timers');
    projectId = await makeProject('ROI Dashboard');
    api = await serve();
  });

  after(() => api.close());

  it('stores the mode a timer is pinned with', async () => {
    const res = await api.call('POST', '/timers', {
      projectId,
      title: 'Deep work',
      mode: 'stopwatch',
    });
    assert.equal(res.status, 201);
    const pinned = timer(res.body, 'Deep work');
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.mode, 'stopwatch');
    assert.equal(pinned.plannedMinutes, null);

    const { db } = await dbMod();
    const stored = db.prepare("SELECT mode FROM saved_timers WHERE title = 'Deep work'").get() as {
      mode: string;
    };
    assert.equal(stored.mode, 'stopwatch');
  });

  it('pins as a pomodoro when the client names no mode, as older clients do', async () => {
    const res = await api.call('POST', '/timers', {
      projectId,
      title: 'Old client',
      plannedMinutes: 30,
    });
    const pinned = timer(res.body, 'Old client');
    assert.equal(pinned.mode, 'pomodoro');
    assert.equal(pinned.plannedMinutes, 30);
  });

  it('never gives a pinned stopwatch a length, even when its history has one', async () => {
    await logRun('Deep work', projectId, { plannedMinutes: 50 });
    const list = (await api.call('GET', '/timers')).body;
    const pinned = timer(list, 'Deep work');
    assert.equal(pinned.mode, 'stopwatch');
    assert.equal(pinned.plannedMinutes, null);
    assert.equal(pinned.useCount, 1, 'its history still counts');
  });

  it('suggests the mode a pair was last run in, not the one it was run in most', async () => {
    // Two countdowns, then a stopwatch: the stopwatch is what you do now.
    await logRun('Standup prep', projectId, { plannedMinutes: 25 });
    await logRun('Standup prep', projectId, { plannedMinutes: 25 });
    await logRun('Standup prep', projectId, { mode: 'stopwatch' });
    // A stopwatch, then a countdown.
    await logRun('Report writing', projectId, { mode: 'stopwatch' });
    await logRun('Report writing', projectId, { plannedMinutes: 50 });
    // An abandoned block, however recent, is not what you last did.
    await logRun('Report writing', projectId, { mode: 'stopwatch' }, 'abandoned');
    // No project at all still groups, and still reads the latest run.
    await logRun('Inbox zero', null, { mode: 'stopwatch' });
    await logRun('Inbox zero', null, { mode: 'stopwatch' });

    const list = (await api.call('GET', '/timers')).body;
    const standup = timer(list, 'Standup prep');
    assert.equal(standup.pinned, false);
    assert.equal(standup.useCount, 3);
    assert.equal(standup.mode, 'stopwatch');
    assert.equal(standup.plannedMinutes, null);

    const report = timer(list, 'Report writing');
    assert.equal(report.mode, 'pomodoro');
    assert.equal(report.plannedMinutes, 50);

    const inbox = timer(list, 'Inbox zero');
    assert.equal(inbox.mode, 'stopwatch');
    assert.equal(inbox.plannedMinutes, null);
  });
});

describe('stopwatch over the API', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await freshDb();
    projectId = await makeProject('ROI Dashboard');
    api = await serve();
  });

  beforeEach(clearLive);

  after(() => api.close());

  /** Start a stopwatch over HTTP and finish it, so PATCH is allowed to rewrite its time. */
  async function finishedStopwatch(title: string) {
    const started = await api.call('POST', '/sessions', { projectId, title, mode: 'stopwatch' });
    const done = await api.call('POST', `/sessions/${started.body.id}/complete`, {
      focusRating: 4,
      activeSeconds: 600,
    });
    return done.body;
  }

  it('starts a stopwatch from a mode and an optional estimate', async () => {
    const res = await api.call('POST', '/sessions', {
      projectId,
      title: 'Over HTTP',
      mode: 'stopwatch',
      estimatedMinutes: 20,
    });
    assert.equal(res.status, 201);
    // Real nulls in the JSON, not missing keys.
    assert.equal(res.body.mode, 'stopwatch');
    assert.equal(res.body.plannedMinutes, null);
    assert.equal(res.body.plannedSeconds, null);
    assert.equal(res.body.remainingSeconds, null);
    assert.equal(res.body.overrunSeconds, null);
    assert.equal(res.body.estimatedMinutes, 20);
  });

  it('still starts a countdown from plannedMinutes alone', async () => {
    const res = await api.call('POST', '/sessions', {
      projectId,
      title: 'Old client',
      plannedMinutes: 25,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.mode, 'pomodoro');
    assert.equal(res.body.plannedMinutes, 25);
  });

  it('refuses a stopwatch that is also given a length, and starts nothing', async () => {
    const body = { projectId, title: 'Both', mode: 'stopwatch', plannedMinutes: 45 };
    const res = await api.call('POST', '/sessions', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A stopwatch has no planned length');
    assert.equal((await api.call('GET', '/sessions/active')).body.session, null);
  });

  it('rejects an unknown mode and an estimate outside 1-480 minutes', async () => {
    const bad = { projectId, title: 'Rejected' };
    assert.equal(await api.status('POST', '/sessions', { ...bad, mode: 'countdown' }), 400);
    assert.equal(await api.status('POST', '/sessions', { ...bad, estimatedMinutes: 0 }), 400);
    assert.equal(await api.status('POST', '/sessions', { ...bad, estimatedMinutes: 481 }), 400);
    assert.equal((await api.call('GET', '/sessions/active')).body.session, null);
  });

  it('answers 409 to extending a stopwatch', async () => {
    const started = await api.call('POST', '/sessions', {
      projectId,
      title: 'Fixed?',
      mode: 'stopwatch',
    });
    const url = `/sessions/${started.body.id}`;
    assert.equal(await api.status('POST', `${url}/extend`, { minutes: 5 }), 409);
    const after = await api.call('GET', url);
    assert.equal(after.body.mode, 'stopwatch');
    assert.equal(after.body.plannedMinutes, null);
  });

  it('refuses to give a stopwatch a plan through PATCH, and changes nothing', async () => {
    const block = await finishedStopwatch('No conversion');
    // activeSeconds rides along to prove nothing is written before the refusal.
    const patch = { plannedMinutes: 30, activeSeconds: 5 };
    assert.equal(await api.status('PATCH', `/sessions/${block.id}`, patch), 400);
    const after = (await api.call('GET', `/sessions/${block.id}`)).body;
    assert.equal(after.mode, 'stopwatch');
    assert.equal(after.plannedMinutes, null);
    assert.equal(after.elapsedSeconds, 600);
  });

  it('edits and clears an estimate through PATCH', async () => {
    const block = await finishedStopwatch('Estimate later');
    const url = `/sessions/${block.id}`;
    const set = await api.call('PATCH', url, { estimatedMinutes: 45 });
    assert.equal(set.status, 200);
    assert.equal(set.body.estimatedMinutes, 45);
    assert.equal(set.body.mode, 'stopwatch');
    assert.equal(set.body.focusScore, block.focusScore, 'the estimate must not move the score');

    const cleared = await api.call('PATCH', url, { estimatedMinutes: null });
    assert.equal(cleared.body.estimatedMinutes, null);

    assert.equal(await api.status('PATCH', url, { estimatedMinutes: 0 }), 400);
    assert.equal(await api.status('PATCH', url, { estimatedMinutes: 481 }), 400);
  });

  it('still lets a countdown change its plan through PATCH', async () => {
    const started = await api.call('POST', '/sessions', {
      projectId,
      title: 'Replan',
      plannedMinutes: 25,
    });
    const res = await api.call('PATCH', `/sessions/${started.body.id}`, { plannedMinutes: 40 });
    assert.equal(res.status, 200);
    assert.equal(res.body.plannedMinutes, 40);
    assert.equal(res.body.mode, 'pomodoro');
  });

  it('accepts only the two modes as the default timer', async () => {
    const original = (await api.call('GET', '/settings')).body.default_timer_mode;
    assert.equal(original, 'stopwatch');
    try {
      const ok = await api.call('PATCH', '/settings', { default_timer_mode: 'pomodoro' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.default_timer_mode, 'pomodoro');
      const bad = { default_timer_mode: 'countdown' };
      assert.equal(await api.status('PATCH', '/settings', bad), 400);
      assert.equal((await api.call('GET', '/settings')).body.default_timer_mode, 'pomodoro');
    } finally {
      await api.call('PATCH', '/settings', { default_timer_mode: original });
    }
  });
});

describe('stopping and editing a block over the API', () => {
  let projectId = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await freshDb();
    projectId = await makeProject('ROI Dashboard');
    api = await serve();
  });

  beforeEach(clearLive);

  after(() => api.close());

  /** Every column of the block and every one of its segments, so "unchanged" means all of it. */
  async function stored(id: number) {
    const { db } = await dbMod();
    return {
      block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow,
      segments: db
        .prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id')
        .all(id),
    };
  }

  /** A finished 50-minute block worked in two sittings, so a collapse into one span shows. */
  async function twoSittings(title: string) {
    const { logManualSession } = await mod();
    const { db } = await dbMod();
    const block = logManualSession({
      projectId,
      title,
      startedAt: '2026-09-09T09:00:00.000Z',
      minutes: 50,
      focusRating: 4,
    });
    db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(block.id);
    const add = db.prepare(
      'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
    );
    add.run(block.id, '2026-09-09T09:00:00.000Z', '2026-09-09T09:30:00.000Z');
    add.run(block.id, '2026-09-09T10:00:00.000Z', '2026-09-09T10:20:00.000Z');
    return block.id;
  }

  it('refuses a logged time of zero when stopping, and leaves the block as it was', async () => {
    const started = await api.call('POST', '/sessions', {
      projectId,
      title: 'Zero',
      plannedMinutes: 45,
    });
    const id = started.body.id;
    // Ten real minutes behind it, paused so every second of them is flushed to the block.
    const { db } = await dbMod();
    db.prepare('UPDATE session_segments SET started_at = ? WHERE session_id = ?').run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      id,
    );
    await api.call('POST', `/sessions/${id}/pause`);
    const before = await stored(id);
    const worked = before.block.active_seconds;
    assert.ok(Math.abs(worked - 600) <= 2, `precondition: ten minutes worked, got ${worked}s`);

    assert.equal(await api.status('POST', `/sessions/${id}/complete`, { activeSeconds: 0 }), 400);
    assert.equal(await api.status('POST', `/sessions/${id}/abandon`, { activeSeconds: 0 }), 400);

    assert.deepEqual(await stored(id), before);
    const after = (await api.call('GET', `/sessions/${id}`)).body;
    assert.equal(after.status, 'paused');
    assert.equal(after.elapsedSeconds, before.block.active_seconds);
  });

  it('still accepts one second, the least that can be logged', async () => {
    const started = await api.call('POST', '/sessions', {
      projectId,
      title: 'One second',
      plannedMinutes: 45,
    });
    const done = await api.call('POST', `/sessions/${started.body.id}/complete`, {
      focusRating: 4,
      activeSeconds: 1,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'completed');
    assert.equal(done.body.elapsedSeconds, 1);
  });

  it('applies a PATCH whole or not at all', async () => {
    const id = await twoSittings('Atomic edit');
    const { db } = await dbMod();
    const before = await stored(id);
    assert.equal(before.block.active_seconds, 3000);
    assert.equal(before.segments.length, 2);

    // The time is rewritten first and the edit's own update then fails, as a full disk would:
    // both must unwind. (A project that is not there never gets this far, it is refused with a
    // 400 before anything is written, so the failure is made here by a TEMP trigger that is
    // dropped again below.)
    db.exec(`CREATE TEMP TRIGGER fail_the_edit BEFORE UPDATE OF title ON sessions
             WHEN NEW.title = 'tripwire' BEGIN SELECT RAISE(ABORT, 'tripwire'); END`);
    const good = { activeSeconds: 60, estimatedMinutes: 30 };
    const bad = { ...good, title: 'tripwire' };
    // The server logs the failure it answers with; keep that stack trace out of the report.
    const quiet = mock.method(console, 'error', () => {});
    let failed;
    try {
      failed = await api.call('PATCH', `/sessions/${id}`, bad);
    } finally {
      quiet.mock.restore();
      db.exec('DROP TRIGGER IF EXISTS fail_the_edit');
    }
    // Exactly the 500 the trigger causes: a 400 would mean it was refused before the writes,
    // and this would no longer be testing the unwinding.
    assert.equal(failed.status, 500);
    assert.match(failed.body.details, /tripwire/);
    assert.deepEqual(await stored(id), before);

    // Without the failing title the same request goes through, all of it.
    const ok = await api.call('PATCH', `/sessions/${id}`, good);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.elapsedSeconds, 60);
    assert.equal(ok.body.estimatedMinutes, 30);
    assert.equal((await stored(id)).segments.length, 1);
  });

  it('answers 400 to a project that is not there when starting a block, and starts nothing', async () => {
    const { db } = await dbMod();
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const [blocks, segments] = [count('sessions'), count('session_segments')];

    const res = await api.call('POST', '/sessions', { title: 'Nowhere', projectId: 999_999 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown project');
    assert.equal(count('sessions'), blocks);
    assert.equal(count('session_segments'), segments);
    assert.equal((await api.call('GET', '/sessions/active')).body.session, null);

    // A project that is there, and an explicit none, are unaffected.
    const named = await api.call('POST', '/sessions', { title: 'Somewhere', projectId });
    assert.equal(named.status, 201);
    assert.equal(named.body.projectId, projectId);
    await api.call('POST', `/sessions/${named.body.id}/abandon`);
    const none = await api.call('POST', '/sessions', {
      title: 'Nowhere on purpose',
      projectId: null,
    });
    assert.equal(none.status, 201);
    assert.equal(none.body.projectId, null);
  });

  it('answers 400 to a project that is not there when editing a block, and leaves it as it was', async () => {
    const id = await twoSittings('Stays put');
    const before = await stored(id);

    // The rest of the edit rides along to prove none of it is written before the refusal.
    const res = await api.call('PATCH', `/sessions/${id}`, {
      projectId: 999_999,
      title: 'Renamed',
      activeSeconds: 60,
      estimatedMinutes: 30,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Unknown project');
    assert.deepEqual(await stored(id), before);

    // An explicit none still clears the project.
    const cleared = await api.call('PATCH', `/sessions/${id}`, { projectId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.projectId, null);
  });

  it('refuses to rewrite the time of a block still on the clock, and changes nothing', async () => {
    const started = await api.call('POST', '/sessions', {
      projectId,
      title: 'Still ticking',
      plannedMinutes: 45,
    });
    const id = started.body.id;
    const before = await stored(id);

    const res = await api.call('PATCH', `/sessions/${id}`, { activeSeconds: 60, title: 'Renamed' });
    assert.equal(res.status, 400);
    assert.deepEqual(await stored(id), before);
  });
});

/** A database as it stood before migration `id`: every earlier one applied, nothing else. */
async function databaseBefore(conn: Database.Database, id: number, appliedAt: string) {
  const { migrations } = await dbMod();
  conn.exec(`CREATE TABLE _migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const m of migrations.filter((m) => m.id < id)) {
    conn.exec(m.up);
    conn
      .prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
      .run(m.id, m.name, appliedAt);
  }
}

describe('migration 3 on an existing database', () => {
  let dir = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-migrate-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = (conn: Database.Database, table: string) =>
    (conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const backupsIn = (where: string) =>
    fs.readdirSync(where).filter((f) => /^focusdesk\.backup-before-\d+-.+\.sqlite$/.test(f));

  it('keeps every row, accepts a null plan, and leaves a pre-migration backup', async () => {
    const { migrations, runMigrations } = await dbMod();
    const { toView } = await mod();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      // The database as it stood before stopwatch shipped: migrations 1 and 2 only.
      const stamp = '2026-09-10T10:00:00.000Z';
      const end = '2026-09-10T10:45:00.000Z';
      await databaseBefore(conn, 3, stamp);
      conn
        .prepare(
          `INSERT INTO sessions (id, title, planned_minutes, started_at, ended_at, local_day,
             active_seconds, focus_rating, status, created_at, updated_at)
           VALUES (7, 'Old block', 45, ?, ?, '2026-09-10', 2700, 4, 'completed', ?, ?)`,
        )
        .run(stamp, end, stamp, stamp);
      conn
        .prepare(
          `INSERT INTO session_segments (id, session_id, started_at, ended_at)
           VALUES (11, 7, ?, ?)`,
        )
        .run(stamp, end);
      conn
        .prepare(
          `INSERT INTO saved_timers (title, planned_minutes, position, created_at)
           VALUES ('Pinned before', 30, 0, ?)`,
        )
        .run(stamp);

      runMigrations(conn, file);

      // Nothing was lost, and old blocks read back as the fixed-length blocks they were.
      // The runner applies everything pending, so every migration after the 3 under test
      // follows it.
      assert.deepEqual(
        conn.prepare('SELECT id FROM _migrations ORDER BY id').all(),
        migrations.map((m) => ({ id: m.id })),
      );
      const old = conn.prepare('SELECT * FROM sessions WHERE id = 7').get() as SessionRow;
      assert.equal(old.title, 'Old block');
      assert.equal(old.planned_minutes, 45);
      assert.equal(old.active_seconds, 2700);
      assert.equal(old.estimated_minutes, null);
      assert.equal(toView(old).mode, 'pomodoro');
      assert.deepEqual(conn.prepare('SELECT id, session_id FROM session_segments').all(), [
        { id: 11, session_id: 7 },
      ]);
      assert.deepEqual(
        conn.prepare('SELECT title, planned_minutes, mode FROM saved_timers').all(),
        [{ title: 'Pinned before', planned_minutes: 30, mode: 'pomodoro' }],
      );

      // A null plan is accepted and reads back as a stopwatch.
      const insert = conn.prepare(
        `INSERT INTO sessions (title, planned_minutes, estimated_minutes, started_at, local_day,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, '2026-09-11', ?, ?, ?)`,
      );
      const made = insert.run('Stopwatch block', null, 30, stamp, 'completed', stamp, stamp);
      const stopwatch = conn
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(Number(made.lastInsertRowid)) as SessionRow;
      assert.equal(stopwatch.planned_minutes, null);
      assert.equal(toView(stopwatch).mode, 'stopwatch');

      // The new constraints bite, and the old ones still do.
      assert.throws(() => insert.run('Zero', 45, 0, stamp, 'completed', stamp, stamp), /CHECK/);
      assert.throws(() => insert.run('Huge', 45, 481, stamp, 'completed', stamp, stamp), /CHECK/);
      assert.throws(
        () =>
          conn
            .prepare("INSERT INTO saved_timers (title, mode, created_at) VALUES ('x', 'bogus', ?)")
            .run(stamp),
        /CHECK/,
      );
      insert.run('Live one', null, null, stamp, 'running', stamp, stamp);
      assert.throws(
        () => insert.run('Live two', null, null, stamp, 'running', stamp, stamp),
        /UNIQUE/,
      );

      // Cascades survived the table change.
      conn.prepare('DELETE FROM sessions WHERE id = 7').run();
      assert.equal(count(conn, 'session_segments'), 0);

      // The saved-timer list's per-pair lookup has its index.
      assert.deepEqual(
        conn
          .prepare("SELECT name FROM pragma_index_info('sessions_pair_recent') ORDER BY seqno")
          .all(),
        [{ name: 'project_id' }, { name: 'title' }, { name: 'started_at' }],
      );

      // One backup, taken before migration 3 touched anything.
      const backups = backupsIn(dir);
      assert.equal(backups.length, 1, `got ${backups.join(', ')}`);
      assert.match(backups[0]!, /^focusdesk\.backup-before-3-/);
      const before = new Database(path.join(dir, backups[0]!));
      try {
        assert.deepEqual(before.prepare('SELECT id FROM _migrations ORDER BY id').all(), [
          { id: 1 },
          { id: 2 },
        ]);
        const cols = before.prepare('PRAGMA table_info(sessions)').all() as {
          name: string;
          notnull: number;
        }[];
        assert.equal(cols.find((c) => c.name === 'planned_minutes')?.notnull, 1);
        assert.ok(!cols.some((c) => c.name === 'estimated_minutes'));
        assert.equal(count(before, 'sessions'), 1);
      } finally {
        before.close();
      }

      // Already up to date: nothing pending, so nothing new to back up.
      runMigrations(conn, file);
      assert.equal(backupsIn(dir).length, 1);
    } finally {
      conn.close();
    }
  });
});

describe('pre-migration backup', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-backup-'));
    dirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots an existing database beside it, including rows still in the WAL', async () => {
    const { backupBeforeMigrating } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    try {
      conn.pragma('journal_mode = WAL');
      conn.exec("CREATE TABLE history (note TEXT); INSERT INTO history VALUES ('in the WAL');");
      assert.ok(fs.statSync(`${file}-wal`).size > 0, 'precondition: the row is in the -wal file');

      const backup = backupBeforeMigrating(conn, file, 2, 3);

      assert.ok(backup, 'an existing database must be backed up');
      assert.equal(path.dirname(backup), dir);
      // Milliseconds in the name: VACUUM INTO will not overwrite an existing file.
      assert.match(
        path.basename(backup),
        /^focusdesk\.backup-before-3-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/,
      );
      // One self-contained file that opens on its own and holds what the WAL held.
      assert.ok(!fs.existsSync(`${backup}-wal`), 'a backup must not need a -wal beside it');
      const copy = new Database(backup);
      try {
        assert.deepEqual(copy.prepare('SELECT note FROM history').all(), [{ note: 'in the WAL' }]);
      } finally {
        copy.close();
      }
    } finally {
      conn.close();
    }
  });

  it('is a consistent snapshot even while another connection holds a read open', async () => {
    const { backupBeforeMigrating } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    // A short busy timeout: a checkpoint-and-copy backup would otherwise sit out the
    // reader for five seconds before failing the same way.
    const conn = new Database(file, { timeout: 50 });
    try {
      conn.pragma('journal_mode = WAL');
      conn.exec('CREATE TABLE history (note TEXT)');
      const add = conn.prepare('INSERT INTO history VALUES (?)');
      add.run('first');
      add.run('second');

      // A DB browser or a second instance mid-read pins the snapshot it started with...
      const reader = new Database(file);
      try {
        reader.exec('BEGIN');
        reader.prepare('SELECT COUNT(*) AS n FROM history').get();
        // ...so a write that lands now cannot be folded into the main file.
        add.run('newest');

        const backup = backupBeforeMigrating(conn, file, 2, 3);

        assert.ok(backup, 'an existing database must be backed up');
        // Copying the main file here gives "database disk image is malformed".
        const copy = new Database(backup, { readonly: true });
        try {
          assert.deepEqual(copy.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
          assert.deepEqual(copy.prepare('SELECT note FROM history ORDER BY rowid').all(), [
            { note: 'first' },
            { note: 'second' },
            { note: 'newest' },
          ]);
        } finally {
          copy.close();
        }
      } finally {
        reader.close();
      }
    } finally {
      conn.close();
    }
  });

  it('takes no backup for a fresh install', async () => {
    const { backupBeforeMigrating, migrations, runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    try {
      conn.pragma('journal_mode = WAL');
      // Nothing applied yet means nothing to lose.
      assert.equal(backupBeforeMigrating(conn, file, 0, 1), null);

      // And the whole runner agrees: it builds the schema without leaving a copy behind.
      runMigrations(conn, file);
      const applied = conn.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
      assert.equal(applied.n, migrations.length);
      assert.deepEqual(
        fs.readdirSync(dir).filter((f) => f.includes('backup')),
        [],
      );
    } finally {
      conn.close();
    }
  });

  it('stops before migrating when the backup cannot be written', async () => {
    const { runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    try {
      conn.pragma('journal_mode = WAL');
      await databaseBefore(conn, 3, '2026-09-10T10:00:00.000Z');

      // The backup is written beside `file`, and that folder is not there.
      const elsewhere = path.join(dir, 'missing', 'focusdesk.sqlite');
      assert.throws(() => runMigrations(conn, elsewhere), { code: 'SQLITE_CANTOPEN' });

      // Better not to start than to migrate with nothing to go back to.
      assert.deepEqual(conn.prepare('SELECT id FROM _migrations ORDER BY id').all(), [
        { id: 1 },
        { id: 2 },
      ]);
      const cols = conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      assert.ok(!cols.some((c) => c.name === 'estimated_minutes'), 'migration 3 must not have run');
    } finally {
      conn.close();
    }
  });
});

after(() => {
  // The scratch database lives in a temp dir; the OS reclaims it.
});
