import { randomUUID } from 'node:crypto';
import ical, { type CalendarResponse, type VEvent } from 'node-ical';
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
 * The most of a feed that is read: years of a busy calendar come to a few megabytes. It is
 * counted as the answer arrives, once it is unpacked, so that an answer that is small on the
 * wire and unpacks to gigabytes is stopped at the same point as a large plain one.
 */
const MAX_FEED_BYTES = 10 * 1024 * 1024;
/** Redirects followed in one read of a feed: a calendar that has moved is one or two away. */
const MAX_REDIRECTS = 5;

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

/**
 * The hosts a feed is read from over plain http as well as https: this machine, where neither
 * the address nor the calendar crosses a network on the way.
 */
const THIS_MACHINE = new Set(['127.0.0.1', 'localhost', '[::1]']);

const onThisMachine = (url: URL) => THIS_MACHINE.has(url.hostname);

/**
 * A feed's address is a secret, and over plain http it crosses the network for anyone on the
 * way to read, along with the whole calendar it answers with. So http is read as https, as
 * webcal is, everywhere but on this machine. Other machines on the network are not told apart
 * from the internet: a calendar the owner serves at home is as much theirs to read as one
 * elsewhere, and it is read over https all the same.
 */
function overHttps(url: URL): URL {
  if (url.protocol === 'http:' && !onThisMachine(url)) url.protocol = 'https:';
  return url;
}

