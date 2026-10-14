import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, focusDay, localDay, localHour } from '../src/lib/time.js';

/*
 * The three as they were when every call built a formatter of its own, kept word for word to
 * check against. The day and the hour have to come out the same for every instant, and so does
 * the focus day, but for the hours just after a clock change, where it is the clock and not
 * the hours gone by since midnight that turns the day over.
 */
function shippedLocalDay(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // en-CA renders ISO-like YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function shippedLocalHour(iso: string | Date, tz: string): number {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return Number(h) % 24;
}

function shippedFocusDay(iso: string | Date, tz: string, dayStartHour: number): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return shippedLocalDay(new Date(d.getTime() - dayStartHour * 3_600_000), tz);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

/** The zones checked, and the instants their clocks change at in 2026. */
const CHANGES: Record<string, string[]> = {
  // An hour forward in March and back in November.
  'America/New_York': ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z'],
  // An hour, at 01:00 UTC both times.
  'Europe/London': ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  // Five and three quarter hours ahead all year.
  'Asia/Kathmandu': [],
  // Thirteen and three quarter hours ahead in its summer, twelve and three quarters in its winter.
  'Pacific/Chatham': ['2026-04-04T14:00:00Z', '2026-09-26T14:00:00Z'],
  // Its clocks move by half an hour.
  'Australia/Lord_Howe': ['2026-04-04T15:00:00Z', '2026-10-03T15:30:00Z'],
  UTC: [],
};
const ZONES = Object.keys(CHANGES);

/** Hours the day can be set to start at: midnight, the shipped 4am, and as late as it goes. */
const DAY_STARTS = [0, 1, 3, 4, 6, 12];

/** How far ahead of UTC a zone's clocks are at an instant, in minutes. */
function offsetMinutes(ms: number, zone: string): number {
  const shown: Record<string, string> = {};
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ms);
  for (const part of parts) shown[part.type] = part.value;
  const reading = Date.UTC(
    Number(shown.year),
    Number(shown.month) - 1,
    Number(shown.day),
    Number(shown.hour),
    Number(shown.minute),
  );
  return (reading - Math.floor(ms / MINUTE) * MINUTE) / MINUTE;
}

/**
 * Instants through 2026 for a zone: every 7 minutes from 2 hours before each of its clock
 * changes (New York's, for a zone that has none) to 13 hours after, which takes in the day
 * starting at any hour it can be set to, and one every other day all year, 13 minutes later
 * each time, so the time of day comes round through every hour. Every instant is checked
 * against formatters made for each call, which cost far more than the ones kept, so this is
 * a sample and not every minute of the year.
 */
function instants(zone: string): number[] {
  const out: number[] = [];
  const changes = CHANGES[zone]!.length ? CHANGES[zone]! : CHANGES['America/New_York']!;
  for (const change of changes) {
    const at = Date.parse(change);
    for (let ms = at - 2 * HOUR; ms < at + 13 * HOUR; ms += 7 * MINUTE) out.push(ms);
  }
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let n = 0; n < 183; n++) out.push(start + n * (2 * DAY_MS + 13 * MINUTE));
  return out;
}

describe('the day and the hour of an instant in a timezone', () => {
  it('has each zone change its clocks at the instants these tests take them to', () => {
    for (const [zone, changes] of Object.entries(CHANGES)) {
      for (const change of changes) {
        const at = Date.parse(change);
        assert.notEqual(offsetMinutes(at - MINUTE, zone), offsetMinutes(at, zone), `${zone} ${change}`);
      }
    }
  });

  for (const zone of ZONES) {
    it(`reads ${zone} as a formatter made for each call did, and turns its focus day over by its clock`, () => {
      const changes = CHANGES[zone]!.map((change) => Date.parse(change));
      const all = instants(zone);
      let moved = 0;
      for (const ms of all) {
        const iso = new Date(ms).toISOString();
        const day = shippedLocalDay(iso, zone);
        const hour = shippedLocalHour(iso, zone);
        // The stored text, a Date and epoch milliseconds are one instant, read the same.
        assert.equal(localDay(iso, zone), day, `${zone} ${iso}`);
        assert.equal(localDay(new Date(ms), zone), day, `${zone} ${iso}`);
        assert.equal(localDay(ms, zone), day, `${zone} ${iso}`);
        assert.equal(localHour(iso, zone), hour, `${zone} ${iso}`);
        assert.equal(localHour(new Date(ms), zone), hour, `${zone} ${iso}`);
        assert.equal(localHour(ms, zone), hour, `${zone} ${iso}`);
        // Before the day-start hour on the zone's clock it is the day before, whatever the
        // hour is set to, and on the nights the clocks change too.
        for (const start of DAY_STARTS) {
          assert.equal(
            focusDay(iso, zone, start),
            hour < start ? addDays(day, -1) : day,
            `${zone} ${iso}, the day starting at ${start}`,
          );
        }
        // That is the day it always was, unless the clocks changed in the hours before.
        if (focusDay(iso, zone, 4) !== shippedFocusDay(iso, zone, 4)) {
          assert.ok(
            changes.some((change) => ms - 4 * HOUR < change && change <= ms),
            `${zone} ${iso} is not just after a clock change`,
          );
          moved++;
        }
      }
      assert.ok(all.length > 400, `only ${all.length} instants`);
      // The instants are dense enough after each change to take in the hour that moved.
      assert.equal(moved > 0, changes.length > 0, `${moved} instants moved`);
    });
  }

  it('keeps the zones apart, and the day apart from the hour, whatever order they are asked in', () => {
    // 23:30 UTC on New Year's Eve is already New Year's Day in Kathmandu and Chatham.
    const ms = Date.parse('2026-12-31T23:30:00Z');
    const expected = [
      ['UTC', '2026-12-31', 23],
      ['Asia/Kathmandu', '2027-01-01', 5],
      ['America/New_York', '2026-12-31', 18],
      ['Pacific/Chatham', '2027-01-01', 13],
    ] as const;
    for (let round = 0; round < 2; round++) {
      for (const [zone, day, hour] of expected) {
        assert.equal(localHour(ms, zone), hour, zone);
        assert.equal(localDay(ms, zone), day, zone);
      }
    }
  });

  it('still refuses a timezone that does not exist, every time it is asked', () => {
    for (let n = 0; n < 2; n++) {
      assert.throws(() => localDay('2026-10-14T12:00:00Z', 'Not/AZone'), RangeError);
      assert.throws(() => localHour('2026-10-14T12:00:00Z', 'Not/AZone'), RangeError);
      assert.throws(() => focusDay('2026-10-14T12:00:00Z', 'Not/AZone', 4), RangeError);
    }
  });

  it('still refuses an instant that is not one', () => {
    assert.throws(() => localDay('not a time', 'UTC'), RangeError);
    assert.throws(() => localHour(Number.NaN, 'UTC'), RangeError);
    assert.throws(() => focusDay('not a time', 'UTC', 4), RangeError);
  });
});

