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
 * The most of a feed that is read. Google and Outlook send a calendar whole, every meeting it
 * has ever had, each with its attendees and its conference details, and years of a busy work
 * calendar come to tens of megabytes. It is counted as the answer arrives, once it is unpacked,
 * so that an answer that is small on the wire and unpacks to gigabytes is stopped at the same
 * point as a large plain one.
 */
const MAX_FEED_BYTES = 100 * 1024 * 1024;
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

/** An IPv4 address as its four numbers, or null for anything else. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** An IPv6 address as its eight 16-bit groups, an IPv4 address written at its end included, or null. */
function ipv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  let text = host;
  // An IPv4 address at the end, ::ffff:127.0.0.1, is the last two groups.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = ipv4(tail[2]!);
    if (!v4) return null;
    text = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/** Whether an IPv4 address leads to this machine: 127.0.0.0/8, loopback, and 0.0.0.0/8, which goes to it too. */
const local4 = (v4: number[]) => v4[0] === 127 || v4[0] === 0;

/**
 * Whether an address is this machine's: its own name for itself, or an address that leads back
 * to it, written any way (127.0.0.0/8 and 0.0.0.0/8, :: and ::1, and those IPv4 addresses written
 * as IPv6 ones, ::ffff:127.0.0.1 or ::127.0.0.1). It is decided on the address as it is written:
 * a name is not looked up, so one that some DNS points at this machine is not told apart from
 * the names of other machines.
 */
function onThisMachine(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === 'localhost.' || /\.localhost\.?$/.test(host)) return true;
  const v4 = ipv4(host);
  if (v4) return local4(v4);
  const v6 = ipv6(host);
  if (!v6) return false;
  const zeros = (from: number, to: number) => v6.slice(from, to).every((g) => g === 0);
  // :: and ::1.
  if (zeros(0, 7) && v6[7]! <= 1) return true;
  // An IPv4 address in the last two groups, mapped (::ffff:0:0/96) or the older compatible form (::/96).
  if (zeros(0, 5) && (v6[5] === 0xffff || v6[5] === 0)) {
    return local4([v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff]);
  }
  return false;
}

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
/** The first letters of those, and of BEGIN and END, as codes: a line starting otherwise is not looked at. */
const WANTED_FIRST = new Set([...'SDLREABsdlreab'].map((c) => c.charCodeAt(0)));
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

/** Whether a character can be in the name a line starts with, as node-ical's pattern reads one. */
const nameChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;

/** The name a line starts with: letters, digits, _ and -. */
function nameOf(line: string): string {
  let i = 0;
  while (i < line.length && nameChar(line.charCodeAt(i))) i++;
  return line.slice(0, i);
}

/**
 * The longest line of a feed that is read whole. A real one is far shorter, but for a meeting's
 * description, of which the app keeps only the start.
 */
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * The lines of `text` from `from` to `to`, unfolded as node-ical unfolds them: a line that
 * starts with a space or a tab goes on the end of the one before, less that first character.
 *
 * A feed has millions of lines, and the app reads a few of each meeting's, so a line is found
 * without being copied out of the text: its first character and its name are read where they
 * are, and the line itself is put together only when it is asked for. Even then only its first
 * MAX_LINE_LENGTH + 1 characters are, and `long` says it goes on: nothing that long is needed
 * whole, and a line read whole each time it was looked at would cost as much as it is long, which
 * is how a single meeting could hold up all the others.
 */
class Lines {
  /** Where the line starts in the text, and where the one after it starts. */
  start = 0;
  end: number;
  /** How long the line is once it is unfolded. */
  length = 0;
  /** Where the first line of the text that it takes ends, before its line break, and where the next starts. */
  private stop = 0;
  private second = 0;
  private built: string | null = null;

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
    this.built = null;
    this.stop = this.step();
    this.second = this.end;
    this.length = this.stop - this.start;
    while (this.end < this.to) {
      const c = this.text.charCodeAt(this.end);
      if (c !== 32 && c !== 9) break;
      const from = this.end;
      this.length += this.step() - from - 1;
    }
    return true;
  }

  /** The line goes on past MAX_LINE_LENGTH, and `line` holds only its start. */
  get long(): boolean {
    return this.length > MAX_LINE_LENGTH;
  }

  /** The first character of the line, as a code, or NaN for an empty line. */
  get lead(): number {
    if (this.stop > this.start) return this.text.charCodeAt(this.start);
    // An empty line of the text, with folded lines after it.
    return this.length ? this.line.charCodeAt(0) : Number.NaN;
  }

  /** The line, unfolded: the whole of it, or the first MAX_LINE_LENGTH + 1 characters of a long one. */
  get line(): string {
    this.built ??= this.build();
    return this.built;
  }

  /** The name the line starts with, read off the text unless it goes on into a folded line. */
  name(): string {
    const { text, start, stop } = this;
    for (let i = start; i < stop; i++) if (!nameChar(text.charCodeAt(i))) return text.slice(start, i);
    return nameOf(this.line);
  }

  /** Move `end` past the line of the text that starts at it, and say where that line's text ends. */
  private step(): number {
    const { text, to } = this;
    const from = this.end;
    const nl = text.indexOf('\n', from);
    if (nl === -1 || nl >= to) {
      this.end = to;
      return to;
    }
    this.end = nl + 1;
    return nl > from && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
  }

  private build(): string {
    const { text } = this;
    const most = MAX_LINE_LENGTH + 1;
    let line = text.slice(this.start, Math.min(this.stop, this.start + most));
    // Each folded line after the first, less the space or tab it starts with, as far as the mark.
    for (let at = this.second; at < this.end && line.length < most; ) {
      const nl = text.indexOf('\n', at);
      const next = nl === -1 || nl >= this.end ? this.end : nl + 1;
      const stop = nl === -1 || nl >= this.end ? this.end : nl > at && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      line += text.slice(at + 1, Math.min(stop, at + 1 + most - line.length));
      at = next;
    }
    return line;
  }
}

/**
 * A component's name as a BEGIN or an END gives it. Names are the same in any case (RFC 5545),
 * and a space or a tab some program left after one does not make it another.
 */
const componentName = (value: string) => value.trim().toUpperCase();

/**
 * The components open at a line of a feed, outermost first, and how many of each are open. An
 * END closes the component it names and whatever was opened inside it and never closed. One that
 * names no open component closes the innermost all the same, as node-ical's END does, but never
 * one of the outermost `kept`: a stray END in a calendar does not end the calendar.
 */
class Nesting {
  readonly open: string[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly kept = 0) {}

