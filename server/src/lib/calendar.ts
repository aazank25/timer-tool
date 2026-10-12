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
/** A feed that has not answered by now is not going to. */
const FEED_TIMEOUT_MS = 20_000;

/**
 * The longest id a calendar event can have. A block logged on an event carries the id, and so
 * does every prompt about it, so the limits on what the routes take are this one, and the
 * limit on a prompt's id leaves room for what goes round the event's id in it.
 */
export const MAX_EVENT_ID_LENGTH = 2000;
export const MAX_PROMPT_ID_LENGTH = MAX_EVENT_ID_LENGTH + 100;

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
  let url: URL;
  try {
    // The scheme is swapped in the text: a URL cannot be moved from webcal: to https: once it is made.
    url = new URL(input.trim().replace(/^webcal:/i, 'https:'));
  } catch {
    throw badRequest('That is not a web address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Calendar URL must be an https, http or webcal address');
  }
  // What the feed is asked for is a secret, and a user name and password in it would be
  // quoted along with it by whatever goes wrong while it is read. The private addresses
  // Google and Outlook give out need neither.
  if (url.username || url.password) {
    throw badRequest(
      'Calendar URL cannot have a user name or password in it: use the private address your calendar gives you, which needs neither',
    );
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

/**
 * Expand a feed into concrete event instances inside [from, to]. A feed is a calendar from
 * BEGIN:VCALENDAR to END:VCALENDAR, and anything else is refused: an error page that came
 * back as a 200, an empty answer, or a download that stopped short is not a calendar with
 * nothing in it, and reading it as one would remove every meeting the feed had given.
 */
export function parseFeed(icsText: string, from: Date, to: Date): ParsedEvent[] {
  if (!/BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/i.test(icsText)) {
    throw new Error('The feed did not contain a complete calendar');
  }
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

/**
 * Read a feed. It is given up on after twenty seconds, or as soon as `signal` says the
 * server is closing, whichever comes first.
 */
async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FEED_TIMEOUT_MS)]),
    headers: { accept: 'text/calendar, text/plain, */*' },
  });
  if (!res.ok) throw new Error(`feed responded ${res.status} ${res.statusText}`);
  return await res.text();
}

/**
 * What went wrong, in words that are safe to show and to log. A feed's address is a secret,
 * and an error raised while reading it can quote it, so any address in the message is taken
 * out of it. The feed is named by its label wherever it is named.
 */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)\]}]/gi,
    'the feed address',
  );
}

/**
 * Remember how meetings were categorised: once one instance of "Team standup" has been
 * given a project, instances that turn up later take the same one. Only a new meeting takes
 * anything: one that is in the calendar already keeps what it has, whoever gave it that, and
 * that includes nothing, so a project taken off a meeting by hand stays off.
 *
 * The meeting's own series comes first (the same UID in the same feed), and failing that a
 * meeting of exactly the same title in the same feed. Never one from another calendar: a "1:1"
 * there is somebody else's. Where they differ, the latest one counts.
 */