/** webcal:// is an ICS feed over https by another name, and so, mostly, is http://. */
function normalizeUrl(input: string): string {
  let url: URL;
  try {
    // The scheme is swapped in the text: a URL cannot be moved from webcal: to https: once it is made.
    url = new URL(input.trim().replace(/^webcal:/i, 'https:'));
  } catch {
    throw badRequest('That is not a web address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('Calendar URL must be an https or webcal address');
  }
  // What the feed is asked for is a secret, and a user name and password in it would be
  // quoted along with it by whatever goes wrong while it is read. The private addresses
  // Google and Outlook give out need neither.
  if (url.username || url.password) {
    throw badRequest(
      'Calendar URL cannot have a user name or password in it: use the private address your calendar gives you, which needs neither',
    );
  }
  return overHttps(url).toString();
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

/*
 * Reading a feed. Its host is someone else's machine, and what it sends is read on the server's
 * one thread, which in the desktop app is the window's as well. So a feed that is broken, or
 * written to do harm, must cost a bounded amount however it is written, and must never reach
 * past the meetings it holds. It is not handed to node-ical whole: it is cut into its meetings
 * first, and they are handed over a few dozen at a time, each with only the lines the app reads
 * of it, and under a name made up here. node-ical keeps the meetings of a calendar in an object,
 * by UID, and a UID such as __proto__ or prodid is a key of that object that is not a meeting's.
 * A meeting that cannot be read, or that goes past a limit, is set aside, and the rest are read
 * as usual.
 */

const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_LOCATION_LENGTH = 500;
const MAX_ATTENDEES = 40;
const MAX_ATTENDEE_NAME_LENGTH = 200;

/*
 * The limits on what one feed can make a sync do. None of them is near what a real calendar
 * holds in the weeks a sync reads. A meeting past one is set aside: it is counted in the sync's
 * result, and what the calendar already has of it is kept as it is.
 */
/** Entries (VEVENTs) read of one feed, once those far outside the window are passed over. */
const MAX_ENTRIES = 5000;
/** Entries of one meeting: a series, and the instances of it that were moved or changed. */
const MAX_ENTRIES_PER_MEETING = 500;
/** Entries parsed together, few enough that a piece is quick to parse and a bad one costs little. */
const ENTRIES_PER_PIECE = 50;
/** Lines of one entry that are read: a real one has a few dozen. */
const MAX_LINES_PER_ENTRY = 1000;
/** Attendees of one entry that are read: more than are kept, to find the ones with a name. */
const MAX_ATTENDEE_LINES = 100;
/** The longest recurrence rule that is read: a real one is a line or two. */
const MAX_RULE_LENGTH = 1000;
/** Meetings one series can put in the window, where a daily one puts 66. */
const MAX_INSTANCES_PER_SERIES = 500;
/** Meetings one feed can put in the window. */
const MAX_MEETINGS_PER_FEED = 5000;
/** Cancelled instances (EXDATE) in the window, over all of a feed's series. */
const MAX_CANCELLATIONS = 5000;
/** Time zone definitions (VTIMEZONE) read of one feed, and the most text they can take. */
const MAX_ZONES = 20;
const MAX_ZONE_TEXT = 64 * 1024;
/**
 * Different time zone names the dates of one feed can give, and how long a name can be.
 * node-ical keeps every name it is given for as long as the server runs.
 */
const MAX_ZONE_NAMES = 64;
const MAX_ZONE_NAME_LENGTH = 100;
/**
 * Different years in which a date has to be placed by one of the feed's own time zone
 * definitions rather than by a zone's name. node-ical works out which zone such a definition
 * is by trying every zone the machine knows, once for each year it is asked about.
 */
const MAX_ZONE_SEARCHES = 48;
/** How long reading one feed can take: what is left of it after that is set aside. */
const READ_BUDGET_MS = 2_000;
/**
 * How far outside the window a date can be written and still be read. A date is written in
 * the meeting's own zone, which puts it within a day of the instant it stands for.
 */
const MARGIN_DAYS = 2;
/** The properties of an entry the app reads, or that node-ical needs to read them. */
const WANTED = new Set([
  'SUMMARY',
  'DESCRIPTION',
  'LOCATION',
  'DTSTART',
  'DTEND',
  'DURATION',
  'RRULE',
  'EXDATE',
  'RECURRENCE-ID',
  'SEQUENCE',
  'ATTENDEE',
]);
/** The first letters of those, and of BEGIN and END: a line starting otherwise is not looked at. */
const WANTED_FIRST = 'SDLREABsdlreab';
/** The parts of a time zone definition node-ical reads. */
const OBSERVANCES = new Set(['STANDARD', 'DAYLIGHT']);
const OBSERVANCE_LINES = new Set(['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'TZNAME', 'RRULE', 'RDATE']);

/** A line of a feed as node-ical reads it: its name, its parameters as written, and its value. */
interface Property {
  name: string;
  params: string;
  value: string;
}

/** node-ical's own pattern for a line, so that what is decided of a line here is what node-ical makes of it. */
const PROPERTY = /^((?:\w|-)+)((?:;(?:\w|-)+=(?:"[^"]*"|[^":;]+))*):(.*)$/u;

function property(line: string): Property | null {
  // As node-ical does, quotes are taken out of a line that names a time zone, unless they hold
  // one of Outlook's zone labels, which have colons in them.
  const plain = line.includes('TZID=') && !line.includes('"(') ? line.replaceAll('"', '') : line;
  const m = PROPERTY.exec(plain);
  return m ? { name: m[1]!, params: m[2] ?? '', value: m[3]! } : null;
}

/**
 * The lines of `text` from `from` to `to`, unfolded as node-ical unfolds them: a line that
 * starts with a space or a tab goes on the end of the one before, less that first character.
 */
class Lines {
  line = '';
  /** Where the line starts in the text, and where the one after it starts. */
  start = 0;
  end: number;

  constructor(
    private readonly text: string,
    from: number,
    private readonly to: number,
  ) {
    this.end = from;
  }

  next(): boolean {
    if (this.end >= this.to) return false;
    this.start = this.end;
    let line = this.physical();
    while (this.end < this.to) {
      const c = this.text.charCodeAt(this.end);
      if (c !== 32 && c !== 9) break;
      line += this.physical().slice(1);
    }
    this.line = line;
    return true;
  }

  /** The line of the text that starts at `end`, without its line break, moving `end` past it. */
  private physical(): string {
    const { text, to } = this;
    const from = this.end;
    const nl = text.indexOf('\n', from);
    if (nl === -1 || nl >= to) {
      this.end = to;
      return text.slice(from, to);
    }
    this.end = nl + 1;
    return text.slice(from, nl > from && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl);
  }
}

/**
 * The components open at a line of a feed, outermost first, and how many of each are open, so
 * that an END for one that is not open is passed over at once rather than searched for.
 */
class Nesting {
  readonly open: string[] = [];
  private readonly counts = new Map<string, number>();

  begin(name: string): void {
    this.open.push(name);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * Close `name`, and whatever was opened inside it and never closed, telling `closed` of each,
   * innermost first, with how many are open once it is. Nothing is closed when it is not open.
   */
  end(name: string, closed: (name: string, depth: number) => void = () => {}): void {
    if (!this.counts.get(name)) return;
    for (;;) {
      const last = this.open.pop()!;
      this.counts.set(last, this.counts.get(last)! - 1);
      closed(last, this.open.length);
      if (last === name) return;
    }
  }
}

/** The day a date is written on, in days since 1970, or null when it does not start as a date. */
function dayOf(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000) : null;
}

/** A text value with its escapes undone, as node-ical undoes them. */
function unescaped(value: string): string {
  return value
    .replaceAll('\\,', ',')
    .replaceAll('\\;', ';')
    .replace(/\\n/gi, '\n')
    .replaceAll('\\\\', '\\')
    .replace(/^"(.*)"$/u, '$1');
}

/** The zone a date line names, if any, what kind of value it says it has, and its value, as node-ical reads them. */
function dated(p: Property): { zone: string | null; kind: string | null; value: string } {
  let zone: string | null = null;
  let kind: string | null = null;
  for (const param of p.params.split(';')) {
    const eq = param.indexOf('=');
    if (eq < 1) continue;
    const name = param.slice(0, eq).toUpperCase();
    const value = param.slice(eq + 1).replace(/^"(.*)"$/u, '$1');
    if (name === 'TZID') zone = value;
    else if (name === 'VALUE') kind = value.toUpperCase();
  }
  let value = p.value;
  // A zone written as a web address, tzone://Microsoft/Utc, is cut at its colon by node-ical's
  // pattern for a line, and put back together when the date is read.
  if (zone !== null && zone.toLowerCase() === 'tzone') {
    const colon = value.indexOf(':');
    if (colon >= 0) {
      zone = `${zone}:${value.slice(0, colon)}`;
      value = value.slice(colon + 1);
    }
  }
  return { zone, kind, value };
}

/**
 * Zone names node-ical places a date by through the feed's own definition of the zone rather
 * than by the name: the ones Outlook gives a zone it made up.
 */
const borrowsDefinition = (zone: string) =>
  zone === '(no TZ description)' ||
  zone.startsWith('Customized Time Zone') ||
  zone.startsWith('tzone://Microsoft/');

/** An entry (VEVENT) of a feed: where it is in the text, and what its text says of when it is. */
interface Entry {
  /** Where its BEGIN:VEVENT line starts in the text, and where the line after its END starts. */
  from: number;
  to: number;
  uid: string | null;
  /** Its recurrence rule: the last, which is the one node-ical reads. */
  rule: Rule | null;
  /** It changes one instance of a series (RECURRENCE-ID), and the day of that instance. */
  instanceOf: boolean;
  instance: number | null;
  /** The days its start and end are written on. */
  start: number | null;
  end: number | null;
  /** Its text does not say when it ends: it has a DURATION, or a date that is not one. */
  open: boolean;
}

/** What a recurrence rule says of how often, and for how long, a series goes on. */
interface Rule {
  /** The length of one period of it in days, or null for a frequency there is no such thing as. */
  periodDays: number | null;
  interval: number;
  count: number | null;
  /** The day of its UNTIL. */
  until: number | null;
  /** How many dates a period has to be looked at for: its BY lists multiplied out. */
  candidates: number;
  /**
   * It is of the kind calendars make: daily, weekly, monthly or yearly, on a handful of days,
   * and not at set hours, minutes or seconds.
   */
  plain: boolean;
}

const PERIOD_DAYS: Record<string, number> = {
  SECONDLY: 1 / 86_400,
  MINUTELY: 1 / 1_440,
  HOURLY: 1 / 24,
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 30,
  YEARLY: 365,
};
const BY_LISTS = ['BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYMONTHDAY', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'];

function ruleOf(text: string): Rule {
  const parts = new Map<string, string>();
  for (const part of text.toUpperCase().split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const freq = parts.get('FREQ') ?? '';
  const until = parts.get('UNTIL');
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  let candidates = 1;
  let plain = freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY';
  for (const by of BY_LISTS) {
    const list = parts.get(by);
    if (list === undefined) continue;
    const length = list.split(',').length;
    candidates *= length;
    if (by === 'BYHOUR' || by === 'BYMINUTE' || by === 'BYSECOND' || length > 12) plain = false;
  }
  return {
    periodDays: PERIOD_DAYS[freq] ?? null,
    interval: Math.max(1, Math.floor(Number(parts.get('INTERVAL'))) || 1),
    count: count !== null && Number.isFinite(count) ? count : null,
    until: until ? dayOf(until) : null,
    candidates,
    plain,
  };
}

/**
 * The day a series ends by, where its rule says: its UNTIL, or, for one that counts its dates
 * and has a single date in each period, the day its last is due at the latest. A monthly one
 * on the 31st passes over the months that have no 31st, and a yearly one on 29 February over
 * all but the leap years, so for those the periods are counted over again.
 */
function endOf(rule: Rule, start: number | null): number | null {
  if (rule.until !== null) return rule.until;
  if (rule.count === null || rule.candidates !== 1 || rule.periodDays === null || start === null) return null;
  const stretch = rule.periodDays === 30 ? 2 : rule.periodDays === 365 ? 8 : 1;
  return start + Math.max(0, rule.count - 1) * rule.interval * rule.periodDays * stretch;
}

/**
 * Most periods a rule is worked out over, and how many dates it can be made to look at, before
 * a meeting with it is set aside rather than worked out. node-ical's rule engine skips ahead
 * to the window for a rule that does not count its dates, but one with a COUNT has to be
 * counted from its first period, and every period costs as many dates as its BY lists multiply
 * out to: a few such rules, written to, would hold the server's thread for many seconds, and
 * one call to the engine cannot be stopped part way through.
 */
const MAX_PERIODS = 10_000;
const MAX_RULE_WORK = 50_000;
const MAX_COUNTED_RULE_WORK = 6_000;
/**
 * A series that counts its dates from before 1970 is set aside: dates that early are many
 * times slower to work out, and no meeting goes back that far.
 */
const EARLIEST_COUNTED_START = 0;

/** Whether working a rule out for the window, from first to last, is more than a sync can do. */
function tooCostly(rule: Rule, start: number | null, first: number, last: number): boolean {
  if (rule.periodDays === null) return false;
  const length = rule.periodDays * rule.interval;
  if (rule.count === null) {
    // Skipped ahead to the window, it has the window's periods to work out, and past
    // MAX_PERIODS of them the engine gives up in any case.
    const periods = Math.max(0, (last - Math.max(first, start ?? first)) / length);
    return periods > MAX_PERIODS || periods * rule.candidates > MAX_RULE_WORK;
  }
  if (start === null || start < EARLIEST_COUNTED_START) return true;
  const periods = Math.min(Math.max(0, (last - start) / length), MAX_PERIODS);
  return periods * rule.candidates > MAX_COUNTED_RULE_WORK;
}

/** Take what a line of an entry's own says of when the entry is. */
function note(entry: Entry, line: string): void {
  // Only these lines say anything of it, and the rest are passed over unread.
  const lead = line.charAt(0);
  if (!lead || !'UuRrDd'.includes(lead)) return;
  const p = property(line);
  if (!p) return;
  const upper = p.name.toUpperCase();
  if (upper === 'UID') {
    if (entry.uid === null && p.value) entry.uid = unescaped(p.value);
  } else if (upper === 'RRULE') {
    // node-ical reads the rule from the text after its last FREQ=.
    const at = p.value.lastIndexOf('FREQ=');
    entry.rule = ruleOf(at > 0 ? p.value.slice(at) : p.value);
  } else if (upper === 'DURATION') {
    entry.open = true;
  } else if (p.name === 'DTSTART' || p.name === 'DTEND' || p.name === 'RECURRENCE-ID') {
    // In node-ical's way, only these exact names are dates: dtstart in small letters is text.
    const day = dayOf(dated(p).value);
    if (p.name === 'RECURRENCE-ID') {
      entry.instanceOf = true;
      entry.instance ??= day;
    } else if (day === null) {
      entry.open = true;
    } else if (p.name === 'DTSTART') {
      entry.start ??= day;
    } else {
      entry.end ??= day;
    }
  }
}

/**
 * Find the entries and the time zone definitions of a feed: the VEVENTs and VTIMEZONEs directly
 * inside a VCALENDAR, each as the stretch of text it takes. Whatever else the feed has, to-dos,
 * journals or components of its own invention, is passed over.
 */
function scan(text: string): { entries: Entry[]; zones: [number, number][] } {
  const entries: Entry[] = [];
  const zones: [number, number][] = [];
  const nesting = new Nesting();
  let entry: Entry | null = null;
  let zone = -1;
  const lines = new Lines(text, 0, text.length);
  while (lines.next()) {
    const line = lines.line;
    const begins = line.startsWith('BEGIN');
    if (begins || line.startsWith('END')) {
      const p = property(line);
      if (p && p.name === (begins ? 'BEGIN' : 'END')) {
        if (!begins) {
          nesting.end(p.value, (_closed, depth) => {
            if (depth !== 1 || nesting.open[0] !== 'VCALENDAR') return;
            if (entry) {
              entry.to = lines.end;
              entries.push(entry);
              entry = null;
            } else if (zone >= 0) {
              zones.push([zone, lines.end]);
              zone = -1;
            }
          });
        } else {
          if (nesting.open.length === 1 && nesting.open[0] === 'VCALENDAR') {
            if (p.value === 'VEVENT') {
              entry = {
                from: lines.start,
                to: lines.start,
                uid: null,
                rule: null,
                instanceOf: false,
                instance: null,
                start: null,
                end: null,
                open: false,
              };
            } else if (p.value === 'VTIMEZONE') {
              zone = lines.start;
            }
          }
          nesting.begin(p.value);
        }
        continue;
      }
    }
    if (entry && nesting.open.length === 2) note(entry, line);
  }
  return { entries, zones };
}

/**
 * The text of a time zone definition with only what node-ical reads of one: its name, and its
 * standard and daylight parts. Null for one whose name is longer than a zone's name can be.
 */
function cleanZone(text: string, from: number, to: number): string[] | null {
  const out = ['BEGIN:VTIMEZONE'];
  const lines = new Lines(text, from, to);
  lines.next();
  const nesting = new Nesting();
  nesting.begin('VTIMEZONE');
  const closed = (name: string, depth: number) => {
    if (depth === 1 && OBSERVANCES.has(name)) out.push(`END:${name}`);
  };
  while (lines.next()) {
    const p = property(lines.line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      nesting.begin(p.value);
      if (nesting.open.length === 2 && OBSERVANCES.has(p.value)) out.push(`BEGIN:${p.value}`);
      continue;
    }
    if (p.name === 'END') {
      nesting.end(p.value, closed);
      if (!nesting.open.length) break;
      continue;
    }
    const name = p.name.toUpperCase();
    if (nesting.open.length === 1 && name === 'TZID') {
      if (p.value.length > MAX_ZONE_NAME_LENGTH) return null;
      out.push(lines.line);
    } else if (
      nesting.open.length === 2 &&
      OBSERVANCES.has(nesting.open[1]!) &&
      OBSERVANCE_LINES.has(name)
    ) {
      out.push(lines.line);
    }
  }
  // A part the feed left open is closed here.
  while (nesting.open.length > 1) nesting.end(nesting.open[nesting.open.length - 1]!, closed);
  out.push('END:VTIMEZONE');
  return out;
}

/**
 * The feed's own time zone definitions, as many as MAX_ZONES and MAX_ZONE_TEXT allow, and only
 * those node-ical reads on their own: one it fails on would fail every piece it was put in.
 */
function zoneDefinitions(text: string, ranges: [number, number][]): string[] {
  const lines: string[] = [];
  let taken = 0;
  let size = 0;
  for (const [from, to] of ranges) {
    if (taken === MAX_ZONES) break;
    if (size + (to - from) > MAX_ZONE_TEXT) continue;
    const zone = cleanZone(text, from, to);
    if (!zone) continue;
    try {
      quietly(() => ical.sync.parseICS(['BEGIN:VCALENDAR', ...zone, 'END:VCALENDAR'].join('\r\n')));
    } catch {
      continue;
    }
    for (const line of zone) lines.push(line);
    taken++;
    size += to - from;
  }
  return lines;
}

/** A meeting of a feed: the entries that share a UID, and what node-ical is handed for it. */
interface Meeting {
  uid: string | null;
  entries: Entry[];
  /** The name node-ical knows it by, and the text it is handed for it. */
  key: string;
  lines: string[];
  /** Some date of it is placed by one of the feed's own time zone definitions. */
  borrows: boolean;
}

/**
 * The entries of a meeting that can say anything of the window, which may be none. Dates are
 * judged as they are written, which is within a day of the instants they stand for, so an
 * entry whose dates are all more than MARGIN_DAYS outside the window is passed over without
 * being parsed. In a feed that holds years of meetings, that is most of it.
 */
function forWindow(entries: Entry[], first: number, last: number): Entry[] {
  const outside = (e: Entry) => {
    if (e.open || e.start === null || (e.instanceOf && e.instance === null)) return false;
    const days = [e.start, e.end ?? e.start, e.instance ?? e.start];
    // An all-day meeting with no end runs to the day after its start.
    return Math.max(...days) + 1 < first || Math.min(...days) > last;
  };
  const series = entries.filter((e) => e.rule);
  if (!series.length) return entries.every(outside) ? [] : entries;
  // A series that ended before the window, or that starts after it, puts nothing in it.
  const over = (e: Entry) => {
    const end = endOf(e.rule!, e.start);
    return (end !== null && end + 1 < first) || (e.start !== null && e.start > last);
  };
  if (series.every(over) && entries.every((e) => e.rule || e.instanceOf || outside(e))) return [];
  // An instance that was moved or changed matters only when the instance it changes is in the window.
  return entries.filter(
    (e) => e.rule || !e.instanceOf || e.instance === null || (e.instance >= first && e.instance <= last),
  );
}

/** What handing a meeting to node-ical takes of a feed's limits, and the text it is handed. */
interface Cleaned {
  lines: string[];
  cancellations: number;
  zones: Set<string>;
  searches: Set<string>;
  borrows: boolean;
  /** It has something no real calendar has, such as a rule or a zone name far too long. */
  unreadable: boolean;
}

/**
 * The text node-ical is handed for a meeting: each of its entries under the meeting's key, with
 * only the lines the app reads (no alarms, nothing of the feed's own invention), and with only
 * the cancelled instances that fall in the window. And what that takes of the feed's limits.
 */
function cleaned(text: string, m: Meeting, first: number, last: number): Cleaned {
  const out: Cleaned = {
    lines: [],
    cancellations: 0,
    zones: new Set(),
    searches: new Set(),
    borrows: false,
    unreadable: false,
  };
  const placed = (zone: string | null, value: string, kind: string | null) => {
    if (zone !== null) {
      if (zone.length > MAX_ZONE_NAME_LENGTH) out.unreadable = true;
      out.zones.add(zone);
    }
    // A date and time with no Z is placed in a zone: the one it names, or, where it names none or
    // one Outlook made up, the feed's own definition of one.
    const m = /^(\d{4})\d{4}T\d{6}$/.exec(value);
    if (m && kind !== 'DATE' && (zone === null || borrowsDefinition(zone))) {
      out.borrows = true;
      out.searches.add(`${zone ?? ''}|${m[1]}`);
    }
  };
  for (const entry of m.entries) {
    const lines = new Lines(text, entry.from, entry.to);
    lines.next();
    out.lines.push('BEGIN:VEVENT', `UID:${m.key}`);
    const nesting = new Nesting();
    nesting.begin('VEVENT');
    let kept = 0;
    let attendees = 0;
    while (lines.next()) {
      const line = lines.line;
      const lead = line.charAt(0);
      if (!lead || !WANTED_FIRST.includes(lead)) continue;
      const p = property(line);
      if (!p) continue;
      if (p.name === 'BEGIN') {
        nesting.begin(p.value);
        continue;
      }
      if (p.name === 'END') {
        nesting.end(p.value);
        if (!nesting.open.length) break;
        continue;
      }
      // Inside an alarm, or another component of the entry's: none of it is read.
      if (nesting.open.length > 1) continue;
      const name = p.name.toUpperCase();
      if (!WANTED.has(name)) continue;
      let keep = line;
      if (name === 'ATTENDEE') {
        if (++attendees > MAX_ATTENDEE_LINES) continue;
      } else if (name === 'RRULE') {
        if (p.value.length > MAX_RULE_LENGTH) out.unreadable = true;
      } else if (p.name === 'EXDATE') {
        const d = dated(p);
        const values = d.value.split(',');
        const inWindow = values.filter((v) => {
          const day = dayOf(v.trim());
          return day === null || (day >= first && day <= last);
        });
        for (const v of inWindow) placed(d.zone, v.trim(), d.kind);
        out.cancellations += inWindow.length;
        if (!inWindow.length) continue;
        if (inWindow.length < values.length) {
          const before = p.value.slice(0, p.value.length - d.value.length);
          keep = `${p.name}${p.params}:${before}${inWindow.join(',')}`;
        }
      } else if (p.name === 'DTSTART' || p.name === 'DTEND' || p.name === 'RECURRENCE-ID') {
        const d = dated(p);
        placed(d.zone, d.value, d.kind);
      }
      if (++kept > MAX_LINES_PER_ENTRY) {
        out.unreadable = true;
        break;
      }
      out.lines.push(keep);
    }
    out.lines.push('END:VEVENT');
  }
  return out;
}

/**
 * Run node-ical with its warnings held back. It warns of what it could not make sense of by
 * quoting it, and what it quotes is the feed's own text, which has no place in the log.
 */
function quietly<T>(read: () => T): T {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return read();
  } finally {
    console.warn = warn;
  }
}

/**
 * Hand meetings to node-ical as a calendar of their own, with the feed's time zone definitions
 * when a date of theirs is placed by one. Throws when node-ical cannot read it.
 */
function parse(meetings: Meeting[], zones: string[]): CalendarResponse {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  if (meetings.some((m) => m.borrows)) for (const line of zones) lines.push(line);
  for (const m of meetings) for (const line of m.lines) lines.push(line);
  lines.push('END:VCALENDAR');
  return quietly(() => ical.sync.parseICS(lines.join('\r\n')));
}

/**
 * The text of a property. node-ical gives one with parameters, as Outlook writes
 * SUMMARY;LANGUAGE=en-US:Standup, as an object with the text in `val`, and one that is there
 * more than once as a list, of which the first text is the one meant.
 */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item);
      if (text) return text;
    }
    return null;
  }
  if (value && typeof value === 'object' && 'val' in value) return textOf(value.val);
  return null;
}

