import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, mock } from 'node:test';
import { freshDb } from './setup.js';

/** What the prompt, away and calendar tests share: a frozen clock, a clean database, the API. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** The day every test here is set on, a Monday. */
export const DAY = '2026-10-12';

/** An instant on that day: at('14:05') or at('14:05:30'). */
export const at = (time: string): string =>
  `${DAY}T${time.length === 5 ? `${time}:00` : time}.000Z`;

/** Stop the wall clock at an instant, so a running block's elapsed time and "now" are exact. */
export function freeze(iso: string): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}

export const advance = (ms: number): void => mock.timers.tick(ms);

/** Move the frozen clock forward to an instant. It cannot go back: freeze again for that. */
export function goTo(iso: string): void {
  advance(Date.parse(iso) - Date.now());
}

/**
 * A clean database with the user's day pinned to UTC, and every setting these features
 * read put back to what ships, so one test cannot leave another's choices behind.
 */
export async function reset() {
  const db = await freshDb();
  db.exec('DELETE FROM away_intervals; DELETE FROM prompt_state;');
  const { DEFAULT_SETTINGS } = await import('../src/db.js');
  const { setSettings } = await import('../src/lib/settings.js');
  setSettings({
    timezone: 'UTC',
    day_start_hour: 4,
    away_minutes: DEFAULT_SETTINGS.away_minutes!,
    long_block_minutes: DEFAULT_SETTINGS.long_block_minutes!,
    meeting_prompts: DEFAULT_SETTINGS.meeting_prompts!,
    work_days: DEFAULT_SETTINGS.work_days!,
    work_start: DEFAULT_SETTINGS.work_start!,
    work_end: DEFAULT_SETTINGS.work_end!,
    nudge_minutes: DEFAULT_SETTINGS.nudge_minutes!,
    wrapup_time: DEFAULT_SETTINGS.wrapup_time!,
  });
  // Every test is a server that has only just started. Its start is worked out at the first
  // listing and kept (a clock that goes on without the uptime is a Mac that slept), so one that
  // was kept from the test before would be hours behind a clock frozen somewhere else, and the
  // nudge would be due in tests that are not about it.
  (await import('../src/lib/reminders.js')).setServerStartedAt(null);
  return db;
}

/**
 * Fail every test in the describe block this is called in that logs an error. The engine
 * catches a provider that throws, logs it and carries on without it, which looks just like
 * a provider with nothing to ask: so a test that says "no prompt" has to say the provider
 * did not crash as well, and this is how every one of them does. A test that expects an
 * error mocks console.error itself, which takes the call before it gets here.
 */
export function failOnLoggedErrors(): void {
  let logged: string[] = [];
  let spy: { mock: { restore(): void } } | undefined;
  beforeEach(() => {
    logged = [];
    spy = mock.method(console, 'error', (...args: unknown[]) => {
      const text = args.map(String).join(' ');
      // Node says once, through here, that the mock timers these tests use are experimental.
      if (!text.includes('ExperimentalWarning')) logged.push(text);
    });
  });
  afterEach(() => {
    spy?.mock.restore();
    assert.deepEqual(logged, [], 'console.error was called');
  });
}

/** The id an away stretch is asked about under: its row, and the moment it was first reported. */
export async function awayPromptId(rowId: number): Promise<string> {
  const { db } = await import('../src/db.js');
  const row = db.prepare('SELECT created_at FROM away_intervals WHERE id = ?').get(rowId) as
    | { created_at: string }
    | undefined;
  if (!row) throw new Error(`There is no away stretch ${rowId}`);
  return `away:${rowId}:${Date.parse(row.created_at)}`;
}

/** The id the start of a meeting is asked about under: the meeting, and the block it would pause. */
export const startPromptId = (eventId: string, blockId: number): string =>
  `meeting-start:${eventId}:${blockId}`;

export async function makeProject(name: string, color = '#0ea5e9'): Promise<number> {
  const { db } = await import('../src/db.js');
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, color, now, now);
  return Number(info.lastInsertRowid);
}

/** A row in the synced calendar, as the sync would have left it. Returns its id. */
export async function addEvent(e: {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  projectId?: number | null;
  id?: string;
}): Promise<string> {
  const { db } = await import('../src/db.js');
  const id = e.id ?? `ics:test:${e.title}:${e.start}`;
  db.prepare(
    `INSERT INTO calendar_events
       (id, provider, calendar_id, title, starts_at, ends_at, all_day, local_day, project_id, synced_at)
     VALUES (?, 'ics:test', 'Test', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    e.title,
    e.start,
    e.end,
    e.allDay ? 1 : 0,
    e.start.slice(0, 10),
    e.projectId ?? null,
    e.start,
  );
  return id;
}

/** The API on a loopback port of its own, so a route's validation and wiring are tested too. */
export async function serve() {
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
    const json = text && res.headers.get('content-type')?.includes('json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (json ? JSON.parse(text) : text || undefined) as any };
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

export type Api = Awaited<ReturnType<typeof serve>>;