describe('the focus day on the nights the clocks change', () => {
  const ny = (iso: string) => focusDay(iso, 'America/New_York', 4);

  it('has begun at 4am summer time on the night New York goes forward', () => {
    // The clocks go from 02:00 to 03:00 on Sunday 8 March, so 04:00 is 08:00 UTC.
    assert.equal(ny('2026-03-08T08:00:00.000Z'), '2026-03-08');
    assert.equal(ny('2026-03-08T08:30:00.000Z'), '2026-03-08');
    assert.equal(ny('2026-03-08T08:59:59.999Z'), '2026-03-08');
    // 03:30, just after the jump, is still Saturday night.
    assert.equal(ny('2026-03-08T07:30:00.000Z'), '2026-03-07');
    assert.equal(ny('2026-03-08T06:59:59.999Z'), '2026-03-07');
  });

  it('has not begun at 3am standard time on the night New York goes back', () => {
    // The clocks go from 02:00 back to 01:00 on Sunday 1 November, so 03:00 is 08:00 UTC.
    assert.equal(ny('2026-11-01T08:00:00.000Z'), '2026-10-31');
    assert.equal(ny('2026-11-01T08:30:00.000Z'), '2026-10-31');
    assert.equal(ny('2026-11-01T08:59:59.999Z'), '2026-10-31');
    // 01:30 comes round twice, in summer time and then in standard time: Saturday night both times.
    assert.equal(ny('2026-11-01T05:30:00.000Z'), '2026-10-31');
    assert.equal(ny('2026-11-01T06:30:00.000Z'), '2026-10-31');
    // And at 04:00 the Sunday begins.
    assert.equal(ny('2026-11-01T09:00:00.000Z'), '2026-11-01');
  });

  it('is unchanged on an ordinary night', () => {
    // 01:30 New York on the 11th is still the 10th; 09:00 is the 11th.
    assert.equal(ny('2026-09-11T05:30:00.000Z'), '2026-09-10');
    assert.equal(ny('2026-09-11T08:00:00.000Z'), '2026-09-11');
    assert.equal(ny('2026-09-11T13:00:00.000Z'), '2026-09-11');
  });

  it('writes the day as it always did, for any year a time can be given in', () => {
    // A day key for a year before 1000 has always been written short, and one before the
    // year 1 by its year BC: odd, but it is what is stored, and the same instant has to keep
    // giving the same day.
    const instants = [
      '0000-01-01T00:00:00.000Z',
      '0000-01-01T10:00:00.000Z',
      '0001-01-01T02:00:00.000Z',
      '0099-06-01T03:59:59.999Z',
      '0999-12-31T23:00:00.000Z',
      '1000-01-01T02:00:00.000Z',
      '1969-12-31T23:59:59.500Z',
      '1970-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
      '-000001-06-01T10:00:00.000Z',
    ];
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Chatham']) {
      for (const iso of instants) {
        for (const start of [0, 4, 12]) {
          assert.equal(
            focusDay(iso, zone, start),
            shippedFocusDay(iso, zone, start),
            `${zone} ${iso}, the day starting at ${start}`,
          );
        }
        assert.equal(localDay(iso, zone), shippedLocalDay(iso, zone), `${zone} ${iso}`);
      }
    }
  });
});