const clip = (text: string, length: number) => (text.length > length ? text.slice(0, length) : text);

function attendeeNames(event: VEvent): string[] {
  const raw = (event as unknown as { attendee?: unknown }).attendee;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((a) => {
      if (typeof a === 'string') return a.replace(/^mailto:/i, '');
      const { params, val } = (a ?? {}) as { params?: { CN?: unknown }; val?: unknown };
      // A name can come through as a number, CN=12345, or as true or false.
      const cn = params?.CN;
      return cn !== undefined && cn !== null ? String(cn) : (textOf(val)?.replace(/^mailto:/i, '') ?? '');
    })
    .filter(Boolean)
    .slice(0, MAX_ATTENDEES)
    .map((name) => clip(name, MAX_ATTENDEE_NAME_LENGTH));
}

/** The day of an all-day instance of a series, as node-ical keys the instances it changes. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The meetings an entry puts in [from, to]: at most `room`, and at most MAX_INSTANCES_PER_SERIES
 * of one series, with `cut` saying whether there were more. Throws when it cannot be read.
 */
function instancesOf(
  event: VEvent,
  uid: string,
  from: Date,
  to: Date,
  room: number,
): { instances: ParsedEvent[]; cut: boolean } {
  const instances: ParsedEvent[] = [];
  if (!event.start) return { instances, cut: false };
  const allDay = (event.datetype as string | undefined) === 'date';
  const durationMs = event.end
    ? Math.max(0, event.end.getTime() - event.start.getTime())
    : allDay
      ? 86_400_000
      : 30 * 60_000;
  const description = textOf(event.description);
  const location = textOf(event.location);
  const base = {
    uid,
    title: clip(textOf(event.summary) ?? '(untitled)', MAX_TITLE_LENGTH),
    description: description ? clip(description, MAX_DESCRIPTION_LENGTH) : null,
    location: location ? clip(location, MAX_LOCATION_LENGTH) : null,
    allDay,
    attendees: attendeeNames(event),
  };
  // A date that is not one could be neither stored nor shown, so the entry it is in is not read.
  const real = (...dates: Date[]) => {
    if (dates.some((d) => Number.isNaN(d.getTime()))) throw new Error('A date of the feed is not a date');
  };

  if (event.rrule) {
    // Cancelled and moved instances of a recurring series.
    const exdates = new Set(
      Object.values((event.exdate ?? {}) as Record<string, Date>).map((d) => d.getTime()),
    );
    const overrides = (event.recurrences ?? {}) as Record<string, VEvent>;
    const most = Math.min(MAX_INSTANCES_PER_SERIES, room);
    for (const occurrence of event.rrule.between(from, to, true)) {
      if (exdates.has(occurrence.getTime())) continue;
      if (instances.length === most) return { instances, cut: true };
      // node-ical keys a changed instance of a series by its exact time, or by its day when the
      // series is all-day.
      const key = allDay ? localDay(occurrence) : occurrence.toISOString();
      const override = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
      const start = override?.start ?? occurrence;
      const end = override?.end ?? new Date(start.getTime() + durationMs);
      real(start, end);
      const title = override ? textOf(override.summary) : null;
      instances.push({ ...base, title: title ? clip(title, MAX_TITLE_LENGTH) : base.title, start, end });
    }
    return { instances, cut: false };
  }

  const end = event.end ?? new Date(event.start.getTime() + durationMs);
  real(event.start, end);
  if (end < from || event.start > to) return { instances, cut: false };
  if (room < 1) return { instances, cut: true };
  instances.push({ ...base, start: event.start, end });
  return { instances, cut: false };
}

