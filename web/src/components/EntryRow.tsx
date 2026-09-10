import type { Session } from '../api';
import { duration, timeOfDay } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { RatingDots } from './charts';

/**
 * A logged block, list form: what you did, which project it rolled up to, how
 * long it ran and when. The project colour rides a dot rather than the text —
 * several palette steps are illegible as type on the light surface.
 */
export function EntryRow({
  session,
  dark,
  onClick,
  showRating = true,
  compact = false,
}: {
  session: Session;
  dark: boolean;
  onClick?: () => void;
  showRating?: boolean;
  /** Drops the start-end range, for columns too narrow to carry both. */
  compact?: boolean;
}) {
  const color = seriesColor(session.projectColor, dark);
  const abandoned = session.status === 'abandoned';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors
        enabled:hover:bg-raised disabled:cursor-default
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 inline-block size-2.5 shrink-0 self-start rounded-full"
        style={{ background: color, opacity: abandoned ? 0.4 : 1 }}
      />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${
            abandoned ? 'text-muted line-through' : 'font-medium text-ink'
          }`}
        >
          {session.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          <span className="truncate">{session.projectName ?? 'No project'}</span>
          {session.interruptions > 0 && <span>{session.interruptions} interruptions</span>}
          {showRating && session.focusRating != null && <RatingDots rating={session.focusRating} />}
        </span>
        {session.notes && (
          <span className="mt-0.5 block truncate text-[11px] text-ink-2">{session.notes}</span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="tabular block text-sm font-semibold text-ink">
          {duration(session.elapsedSeconds)}
        </span>
        {!compact && (
          <span className="tabular mt-0.5 block text-[11px] text-muted">
            {timeOfDay(session.startedAt)}
            {session.endedAt && `–${timeOfDay(session.endedAt)}`}
          </span>
        )}
      </span>
    </button>
  );
}
