import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { reason, type Session, type TaskStatus } from '../api';
import { BarsByName, Columns, Hero, StatTile } from '../components/charts';
import { DayBar } from '../components/DayBar';
import { EntryRow } from '../components/EntryRow';
import { Button, Card, Empty, Swatch } from '../components/ui';
import {
  DoneBar,
  NoteField,
  StatusPill,
  StatusSelect,
  SummaryCard,
  useDraft,
} from '../components/wrapup';
import { useActiveSession, useSessionActions, useToday } from '../hooks';
import { addDays, dayLabel } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { defaultWeek, realDay, weekStart } from '../lib/weeks';
import { daySummary, span, weekSummary } from '../lib/wrapupSummary';
import {
  useWrapUpActions,
  useWrapUpDay,
  useWrapUpWeek,
  type WrapUpDay,
  type WrapUpDayTask,
  type WrapUpWeek,
  type WrapUpWeekTask,
} from '../wrapup';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What is logged against what was guessed: "2h 30m of 3h", or just what is logged with no guess. */
const loggedText = (loggedSeconds: number, estimatedMinutes: number | null) =>
  estimatedMinutes == null
    ? `${span(loggedSeconds)} logged`
    : `${span(loggedSeconds)} of ${span(estimatedMinutes * 60)}`;

/** One short weekday for a chart's axis: seven of the full date would run into each other. */
const weekdayShort = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });

/* ----------------------------------------------------------------------- day */

/**
 * Closing out a day: what it came to, the blocks still to rate, where the tasks it
 * touched stand, a line for tomorrow and a summary to paste. `?day=` opens any other day,
 * which is how a wrap-up skipped last night gets done the next morning.
 */
export function WrapUpDayPage({ dark }: { dark: boolean }) {
  const [params, setParams] = useSearchParams();
  const { data: todayInfo } = useToday();
  const today = todayInfo?.today;
  // Nothing is read until the server has said which day it is: the browser's own date is
  // not the day the user is in when they are up past midnight.
  const day = realDay(params.get('day')) ?? today;
  const running = useActiveSession().data?.session?.status === 'running';
  const { data: view, error } = useWrapUpDay(day, { poll: running });

  const go = (target: string) =>
    setParams(target === today ? {} : { day: target }, { replace: true });
  const isToday = day !== undefined && day === today;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Wrap up the day</h1>
          <p className="text-xs text-muted">
            {day ? dayLabel(day, { weekday: true }) : ' '}
            {isToday && ' · today'}
          </p>
        </div>
        {day && today && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => go(addDays(day, -1))} aria-label="Previous day">
              ←
            </Button>
            <Button
              size="sm"
              onClick={() => go(addDays(day, 1))}
              disabled={day >= today}
              aria-label="Next day"
            >
              →
            </Button>
            {!isToday && (
              <Button size="sm" variant="ghost" onClick={() => go(today)}>
                Back to today
              </Button>
            )}
          </div>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-xs text-critical">
          {reason(error, 'Could not load the day')}
        </p>
      ) : !view ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        // Keyed by day, so stepping to another one starts its note box and its status from scratch.
        <DayScreen key={view.day} view={view} dark={dark} isToday={isToday} />
      )}
    </div>
  );
}

function DayScreen({ view, dark, isToday }: { view: WrapUpDay; dark: boolean; isToday: boolean }) {
  const actions = useWrapUpActions();
  const [draft, setDraft] = useDraft(view.note);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const live = view.sessions.find((s) => s.isLive);

  return (
    <div className="space-y-4">
      {live && (
        <p
          role="status"
          className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-ink"
        >
          “{live.title}” is still on the clock. Its time so far is counted below; finish it to rate
          it.
        </p>
      )}

      {view.previous && <Planned previous={view.previous} day={view.day} />}

      <DayTotals view={view} dark={dark} />

      <RateWhatsLeft view={view} dark={dark} />

      <TasksMoved
        tasks={view.tasks}
        dark={dark}
        // "Today" is only right for today: any other day is named, so the figures are not misread.
        when={isToday ? 'today' : `on ${weekdayShort(view.day)}`}
        error={statusError}
        onStatus={(task, status) => {
          setStatusError(null);
          actions.setTaskStatus.mutate(
            { id: task.id, status },
            { onError: (err) => setStatusError(reason(err, 'Could not change the status')) },
          );
        }}
      />

      <Card
        title="Tomorrow"
        subtitle="One line for future you. It is there on the next wrap-up as what you planned."
      >
        <NoteField
          label="Tomorrow"
          placeholder="What is the first thing to pick up?"
          draft={draft}
          onDraft={setDraft}
          saved={view.note}
          onSave={(note) => actions.saveDayNote.mutateAsync({ day: view.day, note })}
        />
      </Card>

      <SummaryCard text={daySummary(view, draft.trim() || null)} />

      <DoneBar
        button="Done for the day"
        hint="Marks the day as wrapped up. You can still change the note afterwards."
        doneWord="Wrapped up"
        stamp={view.wrappedUpAt}
        pending={actions.finishDay.isPending}
        error={finishError}
        onDone={() => {
          setFinishError(null);
          actions.finishDay.mutate(view.day, {
            onError: (err) => setFinishError(reason(err, 'Could not wrap up the day')),
          });
        }}
      />
    </div>
  );
}