/** What reading a feed came to. */
interface Reading {
  /** The meetings it puts in the window. */
  events: ParsedEvent[];
  /** How many of its meetings were set aside: they could not be read, or went past a limit. */
  skipped: number;
  /** The UIDs of those meetings: what the calendar has of them already is kept as it is. */
  keep: Set<string>;
}

/**
 * Read a feed into the meetings it puts in [from, to], setting aside any that cannot be read
 * or that go past a limit, and saying which.
 */
function readFeed(icsText: string, from: Date, to: Date): Reading {
  // A calendar from its BEGIN:VCALENDAR to its END:VCALENDAR, found by position alone, which
  // takes the same time however the text is made.
  const upper = icsText.toUpperCase();
  const begins = upper.indexOf('BEGIN:VCALENDAR');
  if (begins < 0 || upper.lastIndexOf('END:VCALENDAR') < begins) {
    throw new Error('The feed did not contain a complete calendar');
  }
  const deadline = performance.now() + READ_BUDGET_MS;
  const first = Math.floor(from.getTime() / 86_400_000) - MARGIN_DAYS;
  const last = Math.floor(to.getTime() / 86_400_000) + MARGIN_DAYS;
  const found = scan(icsText);
  const zones = zoneDefinitions(icsText, found.zones);

  // Meetings in the order the feed first gives them. An entry with no UID is a meeting of its own.
  const meetings: Meeting[] = [];
  const byUid = new Map<string, Meeting>();
  for (const entry of found.entries) {
    const known = entry.uid === null ? undefined : byUid.get(entry.uid);
    if (known) {
      known.entries.push(entry);
      continue;
    }
    const meeting: Meeting = { uid: entry.uid, entries: [entry], key: '', lines: [], borrows: false };
    meetings.push(meeting);
    if (entry.uid !== null) byUid.set(entry.uid, meeting);
  }

  const reading: Reading = { events: [], skipped: 0, keep: new Set() };
  const setAside = (m: Meeting) => {
    reading.skipped++;
    if (m.uid !== null) reading.keep.add(m.uid);
  };

  // The meetings that say anything of the window, the quickest to read first: those that happen
  // once, then series of the kind calendars make, then the rest. However a feed is ordered, a
  // series that takes long to work out cannot keep the others from being read.
  const cost = new Map<Meeting, number>();
  for (const m of meetings) {
    m.entries = forWindow(m.entries, first, last);
    cost.set(m, m.entries.some((e) => e.rule && !e.rule.plain) ? 2 : m.entries.some((e) => e.rule) ? 1 : 0);
  }
  const wanted = meetings.filter((m) => m.entries.length).sort((a, b) => cost.get(a)! - cost.get(b)!);

  // Which of them are read, as far as the feed's limits allow.
  const read: Meeting[] = [];
  let entries = 0;
  let cancellations = 0;
  const zoneNames = new Set<string>();
  const searches = new Set<string>();
  for (const m of wanted) {
    if (
      m.entries.length > MAX_ENTRIES_PER_MEETING ||
      entries + m.entries.length > MAX_ENTRIES ||
      m.entries.some((e) => e.rule && tooCostly(e.rule, e.start, first, last))
    ) {
      setAside(m);
      continue;
    }
    m.key = `e${read.length}`;
    const c = cleaned(icsText, m, first, last);
    const names = [...c.zones].filter((z) => !zoneNames.has(z));
    // A search costs something only where the feed has a definition of its own to search with.
    const looks = zones.length ? [...c.searches].filter((s) => !searches.has(s)) : [];
    if (
      c.unreadable ||
      cancellations + c.cancellations > MAX_CANCELLATIONS ||
      zoneNames.size + names.length > MAX_ZONE_NAMES ||
      searches.size + looks.length > MAX_ZONE_SEARCHES
    ) {
      setAside(m);
      continue;
    }
    entries += m.entries.length;
    cancellations += c.cancellations;
    for (const name of names) zoneNames.add(name);
    for (const look of looks) searches.add(look);
    m.lines = c.lines;
    m.borrows = c.borrows;
    read.push(m);
  }

  const byMeeting = new Map<Meeting, ParsedEvent[]>();
  let taken = 0;
  const full = () => taken >= MAX_MEETINGS_PER_FEED || performance.now() > deadline;
  for (let i = 0; i < read.length; ) {
    // A piece is as many whole meetings as come to ENTRIES_PER_PIECE entries, and at least one.
    const piece = [read[i]!];
    let size = read[i]!.entries.length;
    for (i++; i < read.length && size + read[i]!.entries.length <= ENTRIES_PER_PIECE; i++) {
      size += read[i]!.entries.length;
      piece.push(read[i]!);
    }
    if (full()) {
      piece.forEach(setAside);
      continue;
    }
    let parsed: CalendarResponse | null;
    try {
      parsed = parse(piece, zones);
    } catch {
      // Some meeting of it cannot be read: it is read a meeting at a time, and only that one is lost.
      parsed = null;
    }
    for (const m of piece) {
      if (full()) {
        setAside(m);
        continue;
      }
      try {
        const event = (parsed ?? parse([m], zones))[m.key];
        if (!event || event.type !== 'VEVENT') throw new Error('The meeting is not in what was read');
        const room = MAX_MEETINGS_PER_FEED - taken;
        const { instances, cut } = instancesOf(event as VEvent, m.uid ?? randomUUID(), from, to, room);
        byMeeting.set(m, instances);
        taken += instances.length;
        if (cut) setAside(m);
      } catch {
        setAside(m);
      }
    }
  }
  // In the order the feed gives them, whatever order they were read in: a meeting that is new
  // to the calendar can take its project from one written before it in the same sync.
  for (const m of meetings) for (const instance of byMeeting.get(m) ?? []) reading.events.push(instance);
  return reading;
}

