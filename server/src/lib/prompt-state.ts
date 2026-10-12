import { db } from '../db.js';
import { nowIso } from './time.js';

export type PromptStatus = 'done' | 'dismissed';

export interface PromptState {
  status: PromptStatus;
  /** Whatever the prompt wrote down when it was handled; null if it wrote nothing. */
  data: Record<string, unknown> | null;
}

interface StateRow {
  key: string;
  status: PromptStatus;
  data: string | null;
}

function toState(row: StateRow): PromptState {
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = row.data == null ? null : JSON.parse(row.data);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // A row that cannot be read still says the prompt was handled; it only loses its note.
  }
  return { status: row.status, data };
}

/**
 * What has been done about a prompt, or null if nothing has. Only the prompts that are
 * worked out from other tables keep a row here: an away interval carries its own status.
 */
export function promptState(key: string): PromptState | null {
  const row = db.prepare('SELECT key, status, data FROM prompt_state WHERE key = ?').get(key) as
    | StateRow
    | undefined;
  return row ? toState(row) : null;
}

/**
 * What has been done about each of several prompts, read together: a list of prompts about
 * a few hundred meetings would otherwise ask once for every one. A key nothing has been done
 * about is not in the answer.
 */
export function promptStates(keys: string[]): Map<string, PromptState> {
  const found = new Map<string, PromptState>();
  // Few enough at a time to stay inside what one statement can be given.
  for (let at = 0; at < keys.length; at += 500) {
    const chunk = keys.slice(at, at + 500);
    const rows = db
      .prepare(
        `SELECT key, status, data FROM prompt_state WHERE key IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as StateRow[];
    for (const row of rows) found.set(row.key, toState(row));
  }
  return found;
}

/** What has been done about every prompt whose id starts with `prefix`, such as all of a block's. */
export function promptStatesWithPrefix(prefix: string): Map<string, PromptState> {
  // Everything from the prefix up to the last text that could follow it.
  const rows = db
    .prepare('SELECT key, status, data FROM prompt_state WHERE key >= ? AND key < ?')
    .all(prefix, `${prefix}\u{10FFFF}`) as StateRow[];
  return new Map(rows.map((row) => [row.key, toState(row)]));
}

/** Write down that a prompt was handled, with a note of anything it will need to remember. */
export function setPromptState(
  key: string,
  status: PromptStatus,
  data: Record<string, unknown> | null = null,
): void {
  db.prepare(
    `INSERT INTO prompt_state (key, status, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(key, status, data ? JSON.stringify(data) : null, nowIso());
}
