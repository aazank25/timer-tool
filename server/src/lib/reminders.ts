import { db } from '../db.js';
import { badRequest } from './http.js';
import { clockSetting, instantAt, isoWeekday } from './local-time.js';
import { promptState, setPromptState } from './prompt-state.js';
import { clockTime, minutesPhrase } from './prompt-text.js';
import type { PromptProvider } from './prompts.js';
import { listSessions, liveSessionRow } from './sessions.js';
import { dayStartHour, getNumber, getSetting, tz } from './settings.js';
import { addDays, focusDay, localDay, weekStart } from './time.js';
import { isDayWrappedUp, isWeekReviewed } from './wrapup.js';

/**
 * The reminders: three prompts that are due at a time of day and not because of anything that
 * happened. The end of the day is due when you said it would be, the review of last week is
 * due when this week's work begins, and the start-a-block nudge is due when work hours have
 * gone quiet. Like every prompt they are worked out from the data as it stands, so one goes
 * away by itself the moment it is done, and the only thing written is a note in prompt_state
 * that one was dismissed.
 *
 * They run on every poll of every window, so each reads and nothing more, and rules out the
 * cheapest things first. Every time of day is read in the user's own timezone (see
 * local-time.ts), and the day is the focus day, the one the day-start hour turns over.
 */

const iso = (ms: number) => new Date(ms).toISOString();

