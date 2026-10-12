import { useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { useCarryOver } from '../insights';
import { addDays, dayLabel, timeOfDay } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { defaultWeek, realDay, weekStart } from '../lib/weeks';
import { daySummary, span, weekSummary } from '../lib/wrapupSummary';
import {
  useRefreshWhenTheClockChanges,
  useWrapUpActions,
  useWrapUpDay,
  useWrapUpWeek,
  wrapUpKeys,
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

/**
 * A page that could not be read, and the way to try again. Both pages wait on what the server
 * says before they read anything, and with no answer there is nothing else on the screen to
 * say it: a bare "Loading…" that never ends is worse than the error.
 */
function LoadFailed({
  message,
  onRetry,
  pending,
}: {
  message: string;
  onRetry: () => void;
  pending: boolean;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="text-xs text-critical">{message}</p>
      <Button size="sm" disabled={pending} onClick={onRetry}>
        {pending ? 'Trying…' : 'Try again'}
      </Button>
    </div>
  );
}

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
  const todayQuery = useToday();
  const today = todayQuery.data?.today;
  // Nothing is read until the server has said which day it is: the browser's own date is
  // not the day the user is in when they are up past midnight.
  const day = realDay(params.get('day')) ?? today;
  const running = useActiveSession().data?.session?.status === 'running';
  useRefreshWhenTheClockChanges();
  const dayQuery = useWrapUpDay(day, { poll: running });
  const { data: view, error } = dayQuery;

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
        <LoadFailed
          message={reason(error, 'Could not load the day')}
          onRetry={() => void dayQuery.refetch()}
          pending={dayQuery.isFetching}
        />
      ) : !view ? (
        todayQuery.error && day === undefined ? (
          <LoadFailed
            message={reason(todayQuery.error, 'Could not find out which day it is')}
            onRetry={() => void todayQuery.refetch()}
            pending={todayQuery.isFetching}
          />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )
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
            {
              id: task.id,
              status,
              // Finished from the wrap-up of a day gone by, it was finished on that day: the
              // server stamps today unless it is told otherwise.
              completedOn: status === 'completed' && !isToday ? view.day : undefined,
            },
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
            // Two blocks can have the same title, and the names of their buttons would be the
            // same: the time it began at tells them apart, as it does in the block's own row.
            const started = timeOfDay(s.startedAt);
            return (
              <li key={s.id} className="rounded-xl border border-hairline bg-raised py-1 pr-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  {/* The block as the block log draws it, so it is known at a glance which one it is. */}
                  <div className="min-w-0 flex-1 basis-64">
                    <EntryRow session={s} dark={dark} showRating={false} />
                  </div>
                  <div
                    role="group"
                    aria-label={`Focus rating for ${s.title}, started ${started}`}
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
                        aria-label={`Rate "${s.title}" ${n} of 5, started ${started}`}
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
  const todayQuery = useToday();
  const today = todayQuery.data?.today;
  const requested = realDay(params.get('week'));
  const week = requested ? weekStart(requested) : today ? defaultWeek(today) : undefined;
  const current = today ? weekStart(today) : undefined;
  const running = useActiveSession().data?.session?.status === 'running';
  useRefreshWhenTheClockChanges();
  const weekQuery = useWrapUpWeek(week, { poll: running });
  const { data: view, error } = weekQuery;

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
        <LoadFailed
          message={reason(error, 'Could not load the week')}
          onRetry={() => void weekQuery.refetch()}
          pending={weekQuery.isFetching}
        />
      ) : !view ? (
        todayQuery.error && week === undefined ? (
          <LoadFailed
            message={reason(todayQuery.error, 'Could not find out which day it is')}
            onRetry={() => void todayQuery.refetch()}
            pending={todayQuery.isFetching}
          />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )
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

      <UnfinishedWithCarryOver view={view} dark={dark} />

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
 * Carrying them forward is `UnfinishedWithCarryOver`'s button, given to this card as `carryAll`
 * (drawn in its header) with what it says about it as `carryNote` (drawn under the list); with
 * neither the card only lists. It is one button for the lot and not one for each task, because
 * the carry-over is the Tasks tab's own action and moves every unfinished task together, and
 * because a button that moved a single task by changing its week would be filing it by hand,
 * which is not carrying it and takes off the mark that says it was. `renderCarryOver` is the
 * slot for a button on each row, which nothing fills for that reason.
 */
export function UnfinishedFromWeek({
  tasks,
  dark,
  renderCarryOver,
  carryAll,
  carryNote,
}: {
  tasks: WrapUpWeekTask[];
  dark: boolean;
  renderCarryOver?: (task: WrapUpWeekTask) => ReactNode;
  carryAll?: ReactNode;
  carryNote?: ReactNode;
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
      {carryNote}
    </Card>
  );
}

/**
 * The unfinished tasks of a week that is over, with the button that brings them into this one.
 * It is only there for a week before the current one: the current week has nothing behind it
 * to carry, and a week with none left open has nothing to offer. The button is the Tasks tab's
 * *Carry into this week* and does exactly what that does, which is more than this list: it
 * carries every unfinished task of every earlier week, so the hint under the list says so
 * rather than let the button promise only what is shown.
 *
 * What it did is said in words, to the screen and to a screen reader. The status is a live
 * region that is on the page before anything is said, and is kept when the button goes (once
 * they are carried there is nothing left to offer), or the announcement would go with it.
 */
function UnfinishedWithCarryOver({ view, dark }: { view: WrapUpWeek; dark: boolean }) {
  const qc = useQueryClient();
  const carryOver = useCarryOver();
  const hintId = useId();
  const today = useToday().data?.today;
  const [said, setSaid] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Whether a carry-over is on its way. The button is disabled while the mutation is pending, but
  // that only shows once React has drawn it again, and two clicks inside one task (a double click,
  // or a script) both get in before it: two requests, the second answered "Nothing was left to
  // carry", and that said in place of what the first one did.
  const carrying = useRef(false);

  // The week it would go into is the one the server is in, which turns over at the day-start hour.
  const thisWeek = today === undefined ? undefined : weekStart(today);
  const isPast = thisWeek !== undefined && view.week < thisWeek;
  const offered = isPast && view.unfinished.length > 0;

  async function carry() {
    if (carrying.current) return;
    carrying.current = true;
    setError(null);
    setSaid('');
    try {
      const { carried, weekOf } = await carryOver.mutateAsync();
      const into = `into the week of ${dayLabel(weekOf)}`;
      setSaid(
        carried === 0
          ? `Nothing was left to carry ${into}`
          : `Carried ${plural(carried, 'task')} ${into}`,
      );
      // The tasks sit in another week now, so what this page lists is out of date as well as the
      // Tasks tab, which useCarryOver has already told.
      void qc.invalidateQueries({ queryKey: wrapUpKeys.all });
    } catch (err) {
      setError(reason(err, 'Could not carry the tasks into this week'));
    } finally {
      carrying.current = false;
    }
  }

  return (
    <UnfinishedFromWeek
      tasks={view.unfinished}
      dark={dark}
      carryAll={
        offered ? (
          <Button
            size="sm"
            variant="primary"
            disabled={carryOver.isPending}
            aria-describedby={hintId}
            onClick={() => void carry()}
          >
            {carryOver.isPending ? 'Carrying…' : 'Carry into this week'}
          </Button>
        ) : undefined
      }
      carryNote={
        isPast ? (
          <>
            {offered && thisWeek !== undefined && (
              <p id={hintId} className="mt-3 text-[11px] text-muted">
                Moves every unfinished task from any earlier week, not only the ones listed here,
                into the current week (the week of {dayLabel(thisWeek)}), below what is already
                there.
              </p>
            )}
            {/* Out of sight and not out of the page while it is empty: a region that is not there
                until it has something to say is often not read out when it appears. */}
            <p role="status" className={said ? 'mt-3 text-xs text-good' : 'sr-only'}>
              {said}
            </p>
            {error && (
              <p role="alert" className="mt-3 text-xs text-critical">
                {error}
              </p>
            )}
          </>
        ) : undefined
      }
    />
  );
}