/**
 * Whether a meeting the calendar has is one of a feed's that was set aside when it was read,
 * and so stays as it is: a meeting that could not be read this time has not been cancelled.
 */
function keptAsIs(reading: Reading, provider: string, id: string): boolean {
  if (!reading.keep.size) return false;
  // An id is the feed, the UID and the start, which is 24 characters.
  return reading.keep.has(id.slice(provider.length + 1, -25));
}

/**
 * Expand a feed into concrete event instances inside [from, to]. A feed is a calendar from
 * BEGIN:VCALENDAR to END:VCALENDAR, and anything else is refused: an error page that came
 * back as a 200, an empty answer, or a download that stopped short is not a calendar with
 * nothing in it, and reading it as one would remove every meeting the feed had given. A
 * meeting of it that cannot be read is left out, and the rest are read.
 */
export function parseFeed(icsText: string, from: Date, to: Date): ParsedEvent[] {
  return readFeed(icsText, from, to).events;
}

export interface SyncResult {
  sourceId: string;
  label: string;
  ok: boolean;
  events: number;
  /**
   * Meetings of a feed that was read that were set aside: they could not be read, or went past
   * what one feed can hold. Only how many: what they are is the feed's, and is not repeated.
   */
  skipped?: number;
  error?: string;
}

/** The statuses a redirect is answered with. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Why a feed cannot be read from an address as it stands, or null when it can: it must be a
 * web address, over https unless it is on this machine, with no user name or password in it.
 */
