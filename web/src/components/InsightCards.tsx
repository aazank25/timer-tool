import { useInterruptionStats, useEstimateStats, type Accuracy } from '../insights';
import { reason } from '../api';
import { addDays } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { ChartFrame } from './charts';
import { Card, Empty, Swatch, WithTooltip } from './ui';

/** The Review cards that answer "what pulled me away" and "was my guess any good". */

/* ------------------------------------------------------------ interruptions */

interface ReasonBar {
  key: string;
  label: string;
  count: number;
  /** The interruptions with no reason given sit apart from the named ones, in a quieter tone. */
  quiet?: boolean;
}

/**
 * What interrupted you in the window Review is showing. Bars are counts, and each carries its
 * own label and its number, so the tone of a bar is never what says which reason it is. The
 * ones with no reason given come last whatever their count: they are the catch-all, not a
 * reason that ranks.
 */
export function InterruptionsCard({ from, to }: { from: string; to: string }) {
  const { data, isPending, error } = useInterruptionStats(from, to);

  const bars: ReasonBar[] = data
    ? [
        ...data.byReason.map((r) => ({ key: r.reason, label: r.label, count: r.count })),
        ...(data.unspecified > 0
          ? [{ key: 'none', label: 'No reason given', count: data.unspecified, quiet: true }]
          : []),
      ]
    : [];
  const total = data?.total ?? 0;
  const max = Math.max(...bars.map((b) => b.count), 1);
  const share = (count: number) => Math.round((count / Math.max(1, total)) * 100);

  return (
    <Card
      title="What interrupted you"
      subtitle="Interruptions logged on focus blocks in this window, most often first"
    >
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : error ? (
        <p role="alert" className="text-xs text-critical">
          {reason(error, 'Could not load the interruptions')}
        </p>
      ) : total === 0 ? (
        <Empty>
          No interruptions logged in this window. Tap “Got interrupted” on the Focus screen when
          something pulls you away, and pick what it was.
        </Empty>
      ) : (
        <ChartFrame
          table={{
            columns: ['Reason', 'Count', 'Share'],
            rows: bars.map((b) => [b.label, b.count, `${share(b.count)}%`]),
          }}
        >
          <p className="mb-3 text-xs text-ink-2">
            <span className="tabular text-sm font-semibold text-ink">{total}</span>{' '}
            {total === 1 ? 'interruption' : 'interruptions'}
          </p>
          <ul className="space-y-2.5">
            {bars.map((bar) => (
              <li key={bar.key}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className={`min-w-0 truncate ${bar.quiet ? 'text-ink-2' : 'text-ink'}`}>
                    {bar.label}
                  </span>
                  {/* A real space between the two: a margin alone reads aloud as "327%". */}
                  <span className="tabular shrink-0 text-ink-2">
                    {bar.count}{' '}
                    <span className="ml-0.5 text-muted">{share(bar.count)}%</span>
                  </span>
                </div>
                <WithTooltip content={`${bar.label} · ${bar.count} (${share(bar.count)}%)`}>
                  <span aria-hidden="true" className="block h-2.5 w-full bg-track/40">
                    <span
                      className="block h-full rounded-r"
                      style={{
                        width: `${Math.max(1.5, (bar.count / max) * 100)}%`,
                        background: bar.quiet ? 'var(--muted)' : 'var(--accent)',
                      }}
                    />
                  </span>
                </WithTooltip>
              </li>
            ))}
          </ul>
        </ChartFrame>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- estimates */

/**
 * A guess needs a long run to judge, so this looks back 90 days whichever window Review is
 * set to: a week holds too few estimated blocks for a median to mean anything.
 */
const ESTIMATE_DAYS = 90;

/**
 * One kind of estimate in words: "Blocks run 1.6× your guess (8)". Within a tenth either way
 * is "about right", above it is how many times the guess, and below it is the share of the
 * guess it took. With too few to take a median it says so, and how many there are so far.
 */
export function accuracyWords(subject: string, a: Accuracy): string {
  const ratio = a.medianRatio;
  if (ratio == null) return `${subject}: not enough yet (${a.count})`;
  if (ratio > 1.1) return `${subject} run ${ratio.toFixed(1)}× your guess (${a.count})`;
  if (ratio >= 0.9) return `${subject} are about right (${a.count})`;
  return `${subject} finish in ${Math.round(ratio * 100)}% of your guess (${a.count})`;
}

export function EstimatesCard({ dark, to }: { dark: boolean; to: string }) {
  const from = addDays(to, -(ESTIMATE_DAYS - 1));
  const { data, isPending, error } = useEstimateStats(from, to);

  return (
    <Card
      title="How your estimates hold up"
      subtitle={`Last ${ESTIMATE_DAYS} days · your guess against the time actually logged`}
    >
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : error ? (
        <p role="alert" className="text-xs text-critical">
          {reason(error, 'Could not load the estimates')}
        </p>
      ) : data.blocks.count + data.tasks.count === 0 ? (
        <Empty>
          No estimates to compare yet. Give a stopwatch block an estimate when you start it, or a
          task one, and what you finish lands here.
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-hairline bg-raised px-3 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Overall</div>
            <ul className="mt-1 space-y-0.5 text-sm text-ink">
              <li className="tabular">{accuracyWords('Blocks', data.blocks)}</li>
              <li className="tabular">{accuracyWords('Tasks', data.tasks)}</li>
            </ul>
          </div>

          <ul className="divide-y divide-hairline">
            {data.byProject.map((p) => (
              <li key={p.projectId ?? 'none'} className="py-2.5 first:pt-0 last:pb-0">
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  <Swatch color={seriesColor(p.color, dark)} />
                  <span className="truncate">{p.name}</span>
                </span>
                <ul className="tabular mt-1 space-y-0.5 pl-4 text-xs text-ink-2">
                  <li>{accuracyWords('Blocks', p.blocks)}</li>
                  <li>{accuracyWords('Tasks', p.tasks)}</li>
                </ul>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-muted">
            Median of actual ÷ estimate, so 1.0× is dead on. Needs three or more to say anything.
          </p>
        </div>
      )}
    </Card>
  );
}