/**
 * What the last wrap-up said to do next. The note is the latest one from before this day,
 * which is yesterday's unless yesterday had none, so the label says which day it is from
 * when it is not yesterday's.
 */
function Planned({ previous, day }: { previous: { day: string; note: string }; day: string }) {
  const when =
    previous.day === addDays(day, -1) ? 'Yesterday' : dayLabel(previous.day, { weekday: true });
  return (
    <div className="rounded-2xl border border-hairline border-l-4 border-l-accent bg-surface px-4 py-3">
      <p className="break-words text-sm text-ink">
        <span className="font-medium">{when} you planned:</span> {previous.note}
      </p>
    </div>
  );
}

function DayTotals({ view, dark }: { view: WrapUpDay; dark: boolean }) {
  const rated = view.sessions.filter((s) => s.focusRating != null).length;
  return (
    <Card>
      <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <Hero
          label="Focused time"
          value={span(view.focusSeconds)}
          detail={plural(view.blocks, 'block')}
        />
        <div className="space-y-3">
          <DayBar slices={view.byProject} dark={dark} height={8} />
          {view.byProject.length > 0 && (
            <ul className="space-y-1.5 text-xs">
              {view.byProject.map((p) => (
                <li key={p.projectId ?? 'none'} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Swatch color={seriesColor(p.color, dark)} />
                    <span className="truncate text-ink">{p.name}</span>
                  </span>
                  <span className="tabular shrink-0 text-ink-2">{span(p.seconds)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile
              label="Avg focus"
              value={view.avgFocusRating != null ? `${view.avgFocusRating}/5` : '—'}
              detail={`${rated} rated`}
            />
            <StatTile label="Left to rate" value={view.unrated.length} />
            <StatTile label="Tasks moved" value={view.tasks.length} />
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Every finished block with no rating, one tap each. A rated block leaves the list: the
 * server stops listing it as soon as it has a rating, and the list is read again then.
 */
function RateWhatsLeft({ view, dark }: { view: WrapUpDay; dark: boolean }) {
  const { update } = useSessionActions();
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(view.sessions.map((s) => [s.id, s]));
  const todo = view.unrated.map((id) => byId.get(id)).filter((s): s is Session => s != null);

  // A day with nothing finished on it has nothing to rate, and no card to say so.
  if (!view.sessions.some((s) => s.status === 'completed')) return null;

  const rate = (session: Session, rating: number) => {
    setError(null);
    update.mutate(
      { id: session.id, focusRating: rating },
      { onError: (err) => setError(reason(err, 'Could not save the rating')) },
    );
  };

  return (
    <Card
      title="Rate what's left"
      subtitle={
        todo.length
          ? `${plural(todo.length, 'finished block')} with no rating. 1 is scattered, 5 is flow.`
          : undefined
      }
    >
      {todo.length === 0 ? (
        <p className="text-sm text-ink-2">✓ Every finished block is rated.</p>
      ) : (
        <ul className="space-y-2">
          {todo.map((s) => {
            // Only the block being rated is held still, and the number pressed shows as it goes.
            const saving = update.isPending && update.variables?.id === s.id;
            const pressed = saving ? update.variables?.focusRating : null;
            return (
              <li key={s.id} className="rounded-xl border border-hairline bg-raised py-1 pr-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  {/* The block as the block log draws it, so it is known at a glance which one it is. */}
                  <div className="min-w-0 flex-1 basis-64">
                    <EntryRow session={s} dark={dark} showRating={false} />
                  </div>
                  <div
                    role="group"
                    aria-label={`Focus rating for ${s.title}`}
                    // Under the title when the row wraps (the block's dot and gap are 2rem wide).
                    className="flex gap-1.5 pb-1.5 pl-8"
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Button
                        key={n}
                        size="sm"
                        className="w-9 tabular"
                        variant={pressed === n ? 'primary' : 'default'}
                        disabled={saving}
                        aria-label={`Rate "${s.title}" ${n} of 5`}
                        onClick={() => rate(s, n)}
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}

function TasksMoved({
  tasks,
  dark,
  when,
  error,
  onStatus,
}: {
  tasks: WrapUpDayTask[];
  dark: boolean;
  /** Which day the time is of, as it reads after a duration: "today", or "on Sun". */
  when: string;
  error: string | null;
  onStatus: (task: WrapUpDayTask, status: TaskStatus) => void;
}) {
  return (
    <Card
      title="Tasks you moved"
      subtitle="The time put on each, what is logged against its estimate, and where it stands"
    >
      {tasks.length === 0 ? (
        <Empty>No block was spent on a task.</Empty>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl
                border border-hairline bg-raised px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words text-sm font-medium text-ink">{t.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <Swatch color={seriesColor(t.projectColor, dark)} />
                    {t.projectName ?? 'No project'}
                  </span>
                  <span className="tabular text-ink-2">
                    {span(t.secondsToday)} {when}
                  </span>
                  <span className="tabular">{loggedText(t.loggedSeconds, t.estimatedMinutes)}</span>
                </p>
              </div>
              <StatusSelect title={t.title} status={t.status} onChange={(s) => onStatus(t, s)} />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------- week */

/**
 * The Monday review: the week as a whole, what got done, what did not, and a line for the
 * one ahead. `?week=` takes any day of the week wanted. With none it opens on last week
 * on a Monday or Tuesday and on this one after that (see defaultWeek for why).
 */
export function WrapUpWeekPage({ dark }: { dark: boolean }) {
  const [params, setParams] = useSearchParams();
  const { data: todayInfo } = useToday();
  const today = todayInfo?.today;
  const requested = realDay(params.get('week'));
  const week = requested ? weekStart(requested) : today ? defaultWeek(today) : undefined;
  const current = today ? weekStart(today) : undefined;
  const running = useActiveSession().data?.session?.status === 'running';
  const { data: view, error } = useWrapUpWeek(week, { poll: running });

  // Landing back on the week it opens on leaves the address as plain as it was.
  const go = (target: string) =>
    setParams(today && target === defaultWeek(today) ? {} : { week: target }, { replace: true });
  const sub =
    week === undefined
      ? ' '
      : `${dayLabel(week, { weekday: true })} – ${dayLabel(addDays(week, 6), { weekday: true })}${
          week === current
            ? ' · this week'
            : current && week === addDays(current, -7)
              ? ' · last week'
              : ''
        }`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Weekly review</h1>
          <p className="text-xs text-muted">{sub}</p>
        </div>
        {week && current && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => go(addDays(week, -7))} aria-label="Previous week">
              ←
            </Button>
            <Button
              size="sm"
              onClick={() => go(addDays(week, 7))}
              disabled={week >= current}
              aria-label="Next week"
            >
              →
            </Button>
            {week !== current && (
              <Button size="sm" variant="ghost" onClick={() => go(current)}>
                This week
              </Button>
            )}
          </div>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-xs text-critical">
          {reason(error, 'Could not load the week')}
        </p>
      ) : !view ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <WeekScreen key={view.week} view={view} dark={dark} />
      )}
    </div>
  );
}

function WeekScreen({ view, dark }: { view: WrapUpWeek; dark: boolean }) {
  const actions = useWrapUpActions();
  const [draft, setDraft] = useDraft(view.note);
  const [finishError, setFinishError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <WeekTotals view={view} />

      <Card title="Focused time per day" subtitle="Worked time, excluding breaks and discards">
        <Columns
          columns={view.days.map((d) => ({
            key: d.day,
            label: weekdayShort(d.day),
            seconds: d.focusSeconds,
            tooltip: (
              <>
                {dayLabel(d.day, { weekday: true })} · {span(d.focusSeconds)}
                {d.blocks > 0 && ` · ${plural(d.blocks, 'block')}`}
              </>
            ),
          }))}
          height={140}
          emptyText="No focus time logged this week."
          tableLabel="Day"
        />
      </Card>

      <Card title="Where the time went" subtitle="By project, biggest first">
        <BarsByName
          bars={view.byProject.map((p) => ({
            key: String(p.projectId ?? 'none'),
            name: p.name,
            color: seriesColor(p.color, dark),
            seconds: p.seconds,
            detail: `${p.share}%`,
          }))}
          emptyText="No focus time logged this week."
        />
      </Card>

      <Card
        title="Tasks you worked on"
        subtitle="Time this week, and what is logged against the estimate"
      >
        {view.tasks.length === 0 ? (
          <Empty>No block was spent on a task this week.</Empty>
        ) : (
          <ul className="space-y-2">
            {view.tasks.map((t) => (
              <WeekTaskRow key={t.id} task={t} dark={dark} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Completed this week" subtitle="Finished between Monday and Sunday">
        {view.completed.length === 0 ? (
          <Empty>Nothing was marked completed this week.</Empty>
        ) : (
          <ul className="space-y-2">
            {view.completed.map((t) => (
              <WeekTaskRow key={t.id} task={t} dark={dark} showCompletedOn />
            ))}
          </ul>
        )}
      </Card>

      {/* Carrying these into next week is the next thing to land: see UnfinishedFromWeek. */}
      <UnfinishedFromWeek tasks={view.unfinished} dark={dark} />

      <Card
        title="Next week's focus"
        subtitle="What should the week ahead be about? It is kept with this week's review."
      >
        <NoteField
          label="Next week's focus"
          placeholder="The one or two things that would make next week a good one"
          multiline
          draft={draft}
          onDraft={setDraft}
          saved={view.note}
          onSave={(note) => actions.saveWeekNote.mutateAsync({ week: view.week, note })}
        />
      </Card>

      <SummaryCard text={weekSummary(view, draft.trim() || null)} />

      <DoneBar
        button="Mark week reviewed"
        hint="Marks this week as reviewed. You can still change the note afterwards."
        doneWord="Reviewed"
        stamp={view.reviewedAt}
        pending={actions.finishWeek.isPending}
        error={finishError}
        onDone={() => {
          setFinishError(null);
          actions.finishWeek.mutate(view.week, {
            onError: (err) => setFinishError(reason(err, 'Could not mark the week reviewed')),
          });
        }}
      />
    </div>
  );
}

function WeekTotals({ view }: { view: WrapUpWeek }) {
  return (
    <Card>
      <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <Hero
          label="Focused time"
          value={span(view.focusSeconds)}
          detail={`${plural(view.blocks, 'block')} across ${plural(view.activeDays, 'day')}`}
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile
            label="Avg focus"
            value={view.avgFocusRating != null ? `${view.avgFocusRating}/5` : '—'}
            detail="self-rated blocks"
          />
          <StatTile
            label="Per active day"
            value={span(view.activeDays ? Math.round(view.focusSeconds / view.activeDays) : 0)}
            detail="average"
          />
          <StatTile label="Completed" value={view.completed.length} detail="tasks" />
        </div>
      </div>
    </Card>
  );
}

/** A task on the week's pages: what it is, what went into it, and where it stands. */
function WeekTaskRow({
  task,
  dark,
  showCompletedOn = false,
  trailing,
}: {
  task: WrapUpWeekTask;
  dark: boolean;
  showCompletedOn?: boolean;
  /** Something to the left of the status, such as a button for this one task. */
  trailing?: ReactNode;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border
        border-hairline bg-raised px-3 py-2.5"
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="break-words text-sm font-medium text-ink">{task.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <Swatch color={seriesColor(task.projectColor, dark)} />
            {task.projectName ?? 'No project'}
          </span>
          {task.secondsThisWeek > 0 && (
            <span className="tabular text-ink-2">{span(task.secondsThisWeek)} this week</span>
          )}
          <span className="tabular">{loggedText(task.loggedSeconds, task.estimatedMinutes)}</span>
          {showCompletedOn && task.completedOn && (
            <span className="tabular">
              Completed {dayLabel(task.completedOn, { weekday: true })}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {trailing}
        <StatusPill status={task.status} />
      </div>
    </li>
  );
}

/**
 * The tasks from this week's sheet that are still open: what a carry-over is about.
 *
 * Carrying them into next week is not built yet, and this is where it goes. The list
 * already takes a button for each task (`renderCarryOver`, drawn at the end of the row)
 * and one for the whole list (`carryAll`, drawn in the card's header); give it either
 * and it is shown, leave them out and nothing is.
 */
export function UnfinishedFromWeek({
  tasks,
  dark,
  renderCarryOver,
  carryAll,
}: {
  tasks: WrapUpWeekTask[];
  dark: boolean;
  renderCarryOver?: (task: WrapUpWeekTask) => ReactNode;
  carryAll?: ReactNode;
}) {
  return (
    <Card
      title="Unfinished from this week"
      subtitle="Still open from this week's sheet"
      action={carryAll}
    >
      {tasks.length === 0 ? (
        <Empty>Nothing from this week is left open.</Empty>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <WeekTaskRow key={t.id} task={t} dark={dark} trailing={renderCarryOver?.(t)} />
          ))}
        </ul>
      )}
    </Card>
  );
}
