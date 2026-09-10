import { clock } from '../lib/format';

/**
 * Countdown ring. The arc drains as the block runs; past the planned time it
 * fills back up in the overrun colour rather than resetting, because overrun
 * is still work and still gets counted.
 */
export function TimerRing({
  elapsedSeconds,
  plannedSeconds,
  paused,
  color,
  size = 232,
}: {
  elapsedSeconds: number;
  plannedSeconds: number;
  paused: boolean;
  color: string;
  size?: number;
}) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const over = elapsedSeconds > plannedSeconds;
  const remaining = Math.max(0, plannedSeconds - elapsedSeconds);
  const progress = over
    ? Math.min(1, (elapsedSeconds - plannedSeconds) / plannedSeconds)
    : 1 - remaining / Math.max(1, plannedSeconds);

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
          className="transition-[stroke-dashoffset] duration-1000 ease-linear"
          opacity={paused ? 0.45 : 1}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-5xl font-semibold leading-none text-ink" aria-live="off">
          {clock(over ? elapsedSeconds - plannedSeconds : remaining)}
        </div>
        <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          {paused ? 'Paused' : over ? 'Over planned time' : 'Remaining'}
        </div>
      </div>
    </div>
  );
}
