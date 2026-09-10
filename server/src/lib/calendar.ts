import ical from 'node-ical';
import { db } from '../db.js';
import { badRequest } from './http.js';
import { dayStartHour, getSetting, setSettings, tz } from './settings.js';
import { addDays, focusDay, nowIso } from './time.js';

/**
 * Calendar access by subscription URL rather than OAuth: both Google Calendar
 * ("Secret address in iCal format") and Outlook ("Publish a calendar") hand out
 * a private read-only ICS feed, which needs no cloud project and no consent
 * screen. The URL is a bearer secret, so it is stored locally and never
 * returned to the client in full.
 */
export interface CalendarSource {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
}

export interface RedactedSource {
  id: string;
  label: string;
  host: string;
  enabled: boolean;
}

const SETTING_KEY = 'calendar_sources';
const SYNC_WINDOW_BACK_DAYS = 21;
const SYNC_WINDOW_FORWARD_DAYS = 45;

export function readSources(): CalendarSource[] {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CalendarSource[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSources(sources: CalendarSource[]): void {
  setSettings({ [SETTING_KEY]: JSON.stringify(sources) });
}

export function redact(s: CalendarSource): RedactedSource {
  let host = 'unknown';
  try {
    host = new URL(s.url).host;
  } catch {
    /* keep placeholder */
  }
  return { id: s.id, label: s.label, host, enabled: s.enabled };
}

/** webcal:// is an ICS feed over https by another name. */
function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol === 'webcal:') url.protocol = 'https:';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Calendar URL must be an https, http or webcal address');
  }
  return url.toString();
}

export function addSource(label: string, url: string): RedactedSource {
  const source: CalendarSource = {
    id: `cal_${Date.now().toString(36)}`,
    label,
    url: normalizeUrl(url),
    enabled: true,
  };
  writeSources([...readSources(), source]);
  return redact(source);
}

export function updateSource(
  id: string,
  patch: { label?: string; url?: string; enabled?: boolean },
): RedactedSource {
  const sources = readSources();
  const target = sources.find((s) => s.id === id);
  if (!target) throw badRequest(`Unknown calendar source: ${id}`);
  if (patch.label !== undefined) target.label = patch.label;
  if (patch.url !== undefined) target.url = normalizeUrl(patch.url);
  if (patch.enabled !== undefined) target.enabled = patch.enabled;
  writeSources(sources);
  return redact(target);
}

export function removeSource(id: string): void {
  writeSources(readSources().filter((s) => s.id !== id));
  db.prepare('DELETE FROM calendar_events WHERE provider = ?').run(`ics:${id}`);
}

interface ParsedEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  attendees: string[];
}

function attendeeNames(event: ical.VEvent): string[] {
  const raw = (event as unknown as { attendee?: unknown }).attendee;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((a) => {
      if (typeof a === 'string') return a.replace(/^mailto:/i, '');
      const obj = a as { params?: { CN?: string }; val?: string };
      return obj.params?.CN ?? obj.val?.replace(/^mailto:/i, '') ?? '';
    })
    .filter(Boolean)
    .slice(0, 40);
}

/** Expand a feed into concrete event instances inside [from, to]. */
export function parseFeed(icsText: string, from: Date, to: Date): ParsedEvent[] {
  const parsed = ical.sync.parseICS(icsText);
  const out: ParsedEvent[] = [];

  for (const key of Object.keys(parsed)) {
    const entry = parsed[key];
    if (!entry || entry.type !== 'VEVENT') continue;
    const event = entry as ical.VEvent;
    if (!event.start) continue;

    const allDay = (event.datetype as string | undefined) === 'date';
    const durationMs = event.end
      ? Math.max(0, event.end.getTime() - event.start.getTime())
      : allDay
        ? 86_400_000
        : 30 * 60_000;
    const base = {
      uid: String(event.uid ?? key),
      title: String(event.summary ?? '(untitled)'),
      description: event.description ? String(event.description).slice(0, 4000) : null,
      location: event.location ? String(event.location).slice(0, 500) : null,
      allDay,
      attendees: attendeeNames(event),
    };

    if (event.rrule) {
      // Cancelled and moved instances of a recurring series.
      const exdates = new Set(
        Object.values((event.exdate ?? {}) as Record<string, Date>).map((d) => d.getTime()),
      );
      const overrides = (event.recurrences ?? {}) as Record<string, ical.VEvent>;
      for (const occurrence of event.rrule.between(from, to, true)) {
        if (exdates.has(occurrence.getTime())) continue;
        const overrideKey = occurrence.toISOString().slice(0, 10);
        const override = overrides[overrideKey];
        const start = override?.start ?? occurrence;
        const end = override?.end ?? new Date(start.getTime() + durationMs);
        out.push({
          ...base,
          title: override?.summary ? String(override.summary) : base.title,
          start,
          end,
        });
      }
      continue;
    }

    const end = event.end ?? new Date(event.start.getTime() + durationMs);
    if (end < from || event.start > to) continue;
    out.push({ ...base, start: event.start, end });
  }
  return out;
}

