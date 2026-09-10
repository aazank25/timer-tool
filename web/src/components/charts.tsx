import { useState, type ReactNode } from 'react';
import { compact, duration, hours1 } from '../lib/format';
import { BLUE_RAMP } from '../lib/palette';
import { Empty, Swatch, WithTooltip } from './ui';

/* ------------------------------------------------------------- stat tiles */

export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'neutral' | 'good' | 'warning';
}) {
  const toneClass =
    tone === 'good' ? 'text-good' : tone === 'warning' ? 'text-warning' : 'text-ink';
  return (
    <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {detail && <div className="mt-0.5 text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

/** The day's headline number. Exactly one per view. */
export function Hero({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="text-5xl font-semibold leading-tight text-ink">{value}</div>
      {detail && <div className="mt-1 text-sm text-ink-2">{detail}</div>}
    </div>
  );
}

/**
 * Progress toward the daily target. The unfilled track is a lighter step of
 * the fill's own ramp, so the whole bar reads as one measure.
 */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-ink-2">{label}</span>
        <span className="tabular text-muted">
          {duration(value)} / {duration(max)}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: BLUE_RAMP[1] }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: 'var(--accent)' }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- table view */

/** Every chart ships one: identity and values are never gated behind colour. */
export function TableView({
  columns,
  rows,
}: {
  columns: string[];
  rows: (ReactNode | string | number)[][];
}) {
  return (
    <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-hairline">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-raised text-muted">
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={`px-3 py-2 font-medium ${i ? 'text-right' : ''}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-ink-2">
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-hairline">
              {row.map((cell, ci) => (
                <td key={ci} className={`px-3 py-1.5 ${ci ? 'tabular text-right' : 'text-ink'}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartFrame({
  children,
  table,
}: {
  children: ReactNode;
  table?: { columns: string[]; rows: (ReactNode | string | number)[][] };
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div>
      {children}
      {table && (
        <>
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="mt-3 text-[11px] font-medium text-muted underline decoration-dotted
              underline-offset-2 hover:text-ink-2"
          >
            {showTable ? 'Hide values' : 'Show values'}
          </button>
          {showTable && <TableView columns={table.columns} rows={table.rows} />}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- bars: by name */

export interface NamedBar {
  key: string;
  name: string;
  color: string;
  seconds: number;
  detail?: string;
}

/**
 * Horizontal bars for magnitude by identity, biggest first. Each bar carries
 * its own name as a direct label, so colour never has to carry identity and no
 * legend box is needed.
 */
export function BarsByName({ bars, emptyText }: { bars: NamedBar[]; emptyText: string }) {
  if (!bars.length) return <Empty>{emptyText}</Empty>;
  const max = Math.max(...bars.map((b) => b.seconds), 1);

  return (
    <ChartFrame
      table={{
        columns: ['Project', 'Time', 'Blocks'],
        rows: bars.map((b) => [b.name, duration(b.seconds), b.detail ?? '—']),
      }}
    >
      <ul className="space-y-2.5">
        {bars.map((bar) => (
          <li key={bar.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <Swatch color={bar.color} />
                <span className="truncate text-ink">{bar.name}</span>
              </span>
              <span className="tabular shrink-0 text-ink-2">
                {duration(bar.seconds)}
                {bar.detail && <span className="ml-1.5 text-muted">{bar.detail}</span>}
              </span>
            </div>
            <WithTooltip
              content={
                <>
                  {bar.name} · {duration(bar.seconds)}
                  {bar.detail ? ` · ${bar.detail}` : ''}
                </>
              }
            >
              {/* 4px rounded data-end, square where it meets the baseline. */}
              <span className="block h-2.5 w-full rounded-l-none bg-track/40">
                <span
                  className="block h-full rounded-r"
                  style={{
                    width: `${Math.max(1.5, (bar.seconds / max) * 100)}%`,
                    background: bar.color,
                  }}
                />
              </span>
            </WithTooltip>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

/* --------------------------------------------------- columns: over a scale */

export interface Column {
  key: string;
  label: string;
  seconds: number;
  /** Shown on hover; falls back to the label. */
  tooltip?: ReactNode;
  emphasis?: boolean;
}

/**
 * A single series of columns over an ordered scale — days of a week, hours of
 * a day. One colour, so no legend; only the tallest column is labelled, and
 * the rest are carried by the axis, the tooltip and the table.
 */
export function Columns({
  columns,
  height = 132,
  emptyText,
  tableLabel = 'Bucket',
  labelEvery = 1,
}: {
  columns: Column[];
  height?: number;
  emptyText: string;
  tableLabel?: string;
  labelEvery?: number;
}) {
  const max = Math.max(...columns.map((c) => c.seconds), 1);
  if (!columns.some((c) => c.seconds > 0)) return <Empty>{emptyText}</Empty>;
  const peak = columns.reduce((a, b) => (b.seconds > a.seconds ? b : a), columns[0]!);

  return (
    <ChartFrame
      table={{
        columns: [tableLabel, 'Time'],
        rows: columns.filter((c) => c.seconds > 0).map((c) => [c.label, duration(c.seconds)]),
      }}
    >
      <div className="relative" style={{ height }}>
        {/* One recessive hairline at the top of the scale, and the baseline. */}
        <div className="absolute inset-x-0 top-0 border-t border-grid" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 border-t border-axis" aria-hidden="true" />
        <span className="absolute -top-0.5 right-0 translate-y-[-100%] text-[10px] tabular text-muted">
          {hours1(max)}h
        </span>
        <div className="flex h-full items-end gap-[2px]">
          {columns.map((col) => (
            <WithTooltip
              key={col.key}
              content={col.tooltip ?? `${col.label} · ${duration(col.seconds)}`}
              className="flex h-full flex-1 items-end"
            >
              <span className="flex h-full w-full items-end justify-center">
                <span
                  className="w-full max-w-6 rounded-t transition-[height] duration-300"
                  style={{
                    height: `${Math.max(col.seconds > 0 ? 3 : 0, (col.seconds / max) * 100)}%`,
                    background: col.seconds > 0 ? 'var(--accent)' : 'var(--grid)',
                    opacity: col.emphasis === false ? 0.45 : 1,
                  }}
                />
              </span>
            </WithTooltip>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex gap-[2px]">
        {columns.map((col, i) => (
          <span
            key={col.key}
            className="min-w-0 flex-1 text-center text-[10px] tabular whitespace-nowrap text-muted"
          >
            {i % labelEvery === 0 ? col.label : ''}
          </span>
        ))}
      </div>
      {/* The one direct label: the peak. Everything else lives in the tooltip. */}
      <p className="mt-1 text-[11px] text-muted">
        Best: <span className="text-ink-2">{peak.label}</span> at {duration(peak.seconds)}
      </p>
    </ChartFrame>
  );
}

/* ---------------------------------------------------------- focus score UI */

const SCORE_STEPS = [
  { min: 80, label: 'Deep', ramp: 8 },
  { min: 60, label: 'Solid', ramp: 6 },
  { min: 40, label: 'Choppy', ramp: 4 },
  { min: 0, label: 'Scattered', ramp: 2 },
];

export function scoreStep(score: number) {
  return SCORE_STEPS.find((s) => score >= s.min) ?? SCORE_STEPS[SCORE_STEPS.length - 1]!;
}

/** Focus score as an ordinal chip: a step of the blue ramp plus its word. */
export function ScoreChip({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-[11px] text-muted">unrated</span>;
  }
  const step = scoreStep(score);
  return (
    <WithTooltip content={`Focus score ${score}/100 — ${step.label}`}>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
        <Swatch color={BLUE_RAMP[step.ramp]!} />
        <span className="tabular">{score}</span>
        <span className="text-muted">{step.label}</span>
      </span>
    </WithTooltip>
  );
}

export function RatingDots({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-[11px] text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`Focus ${rating} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          className="size-1.5 rounded-full"
          style={{ background: n <= rating ? 'var(--accent)' : 'var(--track)' }}
        />
      ))}
      <span className="ml-1 text-[11px] tabular text-muted">{rating}/5</span>
    </span>
  );
}

export { compact };
