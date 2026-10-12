/**
 * Arithmetic on a block's run/pause history, kept apart from the database so it can be
 * checked on its own. Times are epoch milliseconds.
 */

/** One run of the clock. An open one (`end` null) is ticking: it runs up to now. */
export interface Span {
  start: number;
  end: number | null;
}

/** A block's segment rows as spans. */
export function toSpans(rows: { started_at: string; ended_at: string | null }[]): Span[] {
  return rows.map((r) => ({
    start: Date.parse(r.started_at),
    end: r.ended_at == null ? null : Date.parse(r.ended_at),
  }));
}

/** How long the clock has run in all, an open span counted up to `now`. */
export function workedMs(spans: Span[], now: number): number {
  return spans.reduce((sum, s) => sum + Math.max(0, (s.end ?? now) - s.start), 0);
}

/**
 * The moment the clock had run for `target` in all: the spans are walked in order and the
 * answer is the point inside one of them where the running total reaches it. Null if the
 * block has not worked that long yet.
 */
export function reachedAt(spans: Span[], target: number, now: number): number | null {
  let worked = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const length = Math.max(0, (s.end ?? now) - s.start);
    if (worked + length >= target) return s.start + (target - worked);
    worked += length;
  }
  return null;
}

/**
 * What is left of the spans once the wall-clock stretch [from, to] is taken out of them,
 * and how much of the clock's time that took.
 *
 *   inside a span      it splits in two
 *   across one end     it is trimmed to what lies outside
 *   over all of it     it is gone
 *
 * An open span is still ticking, so what lies after the stretch is open too: the clock
 * carries on from where the stretch ends. That is also true of a stretch that reaches past
 * `now`, which can only take out what has already happened, so it is cut off at `now`.
 * Spans come out in time order, and none comes out empty except an open one that starts
 * exactly now, which is a clock that has only just started again.
 */
export function cutOut(
  spans: Span[],
  from: number,
  to: number,
  now: number,
): { spans: Span[]; removedMs: number } {
  const out: Span[] = [];
  let removedMs = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const open = s.end == null;
    // The stretch as it applies to this span: an open one has only run up to now.
    const cutEnd = open ? Math.min(to, now) : to;
    const spanEnd = s.end ?? now;
    const overlapStart = Math.max(s.start, from);
    const overlapEnd = Math.min(spanEnd, cutEnd);
    if (overlapEnd <= overlapStart) {
      out.push(s);
      continue;
    }
    removedMs += overlapEnd - overlapStart;
    if (from > s.start) out.push({ start: s.start, end: from });
    if (open) {
      out.push({ start: cutEnd, end: null });
    } else if (to < (s.end as number)) {
      out.push({ start: to, end: s.end });
    }
  }
  return { spans: out, removedMs };
}
