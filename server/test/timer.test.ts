import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { freshDb } from './setup.js';

const mod = () => import('../src/lib/sessions.js');
const stats = () => import('../src/lib/stats.js');
const settings = () => import('../src/lib/settings.js');

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
    projectId = await makeProject('RCM Dashboard');
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
  let rcm = 0;
  let ops = 0;

  before(async () => {
    await freshDb();
    rcm = await makeProject('RCM Dashboard', '#0ea5e9');
    ops = await makeProject('Care Mgmt Ops', '#f59e0b');
    const { logManualSession } = await mod();
    const { setSettings } = await settings();
    setSettings({ timezone: 'UTC', day_start_hour: 4, daily_target_minutes: 300 });

    logManualSession({
      projectId: rcm,
      title: 'Competitor teardown',
      startedAt: '2026-09-10T10:40:00.000Z',
      minutes: 45,
      focusRating: 4,
    });
    logManualSession({
      projectId: rcm,
      title: 'Denial taxonomy draft',
      startedAt: '2026-09-10T13:00:00.000Z',
      minutes: 50,
      focusRating: 5,
    });
    logManualSession({
      projectId: ops,
      title: 'Counselor escalations',
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
    assert.equal(d.byProject[0]?.name, 'RCM Dashboard');
    assert.equal(d.byProject[0]?.seconds, 95 * 60);
    assert.equal(d.byProject[0]?.blocks, 2);
    assert.equal(d.byProject[1]?.name, 'Care Mgmt Ops');
    // Shares are percentages of the day and add up.
    const shareTotal = d.byProject.reduce((a, p) => a + p.share, 0);
    assert.ok(Math.abs(shareTotal - 100) < 0.2, `shares summed to ${shareTotal}`);
  });

  it('averages the self-reported rating over rated blocks only', async () => {
    const { logManualSession } = await mod();
    logManualSession({
      projectId: rcm,
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
    const before = dayStats(new Date().toISOString().slice(0, 10)).focusSeconds;
    const s = startSession({ projectId: rcm, title: 'Gave up', plannedMinutes: 45 });
    stopSession(s.id, 'abandoned', { activeSeconds: 600 });
    const d = dayStats(new Date().toISOString().slice(0, 10));
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
    'SUMMARY:Weekly RCM standup',
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
    const standups = events.filter((e) => e.title === 'Weekly RCM standup');
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

after(() => {
  // The scratch database lives in a temp dir; the OS reclaims it.
});
