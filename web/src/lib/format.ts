/** "1h 25m", "45m", "—" for nothing at all. */
export function duration(seconds: number, opts: { zero?: string } = {}): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return total === 0 ? (opts.zero ?? '0m') : `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Countdown form: 44:59, or 1:04:59 once it passes an hour. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const hours1 = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;

export function timeOfDay(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

export function hourLabel(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export function dayLabel(day: string, opts: { weekday?: boolean } = {}): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: opts.weekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const todayKey = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
};

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 1,284 / 12.9K — compact figures for stat tiles. */
export function compact(n: number): string {
  if (Math.abs(n) < 1000) return String(n);
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    n,
  );
}