export interface SyncResult {
  sourceId: string;
  label: string;
  ok: boolean;
  events: number;
  error?: string;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/calendar, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`feed responded ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remember how meetings were categorised: once "Weekly RCM standup" has been
 * attributed to a project, later instances inherit that project on sync.
 */
function inheritedProjectId(title: string, uid: string): number | null {
  const row = db
    .prepare(
      `SELECT project_id FROM calendar_events
       WHERE project_id IS NOT NULL AND (title = ? OR id LIKE ?)
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(title, `%:${uid}:%`) as { project_id: number } | undefined;
  return row?.project_id ?? null;
}

export async function syncCalendars(): Promise<SyncResult[]> {
  const sources = readSources().filter((s) => s.enabled);
  const now = new Date();
  const from = new Date(now.getTime() - SYNC_WINDOW_BACK_DAYS * 86_400_000);
  const to = new Date(now.getTime() + SYNC_WINDOW_FORWARD_DAYS * 86_400_000);
  const zone = tz();
  const startHour = dayStartHour();
  const results: SyncResult[] = [];

  const upsert = db.prepare(
    `INSERT INTO calendar_events
       (id, provider, calendar_id, title, description, location, starts_at, ends_at,
        all_day, attendees, local_day, project_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, description = excluded.description,
       location = excluded.location, starts_at = excluded.starts_at,
       ends_at = excluded.ends_at, all_day = excluded.all_day,
       attendees = excluded.attendees, local_day = excluded.local_day,
       -- a hand-made attribution always wins over an inherited guess
       project_id = COALESCE(calendar_events.project_id, excluded.project_id),
       synced_at = excluded.synced_at`,
  );

  for (const source of sources) {
    const provider = `ics:${source.id}`;
    try {
      const events = parseFeed(await fetchText(source.url), from, to);
      const stamp = nowIso();
      db.transaction(() => {
        // Drop the old window first so deleted and moved meetings disappear.
        db.prepare(
          'DELETE FROM calendar_events WHERE provider = ? AND starts_at >= ? AND starts_at <= ?',
        ).run(provider, from.toISOString(), to.toISOString());
        for (const e of events) {
          const startIso = e.start.toISOString();
          upsert.run(
            `${provider}:${e.uid}:${startIso}`,
            provider,
            source.label,
            e.title,
            e.description,
            e.location,
            startIso,
            e.end.toISOString(),
            e.allDay ? 1 : 0,
            e.attendees.length ? JSON.stringify(e.attendees) : null,
            focusDay(startIso, zone, startHour),
            inheritedProjectId(e.title, e.uid),
            stamp,
          );
        }
      })();
      results.push({ sourceId: source.id, label: source.label, ok: true, events: events.length });
    } catch (err) {
      results.push({
        sourceId: source.id,
        label: source.label,
        ok: false,
        events: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  setSettings({ calendar_last_sync: nowIso() });
  return results;
}

export interface CalendarEventView {
  id: string;
  provider: string;
  calendarLabel: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendees: string[];
  day: string;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  loggedSeconds: number;
}

export function listEvents(from: string, to: string): CalendarEventView[] {
  const rows = db
    .prepare(
      `SELECT e.*, p.name AS project_name, p.color AS project_color,
              (SELECT COALESCE(SUM(active_seconds), 0) FROM sessions s
                WHERE s.calendar_event_id = e.id) AS logged_seconds
       FROM calendar_events e LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.local_day BETWEEN ? AND ?
       ORDER BY e.starts_at ASC`,
    )
    .all(from, to) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    calendarLabel: (r.calendar_id as string | null) ?? null,
    title: (r.title as string | null) ?? '(untitled)',
    description: (r.description as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    startsAt: String(r.starts_at),
    endsAt: String(r.ends_at),
    allDay: !!r.all_day,
    attendees: r.attendees ? (JSON.parse(String(r.attendees)) as string[]) : [],
    day: String(r.local_day),
    projectId: (r.project_id as number | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    projectColor: (r.project_color as string | null) ?? null,
    loggedSeconds: Number(r.logged_seconds ?? 0),
  }));
}

/** Attribute a meeting to a project; future instances inherit it on sync. */
export function assignEventProject(eventId: string, projectId: number | null): CalendarEventView {
  const info = db
    .prepare('UPDATE calendar_events SET project_id = ? WHERE id = ?')
    .run(projectId, eventId);
  if (!info.changes) throw badRequest(`Unknown calendar event: ${eventId}`);
  const row = db.prepare('SELECT local_day FROM calendar_events WHERE id = ?').get(eventId) as {
    local_day: string;
  };
  const found = listEvents(row.local_day, row.local_day).find((e) => e.id === eventId);
  if (!found) throw badRequest(`Unknown calendar event: ${eventId}`);
  return found;
}

export const defaultWindow = (day: string) => ({
  from: addDays(day, -SYNC_WINDOW_BACK_DAYS),
  to: addDays(day, SYNC_WINDOW_FORWARD_DAYS),
});
