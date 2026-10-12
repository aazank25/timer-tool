import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath } from './lib/config.js';
import { hostTimeZone } from './lib/time.js';

export const db = new Database(dbPath());
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

type Migration = { id: number; name: string; up: string };

/**
 * Migrations are append-only. Never edit a shipped migration; add a new one.
 * Phase-2..4 tables (calendar_events, context_items, plan_items) ship in the
 * initial schema so the shape is stable before the integrations land.
 */
export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    up: `
    CREATE TABLE projects (
      id                    INTEGER PRIMARY KEY,
      name                  TEXT    NOT NULL,
      color                 TEXT    NOT NULL DEFAULT '#6366f1',
      description           TEXT,
      weekly_target_minutes INTEGER,
      notion_url            TEXT,
      archived              INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT    NOT NULL,
      updated_at            TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX projects_name_unique ON projects(name);

    -- One focus block. active_seconds is the sum of its segments and is the
    -- number every report is built on: paused time is never focused time.
    CREATE TABLE sessions (
      id                INTEGER PRIMARY KEY,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title             TEXT    NOT NULL,
      intent            TEXT,
      kind              TEXT    NOT NULL DEFAULT 'focus',
      planned_minutes   INTEGER NOT NULL,
      started_at        TEXT    NOT NULL,
      ended_at          TEXT,
      local_day         TEXT    NOT NULL,
      active_seconds    INTEGER NOT NULL DEFAULT 0,
      interruptions     INTEGER NOT NULL DEFAULT 0,
      focus_rating      INTEGER,
      notes             TEXT,
      status            TEXT    NOT NULL DEFAULT 'running',
      calendar_event_id TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      CHECK (kind IN ('focus','break')),
      CHECK (status IN ('running','paused','completed','abandoned')),
      CHECK (focus_rating IS NULL OR focus_rating BETWEEN 1 AND 5)
    );
    CREATE INDEX sessions_day       ON sessions(local_day);
    CREATE INDEX sessions_project   ON sessions(project_id);
    CREATE INDEX sessions_started   ON sessions(started_at);
    -- At most one live session at a time.
    CREATE UNIQUE INDEX sessions_one_live
      ON sessions((1)) WHERE status IN ('running','paused');

    -- Run/pause history. An open segment (ended_at IS NULL) means the clock
    -- is ticking, so elapsed time survives refreshes, sleep and restarts.
    CREATE TABLE session_segments (
      id         INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      started_at TEXT    NOT NULL,
      ended_at   TEXT
    );
    CREATE INDEX session_segments_session ON session_segments(session_id);

    CREATE TABLE plan_items (
      id                INTEGER PRIMARY KEY,
      plan_day          TEXT    NOT NULL,
      position          INTEGER NOT NULL DEFAULT 0,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title             TEXT    NOT NULL,
      planned_minutes   INTEGER NOT NULL DEFAULT 45,
      calendar_event_id TEXT,
      session_id        INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      done              INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL
    );
    CREATE INDEX plan_items_day ON plan_items(plan_day, position);

    -- Phase 3: mirror of the user's calendar, so blocks can be attributed to
    -- meetings and meetings rolled up under a project.
    CREATE TABLE calendar_events (
      id          TEXT    PRIMARY KEY,
      provider    TEXT    NOT NULL,
      calendar_id TEXT,
      title       TEXT,
      description TEXT,
      location    TEXT,
      starts_at   TEXT    NOT NULL,
      ends_at     TEXT    NOT NULL,
      all_day     INTEGER NOT NULL DEFAULT 0,
      attendees   TEXT,
      local_day   TEXT    NOT NULL,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      raw         TEXT,
      synced_at   TEXT    NOT NULL
    );
    CREATE INDEX calendar_events_day ON calendar_events(local_day);

    -- Phase 4: Notion pages, meeting notes and transcripts pulled in as
    -- context for a project or a specific block.
    CREATE TABLE context_items (
      id          INTEGER PRIMARY KEY,
      source      TEXT    NOT NULL,
      external_id TEXT,
      title       TEXT,
      url         TEXT,
      snippet     TEXT,
      occurred_at TEXT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      raw         TEXT,
      created_at  TEXT    NOT NULL,
      CHECK (source IN ('notion','calendar','manual'))
    );
    CREATE UNIQUE INDEX context_items_external ON context_items(source, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX context_items_project ON context_items(project_id);

    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `,
  },
  {
    id: 2,
    name: 'saved timers',
    up: `
    -- A pinned project+title pair you can start with one click. The frequent
    -- combos are derived from history instead; this table is only the ones
    -- you have chosen to keep at the top.
    CREATE TABLE saved_timers (
      id              INTEGER PRIMARY KEY,
      project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title           TEXT    NOT NULL,
      planned_minutes INTEGER,
      position        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX saved_timers_unique
      ON saved_timers(COALESCE(project_id, -1), title);
    `,
  },
  {
    id: 3,
    name: 'stopwatch mode',
    up: `
    -- No planned length means a stopwatch. That null is the whole signal: a
    -- separate mode column would be a second source of truth to keep in step.
    ALTER TABLE sessions ALTER COLUMN planned_minutes DROP NOT NULL;

    -- A guess to compare the actual against. Display only: nothing computes
    -- from it, so it can never move a score or a countdown.
    ALTER TABLE sessions ADD COLUMN estimated_minutes INTEGER
      CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 480);

    -- Everything pinned before this was a fixed-length block.
    ALTER TABLE saved_timers ADD COLUMN mode TEXT NOT NULL DEFAULT 'pomodoro'
      CHECK (mode IN ('pomodoro','stopwatch'));

    -- The saved-timer list looks up each pair's latest completed block. This
    -- makes that a seek rather than a rescan of the project's whole history.
    CREATE INDEX sessions_pair_recent ON sessions(project_id, title, started_at);
    `,
  },
  {
    id: 4,
    name: 'tasks',
    up: `
    -- A smaller unit of work than a project: one row of the weekly-priorities
    -- sheet this replaces. project_id is nullable because a "misc" task has no
    -- project, and SET NULL leaves a deleted project's tasks behind as misc
    -- ones instead of taking them with it.
    CREATE TABLE tasks (
      id                INTEGER PRIMARY KEY,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title             TEXT    NOT NULL,
      priority          TEXT    NOT NULL DEFAULT 'medium',
      status            TEXT    NOT NULL DEFAULT 'not_started',
      -- Total effort across however many blocks the task takes, not one block's
      -- guess. Display only: it is never a block's estimate or its countdown.
      estimated_minutes INTEGER,
      -- Plain YYYY-MM-DD days, like sessions.local_day: a target date is a
      -- calendar day and must not shift with the timezone or the clock.
      added_on          TEXT    NOT NULL,
      start_date        TEXT,
      target_date       TEXT,
      completed_on      TEXT,
      notes             TEXT,
      results           TEXT,
      position          INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      CHECK (priority IN ('high','medium','low')),
      CHECK (status IN ('not_started','in_progress','held_up','completed')),
      CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 6000)
    );
    CREATE INDEX tasks_project ON tasks(project_id);
    -- The list is cut by status (open or completed) and then ordered by position.
    CREATE INDEX tasks_status  ON tasks(status, position);

    -- A block can be the work on a task, so a task shows the time really logged
    -- against its estimate. Logged time is the record: deleting a task unlinks
    -- its blocks, it never deletes one or touches its minutes.
    ALTER TABLE sessions ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
    CREATE INDEX sessions_task ON sessions(task_id);
    `,
  },
  {
    id: 5,
    name: 'interruption reasons',
    up: `
    -- One row for each interruption logged from now on, so the count on a block can say
    -- what pulled you away. sessions.interruptions stays the number everything else reads
    -- (the score, the day's totals). Blocks logged before this have a count and no rows,
    -- and a NULL reason is an interruption logged with "No reason".
    CREATE TABLE interruptions (
      id         INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      at         TEXT    NOT NULL,
      reason     TEXT CHECK (reason IS NULL OR
                             reason IN ('chat','meeting','person','phone','email','other'))
    );
    CREATE INDEX interruptions_session ON interruptions(session_id);
    `,
  },
  {
    id: 6,
    name: 'task weeks',
    up: `
    -- The week a task sits in, kept apart from the day it was added: the sheet's "Week Of"
    -- and "Date Added" columns, which only agree until a task is carried into a later week.
    -- Always the Monday of that week, as a plain YYYY-MM-DD day.
    ALTER TABLE tasks ADD COLUMN week_of TEXT;

    -- Every task so far sat in the week it was added, so that is where it stays. Back six
    -- days and then forward to a Monday lands on the day itself for a Monday and on the
    -- Monday just gone for every other day, a Sunday included: the same rule as weekStart.
    UPDATE tasks SET week_of = date(added_on, '-6 days', 'weekday 1');

    -- A task's band is its week and its priority, ordered by position inside it.
    CREATE INDEX tasks_week ON tasks(week_of, priority, position);
    `,
  },
  {
    id: 7,
    name: 'wrap-ups',
    up: `
    -- What you write when you close out a day. The key is a plain YYYY-MM-DD focus day,
    -- like sessions.local_day, so it does not shift with the timezone. The note is the
    -- "tomorrow" line and wrapped_up_at is when "Done for the day" was pressed. Neither
    -- implies the other: a day can be wrapped up with no note, or carry a note and never
    -- be wrapped up, so each stays NULL until it is set.
    CREATE TABLE day_notes (
      day            TEXT PRIMARY KEY,
      note           TEXT,
      wrapped_up_at  TEXT,
      updated_at     TEXT NOT NULL
    );

    -- The same for a week, keyed by its Monday: weeks here are Monday-anchored, and a
    -- review is filed under the one day that names the week whichever day it is read from.
    CREATE TABLE week_reviews (
      week         TEXT PRIMARY KEY,
      note         TEXT,
      reviewed_at  TEXT,
      updated_at   TEXT NOT NULL
    );
    `,
  },
  {
    id: 8,
    name: 'prompts',
    up: `
    -- Time the desktop app saw you were away (locked, asleep or idle) while a block
    -- ran. It waits here as 'pending' until you keep it or drop it, and then never
    -- asks again. The interval is wall-clock and belongs to the block it was
    -- reported for, so it goes with the block when that is deleted.
    CREATE TABLE away_intervals (
      id          INTEGER PRIMARY KEY,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      started_at  TEXT    NOT NULL,
      ended_at    TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','kept','dropped')),
      created_at  TEXT    NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX away_session ON away_intervals(session_id);

    -- What has been done about a prompt that is worked out from other tables (a long
    -- block, a meeting): the key is the prompt's id, and a row is the reason it no
    -- longer shows. data holds whatever the prompt needs to remember, such as the
    -- block it paused for a meeting.
    CREATE TABLE prompt_state (
      key        TEXT PRIMARY KEY,
      status     TEXT NOT NULL CHECK (status IN ('done','dismissed')),
      data       TEXT,
      updated_at TEXT NOT NULL
    );
    `,
  },
];

