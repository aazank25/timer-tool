import type { ProjectSlice } from '../api';
import { duration } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { WithTooltip } from './ui';

/**
 * A day's composition in one thin bar — the summary Timery puts above each
 * day's entries. Segments carry a 2px surface gap so neighbouring projects
 * read apart without a stroke around each one.
 */
export function DayBar({
  slices,
  dark,
  height = 6,
  targetSeconds,
}: {
  slices: ProjectSlice[];
  dark: boolean;
  height?: number;
  /** When given, the bar is drawn to scale against the target instead of to full width. */
  targetSeconds?: number;
}) {
  const total = slices.reduce((a, s) => a + s.seconds, 0);
  if (total === 0) {
    return (
      <div
        className="w-full rounded-full bg-track"
        style={{ height }}
        aria-label="No time logged"
      />
    );
  }
  const scale = targetSeconds && targetSeconds > total ? targetSeconds : total;

  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }}>
      {slices
        .filter((s) => s.seconds > 0)
        .map((slice) => (
          <WithTooltip
            key={slice.projectId ?? 'none'}
            content={`${slice.name} · ${duration(slice.seconds)} · ${slice.share}%`}
            className="!block h-full"
            style={{ width: `${(slice.seconds / scale) * 100}%` }}
          >
            <span
              className="block h-full rounded-full"
              style={{ background: seriesColor(slice.color, dark) }}
            />
          </WithTooltip>
        ))}
      {scale > total && (
        <span
          aria-hidden="true"
          className="block h-full rounded-full bg-track"
          style={{ width: `${((scale - total) / scale) * 100}%` }}
        />
      )}
    </div>
  );
}