  begin(value: string): void {
    const name = componentName(value);
    this.open.push(name);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * End what `value` names, telling `closed` of each component that closes, innermost first, with
   * how many are open once it has, and whether it is the one the END was for. A component closed
   * only because an END for one outside it came first was never ended.
   */
  end(value: string, closed: (name: string, depth: number, ended: boolean) => void = () => {}): void {
    const name = componentName(value);
    if (!this.counts.get(name)) {
      if (this.open.length > this.kept) closed(this.pop(), this.open.length, true);
      return;
    }
    for (;;) {
      const last = this.pop();
      closed(last, this.open.length, last === name);
      if (last === name) return;
    }
  }

  /** Close whatever is open inside the outermost `depth`, as never ended. */
  unwind(depth: number): void {
    while (this.open.length > depth) this.pop();
  }

  private pop(): string {
    const last = this.open.pop()!;
    this.counts.set(last, this.counts.get(last)! - 1);
    return last;
  }
}

/** The day a date is written on, in days since 1970, or null when it does not start as a date. */
function dayOf(value: string): number | null {
  if (value.length < 8) return null;
  let digits = 0;
  for (let i = 0; i < 8; i++) {
    const c = value.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return null;
    digits = digits * 10 + c;
  }
  const year = Math.floor(digits / 10_000);
  const month = Math.floor(digits / 100) % 100;
  return Math.floor(Date.UTC(year, month - 1, digits % 100) / 86_400_000);
}

/** A text value with its escapes undone, as node-ical undoes them. */
function unescaped(value: string): string {
  // Most have nothing to undo, and a feed has as many as it has entries.
  if (!value.includes('\\') && value.charCodeAt(0) !== 34) return value;
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
  if (!p.params) return { zone, kind, value: p.value };
  for (const param of p.params.split(';')) {
    const eq = param.indexOf('=');
    if (eq < 1) continue;
    const name = param.slice(0, eq).toUpperCase();
    const quoted = param.charCodeAt(eq + 1) === 34;
    const value = quoted ? param.slice(eq + 1).replace(/^"(.*)"$/u, '$1') : param.slice(eq + 1);
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
  /**
   * Its start is a time in a zone, so that its series is worked out in that zone: one it names,
   * or, for a time with no zone, perhaps one the feed defines. Not a date, or a time in UTC.
   */
  zoned: boolean;
  /** Its start is a time of day, in a zone or in UTC, and not a date. */
  timed: boolean;
  /**
   * Its text does not say when it ends: it has a DURATION, or a date that is not one, or a line
   * that says when it is was too long to be read.
   */
  open: boolean;
  /**
   * It cannot be read as it is written: it never ended (its END never came before another entry,
   * or the calendar, began or ended), or a line of it that the app reads whole is longer than
   * any real one. Its meeting is set aside.
   */
  broken: boolean;
}

/** What a recurrence rule says of how often, and for how long, a series goes on. */
interface Rule {
  /** DAILY, WEEKLY and so on, or what else the rule says. */
  freq: string;
  /** The length of one period of it in days, or null for a frequency there is no such thing as. */
  periodDays: number | null;
  interval: number;
  count: number | null;
  /** The day of its UNTIL. */
  until: number | null;
  /** Its BY lists, BYDAY and the rest, each as the values it gives. */
  by: Map<string, string[]>;
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
const BY_LISTS = ['BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYMONTHDAY', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYSETPOS'];

function ruleOf(text: string): Rule {
  const parts = new Map<string, string>();
  for (const part of text.toUpperCase().split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const freq = parts.get('FREQ') ?? '';
  const until = parts.get('UNTIL');
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  const by = new Map<string, string[]>();
  let plain = freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY';
  for (const name of BY_LISTS) {
    const list = parts.get(name);
    if (list === undefined) continue;
    const values = list.split(',').map((v) => v.trim());
    by.set(name, values);
    if (name === 'BYHOUR' || name === 'BYMINUTE' || name === 'BYSECOND' || values.length > 12) plain = false;
  }
  return {
    freq,
    periodDays: PERIOD_DAYS[freq] ?? null,
    interval: Math.max(1, Math.floor(Number(parts.get('INTERVAL'))) || 1),
    count: count !== null && Number.isFinite(count) ? count : null,
    until: until ? dayOf(until) : null,
    by,
    plain,
  };
}

/** A BYDAY value as its place in the month or year (0 for every one) and its day of the week, or null. */
function weekday(value: string): { ordinal: number; day: string } | null {
  const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value);
  return m ? { ordinal: m[1] ? Number(m[1]) : 0, day: m[2]! } : null;
}

/** Whether every value of a BY list is a whole number from `least` to `most`, or, where `signed`, from -`most` to -`least`. */
function within(values: string[], least: number, most: number, signed = false): boolean {
  return values.every((v) => {
    if (!/^[+-]?\d{1,2}$/.test(v)) return false;
    const n = Number(v);
    return (n >= least && n <= most) || (signed && n <= -least && n >= -most);
  });
}

const DAY_MS = 86_400_000;

/**
 * At most how many periods of a series go by from one of its dates to the next, where its rule
 * makes sure of it: 1 where every period has a date; 2 where a month can lack the day (no two
 * months in a row lack the 29th, 30th or 31st), 12 where the months are taken a few at a time
 * and so can lack it longer, and 8 for a yearly one, which can be on 29 February. Null where it
 * cannot be said: a month's fifth Friday, a Friday the 13th, the days of only some months in a
 * series that runs daily, weekly or monthly, a place in a set (BYSETPOS), a week or a day of the
 * year by its number. Times of day only add dates to a day that has one, so long as they are
 * real times; under a day, a BY list leaves periods out.
 */
function periodsPerDate(rule: Rule, start: number): number | null {
  const { by } = rule;
  if (by.has('BYSETPOS') || by.has('BYWEEKNO') || by.has('BYYEARDAY')) return null;
  const times = [['BYHOUR', 23], ['BYMINUTE', 59], ['BYSECOND', 60]] as const;
  if (times.some(([name, most]) => by.has(name) && !within(by.get(name)!, 0, most))) return null;
  const days = by.get('BYDAY')?.map(weekday);
  if (days?.some((d) => d === null)) return null;
  const monthDays = by.get('BYMONTHDAY');
  if (monthDays && !within(monthDays, 1, 31, true)) return null;
  /** Some value of BYDAY falls in every period: every Friday, or a first to `most`th one. */
  const everyPeriodHasDay = (most: number) => days!.some((d) => d!.ordinal === 0 || Math.abs(d!.ordinal) <= most);
  switch (rule.freq) {
    case 'SECONDLY':
    case 'MINUTELY':
    case 'HOURLY':
      return by.size ? null : 1;
    case 'DAILY':
      return by.has('BYDAY') || monthDays || by.has('BYMONTH') ? null : 1;
    case 'WEEKLY':
      return monthDays || by.has('BYMONTH') || (days && !days.every((d) => d!.ordinal === 0)) ? null : 1;
    case 'MONTHLY': {
      if (by.has('BYMONTH') || (days && monthDays)) return null;
      if (days) return everyPeriodHasDay(4) ? 2 : null;
      const dates = monthDays ? monthDays.map(Number) : [new Date(start * DAY_MS).getUTCDate()];
      return rule.interval === 1 || dates.some((d) => Math.abs(d) <= 28) ? 2 : 12;
    }
    case 'YEARLY':
      if (days && monthDays) return null;
      if (days && !everyPeriodHasDay(by.has('BYMONTH') ? 4 : 52)) return null;
      return 8;
    default:
      return null;
  }
}

/**
 * The day a series ends by, where its rule says: its UNTIL, or, for one that counts its dates,
 * the day its last is due at the latest, where its rule makes sure how often its dates come
 * (see periodsPerDate). Where it does not, a count says nothing of when the series ends, and
 * it is read to find out: a count taken as a date in every period would end a series of fifth
 * Fridays years before its last one.
 */
function endOf(rule: Rule, start: number | null): number | null {
  if (rule.until !== null) return rule.until;
  if (rule.count === null || rule.periodDays === null || start === null) return null;
  const stretch = periodsPerDate(rule, start);
  if (stretch === null) return null;
  // The first date can be late in its period, and the last late in the one it falls in.
  return start + (Math.max(0, rule.count - 1) * stretch + 1) * rule.interval * rule.periodDays;
}

/*
 * What working out a series costs. node-ical's rule engine (rrule-temporal) works a series out
 * for the window in one call, which cannot be stopped part way through, on the server's one
 * thread, which in the desktop app is the window's as well. So a series that would take long to
 * work out is set aside instead, and the rest of the feed is read as usual. What a rule costs was
 * measured against the engine, rule by rule, from those calendars make to those written to
 * hold a server up, and is estimated here from what the rule says. The estimate is never less
 * than what the engine was measured to take, and is no more than a few times it for a rule
 * that is quick to work out, so that those calendars make are always read. It adds up:
 *
 * - The periods of the window. The engine skips ahead to the window for a series that does not
 *   count its dates, and then looks at every date of a period that a BY list gives (a yearly
 *   one on every Monday looks at the whole year) at every time of day the rule gives.
 * - The periods before the window, for a series that counts its dates (COUNT). The engine counts
 *   most of those by arithmetic, where for a monthly or yearly series it first works out the
 *   periods ahead until it has counted every date, up to 400 years of them; but where a BY list
 *   leaves whole periods out (in October only, say) it looks at every period from the first, as
 *   it does for a series at a time of day whose last date is more than 200 years on.
 * - Time zones. For a series in a zone, the engine works out the zone's offsets for each year it
 *   looks at, about a millisecond a year the first time. To find where a counted series stands
 *   in the window it looks as far as its last date: five hundred years, for a yearly series
 *   counted five hundred times.
 */

/** The most milliseconds a series is worth: one that would take longer to work out is set aside. */
const MAX_SERIES_MS = 100;
/**
 * The most times of day a date of a series can come at (its BYHOUR, BYMINUTE and BYSECOND lists
 * multiplied out). Calendars give a series one time of day, and a few is as many as anything
 * gives; with many, the engine's costs go up in ways an estimate could not keep up with.
 */
const MAX_TIMES_OF_DAY = 4;
/** Past this many periods the engine gives up on a series in any case, having spent the time. */
const MAX_PERIODS = 10_000;
/**
 * A series that counts its dates from before 1970 is set aside: dates that early are many
 * times slower to work out, and no meeting goes back that far.
 */
const EARLIEST_COUNTED_START = 0;
/** Microseconds the engine takes over a period it goes through one by one, by frequency. */
const PERIOD_US: Record<string, number> = { SECONDLY: 3, MINUTELY: 3, HOURLY: 3, DAILY: 80, WEEKLY: 120, MONTHLY: 400, YEARLY: 1_000 };
/** Microseconds for each date and time of day it looks at, and for each date it gives back. */
const DATE_US = 5;
/** Microseconds for each date it counts going through the periods, past the first of each. */
const COUNTED_US = 60;
/**
 * The most periods the engine works out ahead for a monthly or yearly series it counts by
 * arithmetic: those after which the calendar repeats itself.
 */
const AHEAD_PERIODS: Record<string, number> = { MONTHLY: 4_800, YEARLY: 400 };
/** Microseconds it takes over each such period, each month of a year, and each date and time of day. */
const AHEAD_PERIOD_US: Record<string, number> = { MONTHLY: 4, YEARLY: 10 };
const AHEAD_MONTH_US = 5;
const AHEAD_DATE_US = 0.6;
/**
 * How far from its first date, in days, the last date of a series at a time of day can be for the
 * engine to count it by arithmetic; and microseconds for each date it counts going through the
 * periods instead, in UTC, where it does so faster than in a zone.
 */
const ARITHMETIC_DAYS = 200 * 366;
const COUNTED_IN_UTC_US: Record<string, number> = { SECONDLY: 5, MINUTELY: 5, HOURLY: 5, DAILY: 5, WEEKLY: 5, MONTHLY: 50, YEARLY: 100 };
/** Milliseconds to work out a zone's offsets for a year, and for a year it only passes through. */
const ZONE_YEAR_MS = 1;
const ZONE_PAST_YEAR_MS = 0.1;
const YEAR_DAYS = 365.25;

/** How many times of day each date of a series comes at: its BY lists of hours, minutes and seconds. */
function timesOfDay(rule: Rule): number {
  const n = (name: string) => rule.by.get(name)?.length ?? 1;
  switch (rule.freq) {
    case 'SECONDLY':
      return 1;
    case 'MINUTELY':
      return n('BYSECOND');
    case 'HOURLY':
      return n('BYMINUTE') * n('BYSECOND');
    default:
      return n('BYHOUR') * n('BYMINUTE') * n('BYSECOND');
  }
}

/** How many dates of a period the engine looks at, to find those that are the series'. */
function datesLookedAt(rule: Rule): number {
  const has = (name: string) => rule.by.has(name);
  const days = has('BYDAY') || has('BYMONTHDAY') || has('BYYEARDAY') || has('BYWEEKNO');
  switch (rule.freq) {
    case 'WEEKLY':
      return has('BYDAY') ? 7 : 1;
    case 'MONTHLY':
      return days ? 31 : 1;
    case 'YEARLY':
      return days ? 366 : (rule.by.get('BYMONTH')?.length ?? 1);
    default:
      return 1;
  }
}

/** The days of the week of a BYDAY list, each once, and how many dates of a month or a year it gives at most. */
function weekdaysOf(rule: Rule): { distinct: number; inMonth: number; inYear: number } {
  const days = (rule.by.get('BYDAY') ?? []).map(weekday);
  return {
    distinct: new Set(days.map((d) => d?.day)).size,
    // Each value is one date where it has a place (2TU), and every such day otherwise.
    inMonth: days.reduce((sum, d) => sum + (d?.ordinal ? 1 : 5), 0),
    inYear: days.reduce((sum, d) => sum + (d?.ordinal ? 1 : 53), 0),
  };
}

/**
 * At most how many dates one period of a series has, at all its times of day, before a place in
 * a set (BYSETPOS) picks some of them out.
 */
function datesOfPeriod(rule: Rule): number {
  const n = (name: string) => rule.by.get(name)?.length ?? 0;
  const week = weekdaysOf(rule);
  const months = n('BYMONTH');
  let dates = 1;
  if (rule.freq === 'WEEKLY') {
    dates = n('BYDAY') || 1;
  } else if (rule.freq === 'MONTHLY') {
    // A day of the week falls on one in seven of the days of the month that a list gives.
    const both = Math.ceil((week.distinct * n('BYMONTHDAY')) / 7);
    if (n('BYDAY') && n('BYMONTHDAY')) dates = Math.min(week.inMonth, n('BYMONTHDAY'), both);
    else dates = n('BYDAY') ? week.inMonth : n('BYMONTHDAY') || 1;
  } else if (rule.freq === 'YEARLY') {
    const inMonths = months || 12;
    if (n('BYYEARDAY')) dates = n('BYYEARDAY');
    else if (n('BYWEEKNO')) dates = n('BYWEEKNO') * (n('BYDAY') || 1);
    else if (n('BYDAY') && n('BYMONTHDAY')) dates = Math.min(week.inYear, inMonths * n('BYMONTHDAY'));
    else if (n('BYDAY')) dates = months ? months * week.inMonth : week.inYear;
    else if (n('BYMONTHDAY')) dates = inMonths * n('BYMONTHDAY');
    else dates = months || 1;
  }
  return Math.min(dates, 366) * timesOfDay(rule);
}

/** At most how many dates one period of a series has. */
function mostDates(rule: Rule): number {
  const places = rule.by.get('BYSETPOS')?.length;
  return places ? Math.min(datesOfPeriod(rule), places) : datesOfPeriod(rule);
}

/**
 * The fewest dates, at all its times of day, that every period of a series is sure to have, or 0
 * where a period can have none. Every Monday is four dates of any month or more, the 13th one, and
 * the second Tuesday one; but the 31st, a fifth Friday or 29 February is none in some periods, and
 * a list of months leaves the others out of a daily, weekly or monthly series.
 */
function leastDates(rule: Rule, start: number): number {
  const { by } = rule;
  const days = (by.get('BYDAY') ?? []).map(weekday);
  const monthDays = (by.get('BYMONTHDAY') ?? []).map(Number);
  const months = by.get('BYMONTH');
  if (by.has('BYWEEKNO') || by.has('BYYEARDAY') || days.some((d) => d === null)) return 0;
  if (!within(by.get('BYMONTHDAY') ?? [], 1, 31, true) || !within(months ?? [], 1, 12)) return 0;
  const times = [['BYHOUR', 23], ['BYMINUTE', 59], ['BYSECOND', 59]] as const;
  if (times.some(([name, most]) => by.has(name) && !within(by.get(name)!, 0, most))) return 0;
  /**
   * How many of a list of days of the month, or of places in a set, every period has, where it has
   * at least `most`: those from the start or those from the end, whichever are more, as the 1st
   * and the 28th from the end can be one day.
   */
  const sure = (values: number[], most: number) =>
    Math.max(new Set(values.filter((v) => v >= 1 && v <= most)).size, new Set(values.filter((v) => v <= -1 && v >= -most)).size);
  /** The dates of the BYDAY list sure to be in a run of `weeks` whole weeks: every Monday is one a week, and a second Tuesday one in all. */
  const onWeekdays = (weeks: number) => {
    const every = new Set(days.filter((d) => d!.ordinal === 0).map((d) => d!.day));
    const placed = days.filter((d) => d!.ordinal !== 0 && Math.abs(d!.ordinal) <= weeks && !every.has(d!.day));
    return every.size * weeks + new Set(placed.map((d) => d!.day)).size;
  };
  const startDate = new Date(start * DAY_MS);
  // Every day of the week, with days of the month, is those days of the month.
  if (monthDays.length && new Set(days.filter((d) => d!.ordinal === 0).map((d) => d!.day)).size === 7) days.length = 0;
  let dates = 0;
  switch (rule.freq) {
    case 'SECONDLY':
    case 'MINUTELY':
    case 'HOURLY':
      // Under a day, any BY list leaves periods out.
      return by.size ? 0 : 1;
    case 'DAILY':
      dates = days.length || monthDays.length || months ? 0 : 1;
      break;
    case 'WEEKLY':
      if (monthDays.length || months || days.some((d) => d!.ordinal !== 0)) return 0;
      dates = days.length ? onWeekdays(1) : 1;
      break;
    case 'MONTHLY':
      if (months || (days.length && monthDays.length)) return 0;
      if (days.length) dates = onWeekdays(4);
      else if (monthDays.length) dates = sure(monthDays, 28);
      else dates = startDate.getUTCDate() <= 28 ? 1 : 0;
      break;
    case 'YEARLY': {
      const inMonths = months ? new Set(months.map(Number)).size : 12;
      if (days.length && monthDays.length) return 0;
      if (days.length) dates = months ? onWeekdays(4) * inMonths : onWeekdays(52);
      else if (monthDays.length) dates = sure(monthDays, 28) * inMonths;
      else if (startDate.getUTCDate() <= 28) dates = months ? inMonths : 1;
      break;
    }
    default:
      return 0;
  }
  const distinct = (name: string) => (by.has(name) ? new Set(by.get(name)!.map(Number)).size : 1);
  dates *= distinct('BYHOUR') * distinct('BYMINUTE') * distinct('BYSECOND');
  const places = by.get('BYSETPOS');
  return places ? sure(places.map(Number), dates) : dates;
}

/**
 * At most how many periods go by, over a run of them, from one date of a series to the next:
 * 1 for a series with a date in every period, more where a BY list leaves periods out (12 for
 * a daily series in one month of the year, about 3 for a month's fifth Friday, 4 for a yearly
 * one on 29 February). Unlike periodsPerDate, it is an average and not a promise.
 */
function periodsApart(rule: Rule, start: number): number {
  const { by } = rule;
  const n = (name: string) => by.get(name)?.length ?? 0;
  const days = (by.get('BYDAY') ?? []).map(weekday);
  const monthDays = (by.get('BYMONTHDAY') ?? []).map(Number);
  const startDate = new Date(start * DAY_MS);
  const months = Math.min(12, n('BYMONTH'));
  const distinct = weekdaysOf(rule).distinct;
  /** A day of the week on given days of the month: the 13th is a Friday one month in seven. */
  const onDates = (inMonths: number) => Math.min(14, Math.max(1, 7 / (distinct * monthDays.length * inMonths)));
  let apart = 1;
  switch (rule.freq) {
    case 'DAILY':
      if (months) apart *= 12 / months;
      if (days.length) apart *= 7 / Math.min(7, distinct);
      if (monthDays.length) apart *= (monthDays.every((d) => Math.abs(d) > 28) ? 62 : 31) / Math.min(31, monthDays.length);
      break;
    case 'WEEKLY':
      if (months) apart *= 12 / months;
      if (monthDays.length) apart *= 31 / Math.min(31, monthDays.length);
      break;
    case 'MONTHLY': {
      const late = (dates: number[]) => dates.every((d) => Math.abs(d) > 28);
      if (months) apart *= 12 / months;
      if (days.length && monthDays.length) apart *= onDates(1);
      else if (days.length && !days.some((d) => d && (d.ordinal === 0 || Math.abs(d.ordinal) <= 4))) apart *= 3;
      else if (!days.length && late(monthDays.length ? monthDays : [startDate.getUTCDate()])) apart *= rule.interval > 1 ? 12 : 2;
      if (n('BYSETPOS')) apart *= 2;
      break;
    }
    case 'YEARLY': {
      const leapDay =
        (by.get('BYMONTH')?.join() === '2' && monthDays.length > 0 && monthDays.every((d) => d === 29)) ||
        (!by.size && startDate.getUTCMonth() === 1 && startDate.getUTCDate() === 29);
      if (leapDay) apart *= 4;
      if (by.get('BYWEEKNO')?.every((w) => Math.abs(Number(w)) === 53)) apart *= 6;
      if (by.get('BYYEARDAY')?.every((d) => Math.abs(Number(d)) === 366)) apart *= 4;
      if (days.length && days.every((d) => d && Math.abs(d.ordinal) >= 53)) apart *= 6;
      if (days.length && monthDays.length) apart *= onDates(months || 12);
      if (n('BYSETPOS')) apart *= 2;
      break;
    }
    default:
      // Under a day, a BY list leaves periods out: every hour of a day that is one in a week, say.
      if (by.size) apart *= 24 * 7;
  }
  return apart;
}

/**
 * Whether the engine counts the dates of a counted series by arithmetic, rather than one period
 * at a time: the rules its own shortcut takes, as it decides them. It takes none with a time of
 * day given twice, nor a monthly one with a place in its set given twice, nor one every hour in a
 * zone (whose clocks can go back an hour).
 */
function countedByArithmetic(rule: Rule, entry: Entry): boolean {
  const has = (name: string) => rule.by.has(name);
  const leavesPeriodsOut = has('BYMONTH') || has('BYMONTHDAY') || has('BYYEARDAY') || has('BYWEEKNO') || has('BYSETPOS');
  const days = (rule.by.get('BYDAY') ?? []).map(weekday);
  const placed = days.some((d) => d?.ordinal);
  const oneTime = timesOfDay(rule) === 1;
  const twice = (name: string) => {
    const values = rule.by.get(name) ?? [];
    return new Set(values.map(Number)).size !== values.length;
  };
  if (twice('BYHOUR') || twice('BYMINUTE') || twice('BYSECOND')) return false;
  switch (rule.freq) {
    case 'SECONDLY':
    case 'MINUTELY':
      return rule.by.size === 0;
    case 'HOURLY':
      return rule.by.size === 0 && !(entry.zoned && rule.interval === 1);
    case 'DAILY':
    case 'WEEKLY':
      return !leavesPeriodsOut && !placed;
    case 'MONTHLY':
      return !has('BYYEARDAY') && !has('BYWEEKNO') && (has('BYDAY') || has('BYMONTHDAY')) && !twice('BYSETPOS');
    case 'YEARLY': {
      if (has('BYYEARDAY') || has('BYWEEKNO')) return false;
      const dayLists = has('BYDAY') || has('BYMONTHDAY');
      // With no list of days, only a series at one time of day; nor a place in a set by month.
      if (!dayLists && (!oneTime || (has('BYMONTH') && has('BYSETPOS')))) return false;
      // Nor the second Monday of the year and the like together with every Monday, or with dates.
      return !(placed && !has('BYMONTH') && (has('BYMONTHDAY') || days.some((d) => d?.ordinal === 0)));
    }
    default:
      return false;
  }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Microseconds the engine takes over a period of a counted series that it works out ahead (see costOf). */
function aheadCost(rule: Rule): number {
  const dates = datesOfPeriod(rule);
  if (rule.freq === 'MONTHLY') return AHEAD_PERIOD_US.MONTHLY! + dates * AHEAD_DATE_US;
  // A year is worked out twice over, a month at a time: those of its list, or all twelve for a list of days.
  const months = rule.by.get('BYMONTH')?.length ?? (rule.by.has('BYDAY') || rule.by.has('BYMONTHDAY') ? 12 : 1);
  return 2 * (AHEAD_PERIOD_US.YEARLY! + months * AHEAD_MONTH_US + dates * AHEAD_DATE_US);
}

/** An estimate, never too low, of the milliseconds the engine takes to work a series out for the window [first, last]. */
function costOf(rule: Rule, entry: Entry, first: number, last: number): number {
  const start = entry.start;
  if (rule.periodDays === null || start === null) return 0;
  if (timesOfDay(rule) > MAX_TIMES_OF_DAY) return Infinity;
  const length = rule.periodDays * rule.interval;
  const looked = datesLookedAt(rule) * timesOfDay(rule);
  // The periods a counted series takes to give all its dates: that many at most where every
  // period has a few, and about that many where some have none.
  const least = leastDates(rule, start);
  const toCount = rule.count === null ? Infinity : least > 0 ? Math.ceil(rule.count / least) + 1 : rule.count * periodsApart(rule, start);
  // The day of its last date at the latest, and so the last day the engine can need to reach.
  const reach = rule.count === null ? Infinity : start + Math.min(toCount * length, 1e8);
  const end = Math.min(last, rule.until ?? Infinity, reach);
  const fromDay = Math.max(first, start);
  // The periods of the window, and one either side of it that the engine works out to find its edges.
  const inWindow = end < fromDay ? 0 : (end - fromDay) / length + 2;
  const given = Math.min(rule.count ?? Infinity, inWindow * mostDates(rule));
  let us = given * DATE_US;
  const zoneYears = (to: number) => (entry.zoned ? Math.max(0, to - start) / YEAR_DAYS : 0);
  if (rule.count === null) {
    if (inWindow > MAX_PERIODS) return Infinity;
    us += inWindow * (PERIOD_US[rule.freq]! + looked * DATE_US);
    if (entry.zoned) us += (Math.max(0, first - start) / YEAR_DAYS) * ZONE_PAST_YEAR_MS * 1000;
    return us / 1000;
  }
  const before = Math.max(0, Math.min(last, reach) - start) / length;
  if (start < EARLIEST_COUNTED_START || before > MAX_PERIODS) return Infinity;
  // The dates up to the window, which it counts where it goes through the periods.
  const counted = Math.min(rule.count, (before + 1) * mostDates(rule));
  if (countedByArithmetic(rule, entry)) {
    const repeat = AHEAD_PERIODS[rule.freq];
    if (repeat) us += Math.min(repeat / gcd(rule.interval, repeat), toCount + 1) * aheadCost(rule);
    us += zoneYears(reach) * ZONE_YEAR_MS * 1000;
    // For a time of day, in UTC as in a zone, the engine gives the arithmetic up where the last
    // date can be too far on, and goes through every period from the first after all.
    if (!entry.timed || reach - start <= ARITHMETIC_DAYS) return us / 1000;
    if (!entry.zoned) return (us + counted * COUNTED_IN_UTC_US[rule.freq]!) / 1000;
  }
  us += (before + 1) * (PERIOD_US[rule.freq]! + looked * DATE_US);
  us += Math.max(0, counted - (before + 1)) * COUNTED_US;
  us += zoneYears(end) * ZONE_YEAR_MS * 1000;
  return us / 1000;
}

/** Whether working a series out for the window, from first to last, is more than a sync can do. */
function tooCostly(rule: Rule, entry: Entry, first: number, last: number): boolean {
  return costOf(rule, entry, first, last) > MAX_SERIES_MS;
}

/** The first and last days a read for [from, to] looks at, as days since 1970. */
const windowDays = (from: Date, to: Date) => ({
  first: Math.floor(from.getTime() / DAY_MS) - MARGIN_DAYS,
  last: Math.floor(to.getTime() / DAY_MS) + MARGIN_DAYS,
});

/**
 * What a read for [from, to] takes working out a series that starts at `dtstart` (its DTSTART
 * line) by the rule `rule` to cost, in milliseconds, and whether it sets the series aside for it.
 * For the tests, which hold the estimate to what the engine was measured to take.
 */
export function seriesCost(dtstart: string, rule: string, from: Date, to: Date): { ms: number; setAside: boolean } {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:cost', dtstart, `RRULE:${rule}`, 'END:VEVENT', 'END:VCALENDAR'];
  const [entry] = scan(text.join('\r\n'), Number.POSITIVE_INFINITY).entries;
  if (!entry?.rule) return { ms: 0, setAside: false };
  const { first, last } = windowDays(from, to);
  return { ms: costOf(entry.rule, entry, first, last), setAside: tooCostly(entry.rule, entry, first, last) };
}

/**
 * The lines of an entry that the app needs whole: what it is, when, and how it repeats. One
 * longer than MAX_LINE_LENGTH is no real calendar's, and its meeting is set aside. The text of a
 * title, a place or a description is only ever kept in part, and is cut instead.
 */
const READ_WHOLE = new Set(['UID', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'EXDATE', 'RECURRENCE-ID', 'SEQUENCE']);

/** The lines of an entry that say when it is, which are read as the feed is cut into entries. */
const NOTED = new Set(['UID', 'RRULE', 'DURATION', 'DTSTART', 'DTEND', 'RECURRENCE-ID']);

/** The first letters of those two sets' names, in capitals and in small letters, as codes. */
const NOTED_FIRST = new Set([...'UuRrDdEeSs'].map((c) => c.charCodeAt(0)));

/** Take what a line of an entry's own says of when the entry is. */
function note(entry: Entry, lines: Lines): void {
  // Only lines named so say anything of it, and the rest are passed over unread.
  if (!NOTED_FIRST.has(lines.lead)) return;
  const upper = lines.name().toUpperCase();
  if (lines.long) {
    if (READ_WHOLE.has(upper)) {
      // What it said cannot be known, so the entry cannot be judged to be outside the window.
      entry.broken = true;
      entry.open = true;
    }
    return;
  }
  if (!NOTED.has(upper)) return;
  const p = property(lines.line);
  if (!p) return;
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
    const d = dated(p);
    const day = dayOf(d.value);
    if (p.name === 'RECURRENCE-ID') {
      entry.instanceOf = true;
      entry.instance ??= day;
    } else if (day === null) {
      entry.open = true;
    } else if (p.name === 'DTSTART') {
      if (entry.start === null) {
        entry.zoned = zonedTime(d);
        entry.timed = !dateOnly(d);
      }
      entry.start ??= day;
    } else {
      entry.end ??= day;
    }
  }
}

/** Zone names that are UTC by another name, in which a series is worked out as it is in UTC. */
const UTC_NAMES = new Set(['UTC', 'ETC/UTC', 'GMT', 'ETC/GMT', 'Z', 'ZULU', 'UNIVERSAL', 'ETC/UNIVERSAL']);

/**
 * Whether a date line's value is a time in a zone: one it names, or for one with no zone and no
 * Z, perhaps one the feed defines. A date with no time is not, and nor is a time in UTC.
 */
function zonedTime(d: { zone: string | null; kind: string | null; value: string }): boolean {
  if (dateOnly(d) || d.value.endsWith('Z')) return false;
  return d.zone === null || !UTC_NAMES.has(d.zone.toUpperCase());
}

/** Whether a date line's value is a date with no time of day. */
const dateOnly = (d: { kind: string | null; value: string }) => d.kind === 'DATE' || /^\d{8}$/.test(d.value);

/** What cutting a feed into its entries came to. */
interface Scan {
  entries: Entry[];
  zones: [number, number][];
  /** The whole of the text was looked at: false when the time to read the feed ran out first. */
  complete: boolean;
}

/** How many lines are looked at between two looks at the clock, which costs more than a line. */
const LINES_BETWEEN_CLOCKS = 1024;

/**
 * Find the entries and the time zone definitions of a feed: the VEVENTs and VTIMEZONEs directly
 * inside a VCALENDAR, each as the stretch of text it takes. Whatever else the feed has, to-dos,
 * journals or components of its own invention, is passed over. A VEVENT can hold no other, so
 * one that has not ended when the next begins never will: it is set aside, and cannot take the
 * meetings after it with it. Stops at `deadline`, and then says the text was not all looked at.
 */
function scan(text: string, deadline: number): Scan {
  const entries: Entry[] = [];
  const zones: [number, number][] = [];
  // The calendar itself is never closed by an END for something else.
  const nesting = new Nesting(1);
  let entry: Entry | null = null;
  let zone = -1;
  const lines = new Lines(text, 0, text.length);
  /** The entry or the zone that is open is over at `to`, by its own END or not. */
  const over = (to: number, ended: boolean) => {
    if (entry) {
      entry.to = to;
      if (!ended) entry.broken = true;
      entries.push(entry);
      entry = null;
    } else if (zone >= 0) {
      zones.push([zone, to]);
      zone = -1;
    }
  };
  for (let n = 1; lines.next(); n++) {
    if (n % LINES_BETWEEN_CLOCKS === 0 && performance.now() > deadline) return { entries, zones, complete: false };
    const lead = lines.lead;
    // B and E, of BEGIN and END: node-ical knows them only in capitals.
    if (lead === 66 || lead === 69) {
      const named = lines.name();
      const begins = named === 'BEGIN';
      if (begins || named === 'END') {
        const p = property(lines.line);
        if (p && p.name === named) {
          const name = componentName(p.value);
          if (!begins) {
            nesting.end(name, (_closed, depth, ended) => {
              if (depth === 1 && nesting.open[0] === 'VCALENDAR') over(lines.end, ended);
            });
            continue;
          }
          if ((name === 'VEVENT' || name === 'VTIMEZONE') && (entry || zone >= 0)) {
            nesting.unwind(1);
            over(lines.start, false);
          }
          if (nesting.open.length === 1 && nesting.open[0] === 'VCALENDAR') {
            if (name === 'VEVENT') {
              entry = {
                from: lines.start,
                to: lines.start,
                uid: null,
                rule: null,
                instanceOf: false,
                instance: null,
                start: null,
                end: null,
                zoned: false,
                timed: false,
                open: false,
                broken: false,
              };
            } else if (name === 'VTIMEZONE') {
              zone = lines.start;
            }
          }
          nesting.begin(name);
          continue;
        }
      }
    }
    if (entry && nesting.open.length === 2) note(entry, lines);
  }
  // The text ended with an entry still open.
  over(text.length, false);
  return { entries, zones, complete: true };
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
    // A line of a zone that long is no zone's: the zone is not read.
    if (lines.long) return null;
    const p = property(lines.line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const part = componentName(p.value);
      nesting.begin(part);
      if (nesting.open.length === 2 && OBSERVANCES.has(part)) out.push(`BEGIN:${part}`);
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
  /** The time to read the feed ran out before it was all looked at. */
  late: boolean;
}

/** The lines whose text the app keeps only the start of, and so can cut: see READ_WHOLE. */
const CUT_TO_FIT = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION']);

/**
 * The text node-ical is handed for a meeting: each of its entries under the meeting's key, with
 * only the lines the app reads (no alarms, nothing of the feed's own invention), and with only
 * the cancelled instances that fall in the window. And what that takes of the feed's limits.
 */
function cleaned(text: string, m: Meeting, first: number, last: number, deadline: number): Cleaned {
  const out: Cleaned = {
    lines: [],
    cancellations: 0,
    zones: new Set(),
    searches: new Set(),
    borrows: false,
    unreadable: false,
    late: false,
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
    for (let n = 1; lines.next(); n++) {
      if (n % LINES_BETWEEN_CLOCKS === 0 && performance.now() > deadline) {
        out.late = true;
        return out;
      }
      if (!WANTED_FIRST.has(lines.lead)) continue;
      const named = lines.name();
      if (named === 'BEGIN' || named === 'END') {
        const p = property(lines.line);
        if (!p) continue;
        if (named === 'BEGIN') {
          nesting.begin(p.value);
          continue;
        }
        nesting.end(p.value);
        if (!nesting.open.length) break;
        continue;
      }
      // Inside an alarm, or another component of the entry's: none of it is read.
      if (nesting.open.length > 1) continue;
      const name = named.toUpperCase();
      if (!WANTED.has(name)) continue;
      if (name === 'ATTENDEE' && ++attendees > MAX_ATTENDEE_LINES) continue;
      if (lines.long && !CUT_TO_FIT.has(name)) {
        // A guest's line that long is no guest's, and is passed over. Every other line read whole
        // has set the meeting aside already, as the feed was cut into entries.
        if (name === 'ATTENDEE') continue;
        out.unreadable = true;
        break;
      }
      // Of a line that long, its start: the parameters and as much of the text as is kept anyway.
      const line = lines.line;
      const p = property(line);
      if (!p) {
        // Its parameters go on past the start, and what it says cannot be known.
        if (lines.long) {
          out.unreadable = true;
          break;
        }
        continue;
      }
      let keep = line;
      if (name === 'RRULE') {
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
export interface Reading {
  /** The meetings it puts in the window. */
  events: ParsedEvent[];
  /** How many of its meetings were set aside: they could not be read, or went past a limit. */
  skipped: number;
  /** The UIDs of those meetings: what the calendar has of them already is kept as it is. */
  keep: Set<string>;
  /**
   * The time to read the feed ran out before it had even been cut into its meetings, so it is not
   * known which they are: what the calendar has of every one of them is kept as it is.
   */
  keepAll: boolean;
}

/**
 * Whether the text has a calendar in it, from a BEGIN:VCALENDAR to an END:VCALENDAR, found by
 * position alone, which takes the same time however the text is made, and without a copy of it.
 */
function wholeCalendar(text: string): boolean {
  const begins = text.search(/BEGIN:VCALENDAR/i);
  if (begins < 0) return false;
  // A calendar ends the feed it is in, so the end of the text is looked at first.
  const ends = /END:VCALENDAR/gi;
  ends.lastIndex = Math.max(begins, text.length - 1024);
  if (ends.test(text)) return true;
  ends.lastIndex = begins;
  return ends.test(text);
}

/**
 * Read a feed into the meetings it puts in [from, to], setting aside any that cannot be read
 * or that go past a limit, and saying which. All of it, cutting the text into meetings included,
 * is done in READ_BUDGET_MS, and what is left when that runs out is set aside.
 */
export function readFeed(icsText: string, from: Date, to: Date): Reading {
  const deadline = performance.now() + READ_BUDGET_MS;
  if (!wholeCalendar(icsText)) throw new Error('The feed did not contain a complete calendar');
  const { first, last } = windowDays(from, to);
  const found = scan(icsText, deadline);

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

  const reading: Reading = { events: [], skipped: 0, keep: new Set(), keepAll: false };
  if (!found.complete) {
    // Which meetings the rest of the text holds is not known: none of the feed is read, and the
    // count is of those it was seen to have, at the least one.
    reading.keepAll = true;
    reading.skipped = Math.max(1, meetings.length);
    return reading;
  }
  const zones = zoneDefinitions(icsText, found.zones);
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
      performance.now() > deadline ||
      m.entries.some((e) => e.broken) ||
      m.entries.length > MAX_ENTRIES_PER_MEETING ||
      entries + m.entries.length > MAX_ENTRIES ||
      m.entries.some((e) => e.rule && tooCostly(e.rule, e, first, last))
    ) {
      setAside(m);
      continue;
    }
    m.key = `e${read.length}`;
    const c = cleaned(icsText, m, first, last, deadline);
    const names = [...c.zones].filter((z) => !zoneNames.has(z));
    // A search costs something only where the feed has a definition of its own to search with.
    const looks = zones.length ? [...c.searches].filter((s) => !searches.has(s)) : [];
    if (
      c.late ||
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
  if (reading.keepAll) return true;
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

/** A meeting the window held when a sync began. */
interface StoredMeeting {
  id: string;
  starts_at: string;
  project_id: number | null;
}

/**
 * How far a meeting can move and still be taken for the same meeting. A meeting's id is its
 * feed, its UID and its start, so a meeting that moves goes from the calendar and comes back
 * under another id, and what was linked to the old one would be lost: the time logged on it,
 * the project given to it. Within this of each other, a meeting that goes and one of the same
 * series (the same UID in the same feed) that arrives are the same meeting. It is as far as a
 * meeting is moved within its day, and as far as an earlier version of the app stored the
 * meetings of a series from their right times on a computer outside UTC: by the computer's
 * offset from UTC, which is fourteen hours at the most.
 */
const SAME_MEETING_MS = 14 * 60 * 60_000;

/**
 * The meetings that go that are the same meetings as ones that arrive, by the id each arrives
 * under. Each one that goes is paired with the one of its series that arrives nearest to it, and
 * no meeting is paired twice; where two pairs are as near, the earlier meetings are paired first.
 */
function sameMeetings(
  provider: string,
  leaving: StoredMeeting[],
  arriving: { id: string; startIso: string }[],
): Map<string, StoredMeeting> {
  // An id is the feed, the UID and the start, which is 24 characters.
  const uidOf = (id: string) => id.slice(provider.length + 1, -25);
  const series = new Map<string, { gone: { at: number; row: StoredMeeting }[]; come: { at: number; id: string }[] }>();
  const of = (uid: string) => {
    let found = series.get(uid);
    if (!found) series.set(uid, (found = { gone: [], come: [] }));
    return found;
  };
  for (const row of leaving) of(uidOf(row.id)).gone.push({ at: Date.parse(row.starts_at), row });
  for (const { id, startIso } of arriving) {
    const found = series.get(uidOf(id));
    if (found) found.come.push({ at: Date.parse(startIso), id });
  }
  const pairs = new Map<string, StoredMeeting>();
  for (const { gone, come } of series.values()) {
    if (!gone.length || !come.length) continue;
    gone.sort((a, b) => a.at - b.at);
    come.sort((a, b) => a.at - b.at);
    const near: [number, number, number][] = [];
    for (let i = 0, from = 0; i < gone.length; i++) {
      const at = gone[i]!.at;
      while (from < come.length && come[from]!.at < at - SAME_MEETING_MS) from++;
      for (let j = from; j < come.length && come[j]!.at <= at + SAME_MEETING_MS; j++) {
        near.push([Math.abs(come[j]!.at - at), i, j]);
      }
    }
    near.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const wentWith = new Set<number>();
    const cameWith = new Set<number>();
    for (const [, i, j] of near) {
      if (wentWith.has(i) || cameWith.has(j)) continue;
      wentWith.add(i);
      cameWith.add(j);
      pairs.set(come[j]!.id, gone[i]!.row);
    }
  }
  return pairs;
}

/**
 * Move what is about a meeting to it under its new id: the blocks logged on it, the plan items
 * made of it, and what was done about its prompts, so that its time stays logged, it cannot be
 * logged twice, and a prompt answered for it is not asked again.
 */
function moveLinks(moved: Map<string, StoredMeeting>): void {
  if (!moved.size) return;
  const to = new Map<string, string>();
  for (const [id, was] of moved) to.set(was.id, id);
  for (const table of ['sessions', 'plan_items']) {
    const linked = db
      .prepare(`SELECT DISTINCT calendar_event_id AS id FROM ${table} WHERE calendar_event_id IS NOT NULL`)
      .all() as { id: string }[];
    const move = db.prepare(`UPDATE ${table} SET calendar_event_id = ? WHERE calendar_event_id = ?`);
    for (const { id } of linked) {
      const now = to.get(id);
      if (now) move.run(now, id);
    }
  }
  // meeting-start:<id> and meeting-end:<id>, as the meeting prompts write them down.
  const notes = db.prepare("SELECT key FROM prompt_state WHERE key LIKE 'meeting-%:%'").all() as { key: string }[];
  const rename = db.prepare('UPDATE OR IGNORE prompt_state SET key = ? WHERE key = ?');
  for (const { key } of notes) {
    const colon = key.indexOf(':');
    const now = to.get(key.slice(colon + 1));
    if (now) rename.run(`${key.slice(0, colon + 1)}${now}`, key);
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
        // What the window held before this sync: what of it the feed no longer has goes.
        const before = db
          .prepare(
            'SELECT id, starts_at, project_id FROM calendar_events WHERE provider = ? AND starts_at >= ? AND starts_at <= ?',
          )
          .all(provider, from.toISOString(), to.toISOString()) as StoredMeeting[];
        const writes: { e: ParsedEvent; id: string; startIso: string; isNew: boolean }[] = [];
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
          writes.push({ e, id, startIso, isNew: !known.get(id) });
        }
        if (tooLong) {
          console.warn(
            `[calendar] "${source.label}" has ${tooLong} event(s) whose id is too long to keep; they are left out`,
          );
        }
        const current = new Set(writes.map((w) => w.id));
        // A calendar with no events in it at all, where it had meetings a moment ago, is more
        // likely something wrong at the other end than every one of them cancelled, so what it
        // had is kept.
        const keepAll = noEventsAtAll && before.length > 0;
        if (keepAll) {
          console.warn(
            `[calendar] "${source.label}" came back with no meetings at all, so the ${before.length} it had are kept`,
          );
        }
        const leaving = keepAll
          ? []
          : before.filter((r) => !current.has(r.id) && !keptAsIs(reading, provider, r.id));
        // A meeting that goes where one of its series arrives near it is that one, moved.
        const moved = sameMeetings(provider, leaving, writes.filter((w) => w.isNew));
        const precedents = new Precedents(provider);
        for (const { e, id, startIso, isNew } of writes) {
          // A meeting that was moved keeps the project it had, none included, as one that stayed
          // does; only one that is new to the calendar takes one from the meetings like it.
          const was = isNew ? moved.get(id) : undefined;
          const projectId = !isNew ? null : was ? was.project_id : precedents.forNew(e.uid, e.title);
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
        moveLinks(moved);
        // Only now remove what the feed no longer has, so a meeting that was cancelled or
        // moved disappears while one that is still there keeps the project it was given by
        // hand. Clearing the whole window first used to wipe that on every sync. It comes
        // after the writes above so that a new instance can still inherit its project from a
        // meeting of its series that goes.
        const remove = db.prepare('DELETE FROM calendar_events WHERE id = ?');
        for (const { id } of leaving) remove.run(id);
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
