import type { SavedTimer } from '../api';
import { seriesColor } from '../lib/palette';
import { Empty } from './ui';

/**
 * One-click starting points, the way Timery's saved timers work — except the
 * list fills itself in from what you actually keep doing, so it is useful on
 * day two without anyone curating it. Pinning just holds one at the top.
 */
export function SavedTimers({
  timers,
  dark,
  disabled,
  onStart,
  onPin,
  onUnpin,
}: {
  timers: SavedTimer[];
  dark: boolean;
  disabled: boolean;
  onStart: (timer: SavedTimer) => void;
  onPin: (timer: SavedTimer) => void;
  onUnpin: (id: number) => void;
}) {
  if (!timers.length) {
    return (
      <Empty>
        Start a couple of blocks and the ones you repeat will show up here for
        one-click starting.
      </Empty>
    );
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {timers.map((timer) => {
        const color = seriesColor(timer.projectColor, dark);
        return (
          <li key={`${timer.projectId ?? 'none'}:${timer.title}`} className="group relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onStart(timer)}
              title={disabled ? 'Finish the block you are on first' : `Start "${timer.title}"`}
              className="flex w-full items-center gap-3 rounded-xl border border-hairline bg-surface
                py-2.5 pl-3 pr-8 text-left transition-all hover:-translate-y-px hover:border-axis
                hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] disabled:cursor-not-allowed
                disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-none
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full"
                style={{ background: `${color}1f` }}
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill={color}>
                  <path d="M8 5.5v13l11-6.5-11-6.5Z" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{timer.title}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{ background: color }}
                  />
                  <span className="truncate">{timer.projectName ?? 'No project'}</span>
                  <span className="tabular shrink-0">
                    {timer.plannedMinutes ? `· ${timer.plannedMinutes}m` : ''}
                    {timer.useCount > 1 ? ` · ${timer.useCount}×` : ''}
                  </span>
                </span>
              </span>
            </button>
            {/* Pin control sits outside the start button so a click can't do both. */}
            <button
              type="button"
              onClick={() => (timer.pinned && timer.id ? onUnpin(timer.id) : onPin(timer))}
              aria-label={timer.pinned ? `Unpin ${timer.title}` : `Pin ${timer.title}`}
              title={timer.pinned ? 'Unpin' : 'Pin to the top'}
              className={`absolute right-1 top-1 grid size-6 place-items-center rounded-md
                text-muted transition-opacity hover:bg-raised hover:text-ink
                focus-visible:outline-2 focus-visible:outline-accent
                ${timer.pinned ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100'}`}
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
                <path d="M14.6 2.3a1 1 0 0 1 1.4 0l5.7 5.7a1 1 0 0 1-.7 1.7h-2.6l-3.9 3.9.5 3.3a1 1 0 0 1-1.7.9l-3.2-3.2-4.8 4.8a1 1 0 0 1-1.4-1.4l4.8-4.8L5.5 10a1 1 0 0 1 .9-1.7l3.3.5 3.9-3.9V2.3Z" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