export const DEFAULT_SETTINGS: Record<string, string> = {
  timezone: hostTimeZone(),
  focus_minutes: '45',
  short_break_minutes: '10',
  long_break_minutes: '25',
  blocks_before_long_break: '3',
  daily_target_minutes: '300',
  autostart_breaks: 'false',
  /** What a new block is when the caller does not say: 'stopwatch' or 'pomodoro'. */
  default_timer_mode: 'stopwatch',
  /**
   * The shortcut, in any app, that opens the quick-switch box. An Electron accelerator in
   * the spelling lib/accelerator.ts stores it in; '' turns it off.
   */
  quick_switch_hotkey: 'CommandOrControl+Shift+K',
  /** Day rolls over at this local hour, so a 1am block counts as the day before. */
  day_start_hour: '4',
  /** When the end-of-day wrap-up is due, as HH:MM on a 24-hour clock. '' means never. */
  wrapup_time: '17:30',
  /** Minutes locked, asleep or idle during a block before the desktop app reports it as away. 0 = off. */
  away_minutes: '10',
  /** A running block is asked about at this length, and again at each multiple of it. 0 = off. */
  long_block_minutes: '120',
  /** Offer to pause the block when a meeting starts, and to log the meeting when it ends. */
  meeting_prompts: 'true',
  /** ISO weekdays that are work days, 1 = Monday to 7 = Sunday, comma-separated. May be empty. */
  work_days: '1,2,3,4,5',
  work_start: '09:00',
  work_end: '18:00',
  /** Minutes of work hours with no block running before the desktop app nudges you to start one. 0 = off. */
  nudge_minutes: '15',
};

