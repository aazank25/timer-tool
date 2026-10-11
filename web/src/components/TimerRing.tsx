import { clock } from '../lib/format';

/**
 * The block's clock face. A pomodoro is a countdown: the arc drains as the
 * block runs and, past the planned time, fills back up in the overrun colour
 * rather than resetting, because overrun is still work and still gets counted.
 * A stopwatch has no end to drain toward, so it counts up and its arc is a
 * one-hour sweep that wraps like a clock face — never the warning colour, since
 * running long is not a problem. Its estimate, if any, is only a caption.
 */
export function TimerRing({
  elapsedSeconds,
  plannedSeconds,
  estimatedSeconds = null,
  paused,
  color,
  size = 232,
}: {
  elapsedSeconds: number;
  /** Null for a stopwatch. */
  plannedSeconds: number | null;
  /** Stopwatch only, and only a caption: it never moves the arc. */
  estimatedSeconds?: number | null;
  paused: boolean;
  color: string;
  size?: number;
}) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const over = plannedSeconds != null && elapsedSeconds > plannedSeconds;
  const remaining = plannedSeconds == null ? 0 : Math.max(0, plannedSeconds - elapsedSeconds);
  const progress =
    plannedSeconds == null
      ? (elapsedSeconds % 3600) / 3600
      : over
        ? Math.min(1, (elapsedSeconds - plannedSeconds) / plannedSeconds)
        : 1 - remaining / Math.max(1, plannedSeconds);
  const shown =
    plannedSeconds == null ? elapsedSeconds : over ? elapsedSeconds - plannedSeconds : remaining;
  const label = plannedSeconds == null ? 'Elapsed' : over ? 'Over planned time' : 'Remaining';
  // A stopwatch's arc jumps back to empty each hour; animating that would
  // rewind the whole ring in a second. Two ticks of slack covers a skipped one.
  const snap = plannedSeconds == null && elapsedSeconds % 3600 < 2;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--track)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={over ? 'var(--warning)' : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className={snap ? undefined : 'transition-[stroke-dashoffset] duration-1000 ease-linear'}
          opacity={paused ? 0.45 : 1}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-5xl font-semibold leading-none text-ink" aria-live="off">
          {clock(shown)}
        </div>
        <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          {paused ? 'Paused' : label}
        </div>
        {plannedSeconds == null && estimatedSeconds != null && (
          <div className="tabular mt-1 text-[11px] text-muted">
            {`est. ${Math.round(estimatedSeconds / 60)}m`}
          </div>
        )}
      </div>
    </div>
  );
}
