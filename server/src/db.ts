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
  /** Day rolls over at this local hour, so a 1am block counts as the day before. */
  day_start_hour: '4',
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
