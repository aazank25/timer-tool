import { db } from '../db.js';
import { nowIso } from './time.js';

export type PromptStatus = 'done' | 'dismissed';

export interface PromptState {
  status: PromptStatus;
  /** Whatever the prompt wrote down when it was handled; null if it wrote nothing. */
  data: Record<string, unknown> | null;
}

/**
 * What has been done about a prompt, or null if nothing has. Only the prompts that are
 * worked out from other tables keep a row here: an away interval carries its own status.
 */
export function promptState(key: string): PromptState | null {
  const row = db.prepare('SELECT status, data FROM prompt_state WHERE key = ?').get(key) as
    | { status: PromptStatus; data: string | null }
    | undefined;
  if (!row) return null;
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = row.data == null ? null : JSON.parse(row.data);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // A row that cannot be read still says the prompt was handled; it only loses its note.
  }
  return { status: row.status, data };
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
