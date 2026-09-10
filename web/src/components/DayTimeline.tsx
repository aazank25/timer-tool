import type { CalendarEvent, Session } from '../api';
import { duration, hourLabel, timeOfDay } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { Empty, WithTooltip } from './ui';

function hourOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

/**
 * The day as a strip: where the time actually went, and which meetings it sat
 * between. Blocks are positioned by wall-clock start and sized by the time
 * actually worked, so a block that was paused reads narrower than its span.
 */
export function DayTimeline({
  sessions,
  events,
  dark,
}: {
  sessions: Session[];
  events: CalendarEvent[];
  dark: boolean;
}) {
  const blocks = sessions.filter((s) => s.kind === 'focus' && s.elapsedSeconds > 0);
  const timed = events.filter((e) => !e.allDay);

  if (!blocks.length && !timed.length) {
    return <Empty>Nothing logged yet. Start a block and it will appear here.</Empty>;
  }

  const starts = [...blocks.map((b) => hourOf(b.startedAt)), ...timed.map((e) => hourOf(e.startsAt))];
  const ends = [
    ...blocks.map((b) => hourOf(b.startedAt) + b.elapsedSeconds / 3600),
    ...timed.map((e) => hourOf(e.endsAt)),
  ];
  const from = Math.max(0, Math.floor(Math.min(8, ...starts)));
  const to = Math.min(24, Math.ceil(Math.max(19, ...ends)));
  const span = Math.max(1, to - from);

  const place = (startIso: string, seconds: number) => {
    const start = hourOf(startIso);
    const left = ((start - from) / span) * 100;
    const width = (seconds / 3600 / span) * 100;
    return {
      left: `${Math.max(0, Math.min(100, left))}%`,
      width: `${Math.max(0.7, Math.min(100 - Math.max(0, left), width))}%`,
    };
  };

  const ticks = Array.from({ length: span + 1 }, (_, i) => from + i);

  return (
    <div>
      {timed.length > 0 && (
        <>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            Calendar
          </div>
          <div className="relative mb-3 h-5">
            {timed.map((e) => {
              const seconds = Math.max(
                600,
                (Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 1000,
              );
              return (
                <WithTooltip
                  key={e.id}
                  content={
                    <>
                      {e.title}
                      <br />
                      {timeOfDay(e.startsAt)}–{timeOfDay(e.endsAt)}
                      {e.projectName ? ` · ${e.projectName}` : ' · unassigned'}
                      {e.loggedSeconds > 0 ? ` · ${duration(e.loggedSeconds)} logged` : ''}
                    </>
                  }
                  className="!absolute inset-y-0"
                  style={place(e.startsAt, seconds)}
                >
                  <span
                    className="block h-5 truncate rounded border border-hairline px-1
                      text-[10px] leading-5 text-ink-2"
                    style={{
                      background: e.projectColor
                        ? `${seriesColor(e.projectColor, dark)}22`
                        : 'var(--grid)',
                    }}
                  >
                    {e.title}
                  </span>
                </WithTooltip>
              );
            })}
          </div>
        </>
      )}

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
        Focus blocks
      </div>
      <div className="relative h-9 rounded-lg border border-hairline bg-raised">
        {ticks.map((h) => (
          <span
            key={h}
            aria-hidden="true"
            className="absolute inset-y-0 border-l border-grid first:border-l-0"
            style={{ left: `${((h - from) / span) * 100}%` }}
          />
        ))}
        {blocks.map((b) => (
          <WithTooltip
            key={b.id}
            content={
              <>
                {b.title}
                <br />
                {b.projectName ?? 'Unassigned'} · {duration(b.elapsedSeconds)} ·{' '}
                {timeOfDay(b.startedAt)}
                {b.focusRating ? ` · focus ${b.focusRating}/5` : ''}
              </>
            }
            className="!absolute inset-y-1"
            style={place(b.startedAt, b.elapsedSeconds)}
          >
            {/* 2px surface gap keeps neighbouring blocks visually separate. */}
            <span
              className="mx-px block h-7 rounded"
              style={{ background: seriesColor(b.projectColor, dark) }}
            />
          </WithTooltip>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular text-muted">
        {ticks
          .filter((h) => h % 2 === 0)
          .map((h) => (
            <span key={h}>{hourLabel(h % 24)}</span>
          ))}
      </div>
    </div>
  );
}