function unreadable(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'it is not a web address';
  if (url.username || url.password) return 'it has a user name or password in it';
  if (url.protocol === 'http:' && !onThisMachine(url)) return 'it is not over https';
  return null;
}

/**
 * Where a redirect leads, when it leads somewhere a feed can be read from, or null. A redirect
 * from another machine to this one is not followed either: nothing a calendar elsewhere sends
 * needs this machine to be asked for it, and that is how a feed would reach whatever else is
 * listening here. The machines of the owner's own network are not told apart from the internet,
 * here as when a feed is added: a calendar served at home can move like any other.
 */
function redirectTarget(location: string | null, from: URL): URL | null {
  if (!location) return null;
  let to: URL;
  try {
    // A Location can be relative, and is then taken from the address that sent it.
    to = new URL(location, from);
  } catch {
    return null;
  }
  if (unreadable(to)) return null;
  if (onThisMachine(to) && !onThisMachine(from)) return null;
  return to;
}

/** Let an answer go without reading it, so that its connection is freed. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/**
 * Read a feed. It is given up on after twenty seconds, or as soon as `signal` says the
 * server is closing, whichever comes first.
 *
 * Redirects are followed here rather than by fetch, so that each one is looked at before it is
 * asked for: it has to be to an address a feed can be read from, and there can be only so many.
 * An address stored as plain http is read over https all the same, as it is when it is added.
 * What goes wrong is said without the address it went wrong at, and of a server's answer only
 * its status is repeated: the words a server puts with it are its own, and can be anything.
 */