/**
 * Snapshot the database beside itself before a migration rewrites it. An
 * existing database holds history that cannot be regenerated, so it gets a
 * restore point; a fresh install (nothing applied yet) has nothing to lose.
 *
 * VACUUM INTO rather than copying the file: in WAL mode the main file alone is
 * not the database. If another connection holds a read open (a DB browser, a
 * second instance) the checkpoint cannot finish folding the WAL in, and a copy
 * taken then is torn: "database disk image is malformed". VACUUM INTO reads one
 * consistent snapshot and writes a single self-contained file whatever else is
 * connected. It refuses to run inside a transaction or over an existing file,
 * so it must stay ahead of the per-migration transactions and the name carries
 * the milliseconds. A failure throws: better to refuse to start than to
 * migrate with nothing to go back to.
 */
export function backupBeforeMigrating(
  conn: Database.Database,
  file: string,
  appliedCount: number,
  firstPendingId: number,
): string | null {
  if (appliedCount === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(
    path.dirname(file),
    `focusdesk.backup-before-${firstPendingId}-${stamp}.sqlite`,
  );
  conn.prepare('VACUUM INTO ?').run(backup);
  return backup;
}

/** Takes the connection and file as arguments so tests can migrate a scratch database. */
export function runMigrations(conn: Database.Database = db, file: string = dbPath()): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set<number>(
    conn
      .prepare('SELECT id FROM _migrations')
      .all()
      .map((r) => (r as { id: number }).id),
  );
  const mark = conn.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
  const pending = migrations.filter((m) => !applied.has(m.id));
  const [first] = pending;
  if (first) {
    const backup = backupBeforeMigrating(conn, file, applied.size, first.id);
    if (backup) console.log(`[db] backed up to ${backup} before migrating`);
  }
  for (const m of pending) {
    conn.transaction(() => {
      conn.exec(m.up);
      mark.run(m.id, m.name, new Date().toISOString());
    })();
    console.log(`[db] applied migration ${m.id}: ${m.name}`);
  }
}

function seedSettings(): void {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  })();
}

export function initDb(): void {
  runMigrations();
  seedSettings();
}