function inheritedProjectId(provider: string, uid: string, title: string): number | null {
  // An instance's id is the feed, the UID and its start (24 characters), so the instances of one
  // series in one feed are the ids that begin with the first two and add nothing but the start.
  const series = `${provider}:${uid}:`;
  const own = db
    .prepare(
      `SELECT project_id FROM calendar_events
       WHERE project_id IS NOT NULL AND instr(id, ?) = 1 AND length(id) = length(?) + 24
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(series, series) as { project_id: number } | undefined;
  if (own) return own.project_id;
  const named = db
    .prepare(
      `SELECT project_id FROM calendar_events
       WHERE provider = ? AND project_id IS NOT NULL AND title = ?
       ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(provider, title) as { project_id: number } | undefined;
  return named?.project_id ?? null;
}

/**
 * Syncs run one at a time, whoever asks: the timer in the background, a click on Sync now,
 * or both at once. Two at a time would read the same feed twice and race to write the same
 * rows, so a sync that is asked for while another is running waits for it and then reads
 * the sources afresh, which is also what lets a feed that was added a moment ago be picked up.
 */
let lastSync: Promise<unknown> = Promise.resolve();
/** The syncs that are waiting their turn or running, so that closing the server can stop them. */
const unfinished = new Set<AbortController>();

export function syncCalendars(): Promise<SyncResult[]> {
  const controller = new AbortController();
  unfinished.add(controller);
  const run = lastSync
    .then(() => syncOnce(controller.signal))
    .finally(() => unfinished.delete(controller));
  // Whatever happens to this one, the next in line still runs.
  lastSync = run.catch(() => undefined);
  return run;
}

/**
 * Stop every sync that is waiting or running: the read of a feed is cut short, and nothing is
 * written for it. Resolves once they have all stopped, so that once it has, nothing more is
 * written. Syncs asked for afterwards run as usual.
 */
export function stopCalendarSyncs(): Promise<void> {
  for (const controller of unfinished) controller.abort();
  return lastSync.then(() => undefined);
}

async function syncOnce(signal: AbortSignal): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const sources = readSources().filter((s) => s.enabled);
  const now = new Date();
  const from = new Date(now.getTime() - SYNC_WINDOW_BACK_DAYS * 86_400_000);
  const to = new Date(now.getTime() + SYNC_WINDOW_FORWARD_DAYS * 86_400_000);
  const zone = tz();
  const startHour = dayStartHour();

  // A row that is there already keeps its project, whatever it is: the update leaves it alone.
  // The project on the insert is for a new row, and only a new row is worked out one.
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
       synced_at = excluded.synced_at`,
  );
  const known = db.prepare('SELECT 1 FROM calendar_events WHERE id = ?');

  /**
   * Whether the source is still one to sync as it was when it was read: not removed, not
   * switched off, and not given another address. Looked at again after the read, because a
   * read can take twenty seconds and the person can do any of those meanwhile.
   */
  const stillSyncs = (source: CalendarSource) => {
    const latest = readSources().find((s) => s.id === source.id);
    return !!latest && latest.enabled && latest.url === source.url;
  };

  for (const source of sources) {
    // Stopped, whether while it waited its turn or between two feeds.
    if (signal.aborted) break;
    if (!stillSyncs(source)) continue;
    const provider = `ics:${source.id}`;
    try {
      const events = parseFeed(await fetchText(source.url, signal), from, to);
      const wrote = db.transaction((): boolean => {
        // Nothing is written for a feed that was removed while it was being read: its
        // events would be back with nothing to own them. This is the last look before the
        // writes, in the same transaction, so nothing can change between the two.
        if (signal.aborted || !stillSyncs(source)) return false;
        const stamp = nowIso();
        const current = new Set<string>();
        for (const e of events) {
          const startIso = e.start.toISOString();
          const id = `${provider}:${e.uid}:${startIso}`;
          current.add(id);
          upsert.run(
            id,
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
            known.get(id) ? null : inheritedProjectId(provider, e.uid, e.title),
            stamp,
          );
        }
        // Only now remove what the feed no longer has, so a meeting that was cancelled or
        // moved disappears while one that is still there keeps the project it was given by
        // hand. Clearing the whole window first used to wipe that on every sync. It comes
        // after the writes above so that a moved instance can still inherit its project
        // from the row it replaces.
        const stale = db
          .prepare(
            'SELECT id FROM calendar_events WHERE provider = ? AND starts_at >= ? AND starts_at <= ?',
          )
          .all(provider, from.toISOString(), to.toISOString()) as { id: string }[];
        if (!events.length && stale.length) {
          // A feed that is a calendar but has nothing in the window, where it had meetings
          // a moment ago, is more likely something wrong at the other end than every one of
          // them cancelled, so what it had is kept.
          console.warn(
            `[calendar] "${source.label}" came back with no meetings in the window, so the ${stale.length} it had are kept`,
          );
          return true;
        }
        const remove = db.prepare('DELETE FROM calendar_events WHERE id = ?');
        for (const { id } of stale) if (!current.has(id)) remove.run(id);
        return true;
      })();
      if (wrote) {
        results.push({ sourceId: source.id, label: source.label, ok: true, events: events.length });
      }
    } catch (err) {
      // Stopped while it was reading: the server is closing, and it is not the feed's doing.
      if (signal.aborted) break;
      results.push({
        sourceId: source.id,
        label: source.label,
        ok: false,
        events: 0,
        error: describeFailure(err),
      });
    }
  }
  if (!signal.aborted) setSettings({ calendar_last_sync: nowIso() });
  return results;
}

/**
 * Keep the calendar fresh in the background. A meeting prompt is only as good as the events
 * it reads, and the feed used to be read only when you pressed Sync now. The first look is
 * soon after start-up and then every `everyMs`; nothing is fetched while no feed is switched
 * on. The next look is only set once the last one has finished, so a slow feed can never
 * have two running, and a failure is logged and waited out rather than allowed to stop it.
 * `everyMs` of 0 switches it off. Returns a function that stops it: the wait is cancelled, any
 * read of a feed that is under way (this one's, or a Sync now) is cut short, and the promise
 * it returns settles once that is done, after which nothing more is written.
 */
export function startCalendarSync(opts: {
  everyMs: number;
  /** How long to wait before the first look. Defaults to 30 seconds, or `everyMs` if that is less. */
  firstRunMs?: number;
  /** What to run each time. Left out, it is the real sync; tests pass their own, so none touches the network. */
  sync?: () => Promise<SyncResult[]>;
  /**
   * The clock the waiting is done with. Left out, it is the real one; tests pass one they wind
   * by hand. Faking the global setTimeout instead would reach the sockets of every fetch that
   * is still closing, and they clear timers too.
   */
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}): () => Promise<void> {
  // Nothing is scheduled, but a Sync now that is under way is still the server's to stop.
  if (!(opts.everyMs > 0)) return stopCalendarSyncs;
  const sync = opts.sync ?? syncCalendars;
  const clock = opts.timers ?? {
    setTimeout: (callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      // A sync is never a reason to keep the process alive.
      handle.unref();
      return handle;
    },
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown;
  let stopped = false;
  /** The look that is under way, or the last one, so that stopping can wait for it. */
  let current: Promise<void> = Promise.resolve();

  const schedule = (ms: number) => {
    timer = clock.setTimeout(() => {
      current = look();
    }, ms);
  };

  async function look() {
    try {
      if (readSources().some((s) => s.enabled)) {
        const results = await sync();
        // Stopped meanwhile: what it was cut short of is not the feeds' doing, so it is not reported.
        if (stopped) return;
        for (const r of results) {
          if (!r.ok) console.warn(`[calendar] could not sync "${r.label}": ${r.error}`);
        }
      }
    } catch (err) {
      if (!stopped) console.error('[calendar] background sync failed:', describeFailure(err));
    } finally {
      if (!stopped) schedule(opts.everyMs);
    }
  }

  schedule(opts.firstRunMs ?? Math.min(30_000, opts.everyMs));
  return () => {
    stopped = true;
    clock.clearTimeout(timer);
    return Promise.all([current, stopCalendarSyncs()]).then(() => undefined);
  };
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