async function fetchText(address: string, signal: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(FEED_TIMEOUT_MS)]);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('The feed cannot be read from its address: it is not a web address');
  }
  const refused = unreadable(overHttps(url));
  if (refused) throw new Error(`The feed cannot be read from its address: ${refused}`);

  for (let redirects = 0; ; redirects++) {
    const res = await fetch(url, {
      signal: deadline,
      redirect: 'manual',
      headers: { accept: 'text/calendar, text/plain, */*' },
    });
    if (!REDIRECTS.has(res.status)) {
      if (!res.ok) {
        discard(res);
        throw new Error(`feed responded ${res.status}`);
      }
      return await readCapped(res);
    }
    discard(res);
    if (redirects === MAX_REDIRECTS) throw new Error('The feed redirected too many times');
    const next = redirectTarget(res.headers.get('location'), url);
    if (!next) throw new Error('The feed redirected to an address it cannot be read from');
    url = next;
  }
}

/**
 * The text of a feed's answer, read only as far as MAX_FEED_BYTES. An answer that says it is
 * larger is not read at all, and one that turns out larger is stopped as it passes the mark.
 */
async function readCapped(res: Response): Promise<string> {
  const tooLarge = () =>
    new Error(`The feed is larger than ${MAX_FEED_BYTES / (1024 * 1024)} MB, more than a calendar is`);
  if (Number(res.headers.get('content-length')) > MAX_FEED_BYTES) {
    discard(res);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FEED_BYTES) {
      reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
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

/** A meeting in the calendar that has a project, as far as a new meeting can take it from. */
interface Precedent {
  title: string | null;
  startsAt: string;
  projectId: number;
  /** It is the feed's own, and so counts for meetings of its title. */
  sameFeed: boolean;
}

/** A set of meetings that have a project, with the latest of them at hand. */
class Latest {
  private readonly ids = new Set<string>();
  private best: string | null = null;
  /** The latest has gone from the set, and the next is not yet worked out. */
  private stale = false;

  constructor(private readonly all: Map<string, Precedent>) {}

  add(id: string): void {
    this.ids.add(id);
    if (!this.stale && (this.best === null || this.later(id, this.best))) this.best = id;
  }

  remove(id: string): void {
    this.ids.delete(id);
    if (this.best === id) this.stale = true;
  }

  /** The project of the latest of them, or null when there are none. */
  project(): number | null {
    if (this.stale) {
      this.best = null;
      for (const id of this.ids) if (this.best === null || this.later(id, this.best)) this.best = id;
      this.stale = false;
    }
    return this.best === null ? null : this.all.get(this.best)!.projectId;
  }

  private later(a: string, b: string): boolean {
    return this.all.get(a)!.startsAt > this.all.get(b)!.startsAt;
  }
}

/**
 * Remember how meetings were categorised: once one instance of "Team standup" has been given a
 * project, instances that turn up later take the same one. Only a new meeting takes anything:
 * one that is in the calendar already keeps what it has, whoever gave it that, and that
 * includes nothing, so a project taken off a meeting by hand stays off.
 *
 * The meeting's own series comes first (the same UID in the same feed), and failing that a
 * meeting of exactly the same title in the same feed. Never one from another calendar: a "1:1"
 * there is somebody else's. Where they differ, the latest one counts.
 *
 * The meetings that have a project are read once a sync, and kept up to date as the sync
 * writes, so that each new meeting is worked out just as if the table were asked afresh, but
 * without a search of the whole table for each: nothing in it is kept in order of title, and a
 * feed can bring thousands of new meetings at once.
 */
class Precedents {
  private readonly all = new Map<string, Precedent>();
  private readonly series = new Map<string, Latest>();
  private readonly titles = new Map<string, Latest>();

  constructor(private readonly provider: string) {
    // An instance's id is the feed, the UID and its start (24 characters), so the instances of
    // one series in one feed are the ids that begin with the first two and add nothing but the
    // start. Every id of the feed's is from `provider:` up to `provider;`, the next character.
    const rows = db
      .prepare(
        `SELECT id, provider, title, starts_at, project_id FROM calendar_events
         WHERE project_id IS NOT NULL AND (provider = ? OR (id >= ? AND id < ?))
         ORDER BY rowid`,
      )
      .all(provider, `${provider}:`, `${provider};`) as {
      id: string;
      provider: string;
      title: string | null;
      starts_at: string;
      project_id: number;
    }[];
    for (const r of rows) this.add(r.id, r.title, r.starts_at, r.project_id, r.provider === provider);
  }

  /** The project a meeting new to the calendar takes: its series', or else its title's, or none. */
  forNew(uid: string, title: string): number | null {
    return this.series.get(`${this.provider}:${uid}:`)?.project() ?? this.titles.get(title)?.project() ?? null;
  }

  /** Note a meeting the sync has written, so that the meetings after it see the calendar as it is. */
  wrote(id: string, title: string, startsAt: string, projectId: number | null, isNew: boolean): void {
    if (isNew) {
      if (projectId !== null) this.add(id, title, startsAt, projectId, true);
      return;
    }
    // A meeting already there keeps its start, which is in its id, and its project, but it can
    // have been renamed, and then counts for its new title rather than its old one.
    const known = this.all.get(id);
    if (!known || known.title === title) return;
    if (known.sameFeed && known.title !== null) this.titles.get(known.title)?.remove(id);
    known.title = title;
    if (known.sameFeed) this.bucket(this.titles, title).add(id);
  }

  private add(id: string, title: string | null, startsAt: string, projectId: number, sameFeed: boolean): void {
    this.all.set(id, { title, startsAt, projectId, sameFeed });
    if (id.startsWith(`${this.provider}:`) && id.length >= 24) this.bucket(this.series, id.slice(0, -24)).add(id);
    if (sameFeed && title !== null) this.bucket(this.titles, title).add(id);
  }

  private bucket(map: Map<string, Latest>, key: string): Latest {
    let found = map.get(key);
    if (!found) map.set(key, (found = new Latest(this.all)));
    return found;
  }
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
      const text = await fetchText(source.url, signal);
      const reading = readFeed(text, from, to);
      const { events } = reading;
      // A calendar with events in it, none of them in the window, is meetings that are over (a
      // series that has ended): those go. One with no events in it at all is what a feed sends
      // when something is wrong at its end at least as often as when a calendar was emptied.
      const noEventsAtAll = !/BEGIN:VEVENT/i.test(text);
      const wrote = db.transaction((): boolean => {
        // Nothing is written for a feed that was removed while it was being read: its
        // events would be back with nothing to own them. This is the last look before the
        // writes, in the same transaction, so nothing can change between the two.
        if (signal.aborted || !stillSyncs(source)) return false;
        const stamp = nowIso();
        const current = new Set<string>();
        const precedents = new Precedents(provider);
        let tooLong = 0;
        for (const e of events) {
          const startIso = e.start.toISOString();
          const id = `${provider}:${e.uid}:${startIso}`;
          // A meeting's id is carried by every prompt about it and every block logged on it, and
          // past this length the routes would refuse it, so such an event (a UID thousands of
          // characters long) is left out rather than shown and then impossible to answer.
          if (id.length > MAX_EVENT_ID_LENGTH) {
            tooLong++;
            continue;
          }
          current.add(id);
          const isNew = !known.get(id);
          const projectId = isNew ? precedents.forNew(e.uid, e.title) : null;
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
            projectId,
            stamp,
          );
          precedents.wrote(id, e.title, startIso, projectId, isNew);
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
        if (tooLong) {
          console.warn(
            `[calendar] "${source.label}" has ${tooLong} event(s) whose id is too long to keep; they are left out`,
          );
        }
        if (noEventsAtAll && stale.length) {
          // A calendar with no events in it at all, where it had meetings a moment ago, is more
          // likely something wrong at the other end than every one of them cancelled, so what it
          // had is kept.
          console.warn(
            `[calendar] "${source.label}" came back with no meetings at all, so the ${stale.length} it had are kept`,
          );
          return true;
        }
        const remove = db.prepare('DELETE FROM calendar_events WHERE id = ?');
        for (const { id } of stale) {
          if (!current.has(id) && !keptAsIs(reading, provider, id)) remove.run(id);
        }
        return true;
      })();
      if (wrote) {
        if (reading.skipped) {
          console.warn(
            `[calendar] "${source.label}" has ${reading.skipped} meeting(s) that could not be read, or went past what one feed can hold; what the calendar had of them is kept`,
          );
        }
        results.push({
          sourceId: source.id,
          label: source.label,
          ok: true,
          events: events.length,
          skipped: reading.skipped,
        });
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