/** The ISO weekdays that are work days. Blank is none, and so is anything that is not a list of them. */
function workDays(): Set<number> {
  return new Set(
    (getSetting('work_days') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
  );
}

/**
 * What the focus blocks of a stretch of days came to. The blocks are the ones wrapup.ts
 * counts (focus, and not thrown away) and a running one is counted by the time it has so
 * far, so a reminder names the same figure as the page it points at.
 */
function focusBetween(from: string, to: string): { seconds: number; blocks: number } {
  const blocks = listSessions({ from, to, kind: 'focus', limit: 10_000 }).filter(
    (s) => s.status !== 'abandoned',
  );
  return { seconds: blocks.reduce((sum, s) => sum + s.elapsedSeconds, 0), blocks: blocks.length };
}

const blocksPhrase = (n: number) => `${n} block${n === 1 ? '' : 's'}`;

/** A plain day as "Oct 5", in the machine's own style. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/* ------------------------------------------------------------ end of the day */

/**
 * "Time to wrap up the day": the day has had focus on it, it is past `wrapup_time`, and it
 * has not been wrapped up. It is for a work day only, so a Saturday session is not nagged
 * about, and it belongs to the focus day, so after midnight it is still asking about the
 * day that has not ended yet, until the day-start hour turns it over.
 */
export const wrapUpProvider: PromptProvider = {
  kind: 'wrapup',

  list(now) {
    const time = clockSetting(getSetting('wrapup_time'));
    if (!time) return [];
    const zone = tz();
    const startHour = dayStartHour();
    const day = focusDay(now, zone, startHour);
    if (!workDays().has(isoWeekday(day))) return [];

    // A time earlier than the day-start hour is in the small hours that end this day, so it
    // is on the next calendar day: a wrap-up at 01:00 means the night after, not the night before.
    const due = instantAt(Number(time.slice(0, 2)) < startHour ? addDays(day, 1) : day, time, zone);
    if (now.getTime() < due) return [];

    const id = `wrapup:${day}`;
    if (promptState(id) || isDayWrappedUp(day)) return [];
    const { seconds, blocks } = focusBetween(day, day);
    if (blocks === 0) return [];

    return [
      {
        id,
        kind: 'wrapup',
        title: 'Time to wrap up the day',
        body: `You have focused for ${minutesPhrase(seconds)} across ${blocksPhrase(blocks)} so far today.`,
        createdAt: iso(due),
        actions: [
          { id: 'open', label: 'Wrap up', primary: true, open: '/wrap-up' },
          { id: 'dismiss', label: 'Not today' },
        ],
      },
    ];
  },

  act(id, action) {
    if (action !== 'dismiss') throw badRequest(`Unknown action: ${action}`);
    setPromptState(id, 'dismissed');
  },
};

/* ------------------------------------------------------------- last week */

/**
 * "Review last week": from the time work starts on the first work day of a week, until that
 * week ends, when the week before had focus on it and has not been reviewed. It is named by
 * last week's Monday, so it is a different prompt every week, and the one for a week that
 * has gone by is not there to be asked again.
 */
export const weekReviewProvider: PromptProvider = {
  kind: 'week-review',

  list(now) {
    const start = clockSetting(getSetting('work_start'));
    if (!start) return [];
    const zone = tz();
    const days = workDays();
    const week = weekStart(focusDay(now, zone, dayStartHour()));
    // Monday, unless Monday is not a work day. With no work days at all there is nothing to begin.
    const first = Array.from({ length: 7 }, (_, n) => addDays(week, n)).find((d) =>
      days.has(isoWeekday(d)),
    );
    if (!first) return [];
    const due = instantAt(first, start, zone);
    if (now.getTime() < due) return [];

    const last = addDays(week, -7);
    const id = `week-review:${last}`;
    if (promptState(id) || isWeekReviewed(last)) return [];
    const { seconds, blocks } = focusBetween(last, addDays(last, 6));
    if (blocks === 0) return [];

    return [
      {
        id,
        kind: 'week-review',
        title: 'Review last week',
        body: `The week of ${dayText(last)}, with ${minutesPhrase(seconds)} of focus.`,
        createdAt: iso(due),
        actions: [
          { id: 'open', label: 'Review', primary: true, open: `/wrap-up/week?week=${last}` },
          { id: 'dismiss', label: 'Not this week' },
        ],
      },
    ];
  },

  act(id, action) {
    if (action !== 'dismiss') throw badRequest(`Unknown action: ${action}`);
    setPromptState(id, 'dismissed');
  },
};

/* ----------------------------------------------------- nothing on the clock */

let startedAtOverride: number | null = null;
/** Where the process's own start was put the last time it was worked out: see serverStartedAt. */
let measuredStart: number | null = null;

/**
 * Say the server began at this instant, or go back to the real one with null. For tests,
 * which cannot wait through a quarter of an hour: they set a start that suits the time they
 * have frozen the clock at.
 */
export function setServerStartedAt(ms: number | null): void {
  startedAtOverride = ms;
  measuredStart = null;
}

/**
 * When the server began, which is as far back as it can say that nothing has been on the
 * clock. It is the process's uptime counted back from `now` rather than a time noted when the
 * module loaded, which comes to the same instant in a running app and is not thrown off by a
 * clock that is set to some other day, as a test's is.
 *
 * It has to be one instant, because the quiet stretch is named by it to the millisecond. `now`
 * and the uptime are read a little apart, and a different amount apart each time (the
 * providers before this one have run in between), so counting back afresh would put the start
 * somewhere new on every poll: the same stretch would be a different prompt each time it is
 * listed, and a notification would be shown for each. A reading therefore only replaces the one
 * before it when it is more than a second away from it, which is the clock having been moved
 * (or a Mac that slept, which the uptime does not count), and not the jitter.
 */
function serverStartedAt(now: number): number {
  if (startedAtOverride !== null) return startedAtOverride;
  const reading = Math.floor(now - process.uptime() * 1000);
  if (measuredStart === null || Math.abs(reading - measuredStart) > 1_000) measuredStart = reading;
  return measuredStart;
}

/** The latest of the times a query finds, or 0 for none: a start nothing can come before. */
function latestOf(sql: string, ...args: string[]): number {
  const row = db.prepare(sql).get(...args) as { at: string | null } | undefined;
  return row?.at ? Date.parse(row.at) : 0;
}

/** Whether a timed event is going on at an instant. All-day ones are not: they say nothing about the hour. */
function inAMeeting(ms: number, day: string): boolean {
  // The day is the way in to the index. An event is filed under the day it starts on, and
  // a week back is further than any timed event goes on.
  return !!db
    .prepare(
      `SELECT 1 FROM calendar_events
        WHERE all_day = 0 AND local_day >= ? AND starts_at <= ? AND ends_at > ? LIMIT 1`,
    )
    .get(addDays(day, -7), iso(ms), iso(ms));
}

/** What a dismissal of this prompt has written its id under: every `idle:` key and nothing else. */
const IDLE_KEYS = "key >= 'idle:' AND key < 'idle;'";

/**
 * "Nothing on the clock": in work hours of a work day, with no block on the clock (running
 * or paused) and no meeting going on, for as long as `nudge_minutes`.
 *
 * How long it has been quiet runs from the latest of four moments: work starting, the last
 * block of any kind ending, the last time the nudge was dismissed, and the server starting,
 * so opening the app at 14:00 does not meet you with a question about the whole morning.
 * The prompt is named by that moment. A block, or a dismissal, moves it, which makes the
 * next one a different prompt, due another `nudge_minutes` on, and the app that shows them
 * knows it has not been told this one before.
 */
export const idleProvider: PromptProvider = {
  kind: 'idle',

  list(now) {
    const nudge = getNumber('nudge_minutes', 15);
    if (!(nudge > 0)) return [];
    const opens = clockSetting(getSetting('work_start'));
    const closes = clockSetting(getSetting('work_end'));
    if (!opens || !closes) return [];

    const zone = tz();
    const t = now.getTime();
    const day = focusDay(now, zone, dayStartHour());
    if (!workDays().has(isoWeekday(day))) return [];
    // Hours are times on the clock, so they are the calendar day's: at 01:00 it is still
    // yesterday for the focus day and well before work for the hours.
    const calendar = localDay(now, zone);
    const open = instantAt(calendar, opens, zone);
    const close = instantAt(calendar, closes, zone);
    if (t < open || t >= close) return [];

    if (liveSessionRow() || inAMeeting(t, day) || isDayWrappedUp(day)) return [];

    const since = Math.max(
      open,
      latestOf('SELECT MAX(ended_at) AS at FROM sessions WHERE ended_at >= ?', iso(open)),
      latestOf(
        `SELECT MAX(updated_at) AS at FROM prompt_state
          WHERE ${IDLE_KEYS} AND status = 'dismissed' AND updated_at >= ?`,
        iso(open),
      ),
      serverStartedAt(t),
    );
    const due = since + nudge * 60_000;
    if (t < due) return [];

    return [
      {
        id: `idle:${iso(since)}`,
        kind: 'idle',
        title: 'Nothing on the clock',
        body: `Since ${clockTime(iso(since))}. Start something?`,
        createdAt: iso(due),
        actions: [
          { id: 'open', label: 'Start a block', primary: true, open: '/' },
          { id: 'dismiss', label: 'Not now' },
        ],
      },
    ];
  },

  act(id, action) {
    if (action !== 'dismiss') throw badRequest(`Unknown action: ${action}`);
    // The note is what moves the next stretch's start: its time is the time it was dismissed.
    setPromptState(id, 'dismissed');
  },
};
