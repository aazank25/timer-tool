import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  reason,
  type PlanItem,
  type SavedTimer,
  type Session,
  type TimerMode,
} from '../api';
import { DayBar } from '../components/DayBar';
import { EntryRow } from '../components/EntryRow';
import { InterruptionChooser } from '../components/InterruptionChooser';
import { SavedTimers } from '../components/SavedTimers';
import {
  DurationPicker,
  EstimatePicker,
  ModePicker,
  ProjectPicker,
  projectOf,
  RatingPicker,
  taskLabel,
  withPicked,
  type ProjectChoice,
} from '../components/pickers';
import { TimerRing } from '../components/TimerRing';
import { Button, Card, Empty, Field, inputClass, Modal, Swatch } from '../components/ui';
import {
  keys,
  requestNotificationPermission,
  useBlockEndAlert,
  useDayStats,
  useLiveSession,
  usePlan,
  useProjects,
  useSessionActions,
  useSettings,
  useTasks,
  useTimerActions,
  useTimers,
  useToday,
} from '../hooks';
import { useExpiring } from '../lib/expiring';
import { clock, duration, timeOfDay } from '../lib/format';
import { seriesColor } from '../lib/palette';

/** How long the note about a finish that was refused stays up. */
const NOTICE_MS = 8_000;
const NOT_ON_THE_CLOCK = 'That block is no longer on the clock';

/**
 * A block is told apart by its id and when it started, not by the id alone: the id of a block
 * that was deleted can be given to the next one.
 */
const identify = (s: Session) => ({ id: s.id, startedAt: s.startedAt });

export function FocusPage({ dark }: { dark: boolean }) {
  const live = useLiveSession();
  useBlockEndAlert(live);
  const { data: today } = useToday();
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const { data: plan = [] } = usePlan(today?.today);
  const { data: stats } = useDayStats(today?.today);
  const { data: settings, isPending: settingsPending } = useSettings();
  const { data: timers = [] } = useTimers();
  const actions = useSessionActions();
  const timerActions = useTimerActions();
  // The block the finish dialog is open for, and not just whether it is open: it is open only while
  // that block is the one on the clock. A flag that outlived the block would leave the dialog for
  // whichever came next, with its title and the notes typed in it written over, and "Log block"
  // would finish a block it was never opened for, or it would open by itself on the next one.
  const [finishingBlock, setFinishingBlock] = useState<ReturnType<typeof identify> | null>(null);
  const [notice, say, noticed] = useExpiring(NOTICE_MS);
  const finishing =
    !!live.session &&
    finishingBlock?.id === live.session.id &&
    finishingBlock.startedAt === live.session.startedAt;
  // The block it was open for has left the clock, finished or switched from somewhere else. The
  // dialog is not open any more, whatever it was on, and it is said why. Only the id and start
  // are read, so this does not run again on every tick.
  const liveId = live.session?.id;
  const liveStartedAt = live.session?.startedAt;
  useEffect(() => {
    if (!finishingBlock) return;
    if (finishingBlock.id === liveId && finishingBlock.startedAt === liveStartedAt) return;
    setFinishingBlock(null);
    say(NOT_ON_THE_CLOCK);
  }, [finishingBlock, liveId, liveStartedAt, say]);

  // A long-block prompt's "Finish block" arrives as /?finish=<the block it asks about>. The page
  // it was pressed on may be minutes old, so the block on the clock is read again first, and the
  // dialog opens only if that is this block and it is a focus block. Otherwise a banner for a block
  // that has since been finished, or switched away from, would open the dialog for whatever is on
  // the clock now, and "Log block" would finish the wrong one. A refusal says so.
  //
  // The parameter comes off the address at once, replacing the entry, and not when the block has
  // been read: pressed twice meanwhile, that would leave an entry with it behind, and Back would
  // land on it and open the dialog again. Only the newest ask is answered.
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const finishParam = params.get('finish');
  const lastAsked = useRef(0);
  useEffect(() => {
    if (finishParam === null) return;
    const asked = ++lastAsked.current;
    setParams(
      (now) => {
        const next = new URLSearchParams(now);
        next.delete('finish');
        return next;
      },
      { replace: true },
    );
    void (async () => {
      // A block's id is digits and nothing else; anything more is not one, and asks nothing.
      const wanted = /^\d+$/.test(finishParam) ? Number(finishParam) : null;
      let block: Session | null = null;
      let reached = true;
      if (wanted !== null) {
        try {
          block = (
            await qc.fetchQuery({ queryKey: keys.active, queryFn: api.activeSession, staleTime: 0 })
          ).session;
        } catch {
          reached = false;
        }
      }
      if (asked !== lastAsked.current) return;
      if (block && block.kind === 'focus' && block.id === wanted) {
        setFinishingBlock(identify(block));
      } else {
        say(reached ? NOT_ON_THE_CLOCK : "Couldn't reach FocusDesk. Try again.");
      }
    })();
  }, [finishParam, qc, setParams, say]);

  const defaultMinutes = Number(settings?.focus_minutes ?? 45);
  const defaultMode: TimerMode =
    settings?.default_timer_mode === 'pomodoro' ? 'pomodoro' : 'stopwatch';
  // Every way of starting a block picks a mode and a length, and the defaults
  // for both live in the settings. Until those arrive any start is a guess, so
  // all of them wait. If the request fails the factory defaults stand in, so a
  // broken settings endpoint cannot lock the page out of starting anything.
  const settingsReady = !settingsPending;

  if (live.isLoading) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        {/* Said as well as shown. The one that is said is always there, out of the layout, so that
            what is put in it is announced; the one that is shown is not read a second time. */}
        <div role="status" className="sr-only">
          <span key={noticed}>{notice}</span>
        </div>
        {notice && (
          <p
            aria-hidden="true"
            className="rounded-lg border border-hairline bg-raised px-3 py-2 text-xs text-ink-2"
          >
            {notice}
          </p>
        )}
        {live.session ? (
          <LiveBlock
            live={live}
            dark={dark}
            onFinish={() => live.session && setFinishingBlock(identify(live.session))}
          />
        ) : (
          <>
            <Card
              title="Pick up where you left off"
              subtitle="One click starts it. The list builds itself from what you repeat."
            >
              <SavedTimers
                timers={timers.slice(0, 8)}
                dark={dark}
                disabled={!!live.session || actions.start.isPending}
                loading={!settingsReady}
                onStart={(timer: SavedTimer) =>
                  // Start it the way it was saved. Only a pomodoro has a length
                  // to fall back to; a stopwatch given one would stop being one.
                  actions.start.mutate({
                    projectId: timer.projectId,
                    title: timer.title,
                    mode: timer.mode,
                    ...(timer.mode === 'pomodoro'
                      ? { plannedMinutes: timer.plannedMinutes ?? defaultMinutes }
                      : {}),
                  })
                }
                onPin={(timer: SavedTimer) =>
                  timerActions.save.mutate({
                    projectId: timer.projectId,
                    title: timer.title,
                    plannedMinutes: timer.plannedMinutes,
                    mode: timer.mode,
                  })
                }
                onUnpin={(id: number) => timerActions.unsave.mutate(id)}
              />
            </Card>
            <StartBlock
              projects={projects}
              projectsLoaded={projectsLoaded}
              defaultMinutes={defaultMinutes}
              defaultMode={defaultMode}
              settingsReady={settingsReady}
              dark={dark}
              pending={actions.start.isPending}
              error={actions.start.error?.message}
              onStart={(input) => actions.start.mutate(input)}
            />
          </>
        )}

        {live.session && (
          <FinishDialog
            open={finishing}
            session={live.session}
            elapsedSeconds={live.elapsedSeconds}
            onClose={() => setFinishingBlock(null)}
            onComplete={(body) => {
              actions.complete.mutate({ id: live.session!.id, ...body });
              setFinishingBlock(null);
            }}
          />
        )}
      </div>

      <div className="space-y-4">
        <Card
          title="Today"
          subtitle={
            stats
              ? `${duration(stats.focusSeconds)} focused · ${stats.blocks} block${
                  stats.blocks === 1 ? '' : 's'
                }`
              : undefined
          }
        >
          {stats && stats.byProject.length > 0 ? (
            <>
              <DayBar
                slices={stats.byProject}
                dark={dark}
                targetSeconds={stats.targetMinutes * 60}
              />
              <ul className="mt-3 space-y-1.5 text-xs">
              {stats.byProject.slice(0, 5).map((p) => (
                <li key={p.projectId ?? 'none'} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Swatch color={seriesColor(p.color, dark)} />
                    <span className="truncate text-ink">{p.name}</span>
                  </span>
                  <span className="tabular shrink-0 text-ink-2">{duration(p.seconds)}</span>
                </li>
                ))}
              </ul>
            </>
          ) : (
            <Empty>Nothing logged yet today.</Empty>
          )}
        </Card>

        <Card title="Today's plan" subtitle="Click a line to start it">
          <PlanQuickStart
            plan={plan}
            dark={dark}
            disabled={!!live.session}
            loading={!settingsReady}
            onStart={(item) => {
              const base = { projectId: item.projectId, title: item.title, planItemId: item.id };
              // The plan's length is a guess when the default is a stopwatch.
              actions.start.mutate(
                defaultMode === 'stopwatch'
                  ? { ...base, mode: 'stopwatch', estimatedMinutes: item.plannedMinutes }
                  : { ...base, mode: 'pomodoro', plannedMinutes: item.plannedMinutes },
              );
            }}
          />
        </Card>

        <RecentBlocks sessions={stats?.sessions ?? []} dark={dark} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ start a block */

function StartBlock({
  projects,
  projectsLoaded,
  defaultMinutes,
  defaultMode,
  settingsReady,
  dark,
  pending,
  error,
  onStart,
}: {
  /** The live projects only: the first is the default, the one worked on most recently. */
  projects: ProjectChoice[];
  /** Whether that list has arrived: until it has, a project missing from it is not known to be archived. */
  projectsLoaded: boolean;
  defaultMinutes: number;
  defaultMode: TimerMode;
  /** False until the settings have settled: the two defaults above are only a guess before then. */
  settingsReady: boolean;
  dark: boolean;
  pending: boolean;
  error?: string;
  onStart: (input: {
    projectId: number | null;
    taskId: number | null;
    title: string;
    intent: string | null;
    mode: TimerMode;
    plannedMinutes?: number;
    estimatedMinutes?: number | null;
  }) => void;
}) {
  const { data: openTasks = [] } = useTasks({ view: 'open' });
  // The task this block is the work on. One that was finished elsewhere drops
  // out of the open list, and with it out of the form.
  const [taskPick, setTaskPick] = useState<number | null>(null);
  const task = openTasks.find((t) => t.id === taskPick) ?? null;
  // Undefined until a task sets it. Null is a task with no project, which is
  // not the same as no opinion, so it has to stick. Kept as the project itself and
  // not just its id: the task's project can be archived, which the list of live
  // projects does not know, and the picker has to be able to show it. Only a snapshot,
  // taken when the task was picked: the task itself is the better source while picked.
  const [taskProject, setTaskProject] = useState<ProjectChoice | null | undefined>(undefined);
  // Undefined until the person picks: it follows the task's project, and with
  // no task the project worked on most recently. Null is an explicit "No
  // project" and has to stick, so nothing may fill it back in.
  const [projectPick, setProjectPick] = useState<number | null | undefined>(undefined);
  const projectId =
    projectPick !== undefined
      ? projectPick
      : taskProject !== undefined
        ? (taskProject?.id ?? null)
        : (projects[0]?.id ?? null);
  // The live projects stay the list, and the default above is still taken from them.
  // The picked task's project is added to it for as long as the task is picked, whoever
  // chose the project: one picked by hand must not take the task's away. It is read off
  // the task as it is now, so a rename or a new colour shows. The snapshot is added too
  // while it is the project in use, which is all there is once no task is picked. So
  // the select never holds a project that it has no option for.
  const choices = withPicked(
    projects,
    projectsLoaded,
    task ? projectOf(task) : null,
    projectPick === undefined ? taskProject : null,
  );
  const [title, setTitle] = useState('');
  // The title a task last put in the box, kept to tell it from one the person wrote:
  // only a title that is still exactly this may be swapped when another task is picked.
  const [filledTitle, setFilledTitle] = useState<string | null>(null);
  const [intent, setIntent] = useState('');
  // Only what the person picked on this form is state. The mode and length are
  // read from the settings on every render, so a default that arrives late is
  // never copied in after the fact and never overwrites a pick.
  const [modeOverride, setModeOverride] = useState<TimerMode | null>(null);
  const [minutesOverride, setMinutesOverride] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const mode = modeOverride ?? defaultMode;
  const minutes = minutesOverride ?? defaultMinutes;

  // One gate for Enter and the button: nothing starts on a guessed default.
  const canStart = settingsReady && title.trim().length > 0 && !pending;
  const stopwatch = mode === 'stopwatch';

  // Choosing a task names the block after it, and files it under the task's project,
  // but only until a project has been picked. The name follows the task only while it
  // is not the person's own, that is empty or still exactly what the last task put
  // there: choosing another task swaps it, choosing none clears it, and a title typed
  // or edited by hand is never overwritten. Choosing none lets go of the link; the
  // project stays as it was.
  function pickTask(id: number | null) {
    setTaskPick(id);
    const picked = openTasks.find((t) => t.id === id);
    if (!title.trim() || title === filledTitle) {
      setTitle(picked?.title ?? '');
      setFilledTitle(picked?.title ?? null);
    }
    if (!picked) return;
    // A block on a task follows the task's project, archived or not, the same as when
    // it is started from the Tasks tab: that sends the task alone and the server files
    // the block under the task's project, so this has to agree with it.
    setTaskProject(projectOf(picked));
  }

  // One path for Enter and the button, so they can never send different things.
  function start() {
    // Only a pomodoro ever notifies, so a stopwatch has no reason to ask.
    if (!stopwatch) requestNotificationPermission();
    onStart({
      projectId,
      taskId: task?.id ?? null,
      title: title.trim(),
      intent: intent.trim() || null,
      mode,
      ...(stopwatch ? { estimatedMinutes: estimate } : { plannedMinutes: minutes }),
    });
  }

  return (
    <Card title="Start a block" subtitle="One thing at a time. Name it now, rate it after.">
      <div className="space-y-4">
        <Field
          label="Task (optional)"
          hint={openTasks.length ? undefined : 'No open tasks yet — add them on the Tasks tab.'}
        >
          <select
            className={inputClass}
            value={task?.id ?? ''}
            disabled={openTasks.length === 0}
            onChange={(e) => pickTask(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— none —</option>
            {openTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {taskLabel(t)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="What are you working on?">
          <input
            className={inputClass}
            placeholder="e.g. Draft the quarterly budget memo"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart) start();
            }}
          />
        </Field>

        <Field label="Project">
          <ProjectPicker
            projects={choices}
            value={projectId}
            onChange={setProjectPick}
            dark={dark}
          />
        </Field>

        {settingsReady ? (
          <>
            <Field label="Timer" group>
              <ModePicker value={mode} onChange={setModeOverride} />
            </Field>

            {stopwatch ? (
              <Field
                label="Estimate (optional)"
                hint="A guess, not a countdown. Review shows estimate against actual."
                group
              >
                <EstimatePicker value={estimate} onChange={setEstimate} />
              </Field>
            ) : (
              <Field label="Length" group>
                <DurationPicker value={minutes} onChange={setMinutesOverride} />
              </Field>
            )}
          </>
        ) : (
          // The default mode is unknown until the settings arrive, so neither can show as picked.
          <p className="text-xs text-muted">Loading your timer defaults…</p>
        )}

        <Field label="Intent (optional)" hint="What does done look like? Useful when you review.">
          <input
            className={inputClass}
            placeholder="e.g. outline done and intro written"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
          />
        </Field>

        {error && <p className="text-xs text-critical">{error}</p>}

        <Button variant="primary" size="lg" className="w-full" disabled={!canStart} onClick={start}>
          {!settingsReady ? 'Start' : stopwatch ? 'Start timer' : `Start ${minutes}-minute block`}
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- live block */

function LiveBlock({
  live,
  dark,
  onFinish,
}: {
  live: ReturnType<typeof useLiveSession>;
  dark: boolean;
  onFinish: () => void;
}) {
  const actions = useSessionActions();
  const session = live.session!;
  const color = seriesColor(session.projectColor, dark);
  const stopwatch = session.mode === 'stopwatch';
  const estimateSeconds = session.estimatedMinutes == null ? null : session.estimatedMinutes * 60;
  // The figure beside "Worked": the plan for a pomodoro, the guess for a stopwatch.
  const target = stopwatch ? session.estimatedMinutes : session.plannedMinutes;

  return (
    <Card>
      <div className="flex flex-col items-center gap-6 py-2">
        {/* Capped at the card: in a centred column a block is as wide as its longest word. */}
        <div className="max-w-full text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs">
            <Swatch color={color} />
            <span className="min-w-0 break-words text-ink-2">
              {session.projectName ?? 'No project'}
            </span>
          </div>
          <h1 className="mt-1.5 max-w-lg break-words text-xl font-semibold text-ink">
            {session.title}
          </h1>
          {session.intent && (
            <p className="mt-1 break-words text-xs text-muted">{session.intent}</p>
          )}
        </div>

        <TimerRing
          elapsedSeconds={live.elapsedSeconds}
          plannedSeconds={session.plannedSeconds}
          estimatedSeconds={estimateSeconds}
          paused={session.status === 'paused'}
          color={color}
        />

        <dl className="flex gap-6 text-center text-xs">
          <div>
            <dt className="text-muted">Worked</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">{clock(live.elapsedSeconds)}</dd>
          </div>
          <div>
            <dt className="text-muted">{stopwatch ? 'Estimate' : 'Planned'}</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">
              {target != null ? `${target}m` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Started</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">{timeOfDay(session.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">Interruptions</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">{session.interruptions}</dd>
          </div>
        </dl>

        {/* Relative: the list of reasons under "Got interrupted" is placed against this row. */}
        <div className="relative flex flex-wrap items-center justify-center gap-2">
          {session.status === 'running' ? (
            <Button onClick={() => actions.pause.mutate(session.id)}>Pause</Button>
          ) : (
            <Button variant="primary" onClick={() => actions.resume.mutate(session.id)}>
              Resume
            </Button>
          )}
          {!stopwatch && (
            <Button onClick={() => actions.extend.mutate({ id: session.id, minutes: 5 })}>
              +5 min
            </Button>
          )}
          <InterruptionChooser
            askReason={session.kind === 'focus'}
            onChoose={(picked) => actions.interrupt.mutateAsync({ id: session.id, reason: picked })}
          />
          <Button variant="primary" onClick={onFinish}>
            Done
          </Button>
          <Button variant="danger" onClick={() => actions.abandon.mutate(session.id)}>
            Discard
          </Button>
        </div>
        {actions.interrupt.isError && (
          <p role="alert" className="text-xs text-critical">
            {reason(actions.interrupt.error, 'Could not log that interruption')}
          </p>
        )}

        {live.overrunSeconds != null && live.overrunSeconds > 0 && (
          <p className="text-xs text-warning">
            {duration(live.overrunSeconds)} past the planned {session.plannedMinutes}m — still
            counting.
          </p>
        )}
        {/* A stopwatch never runs "over", so an estimate is passed quietly, not flagged. */}
        {stopwatch && estimateSeconds != null && live.elapsedSeconds > estimateSeconds && (
          <p className="text-xs text-muted">
            {duration(live.elapsedSeconds - estimateSeconds)} past your {session.estimatedMinutes}m
            estimate
          </p>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ finish dialog */

function FinishDialog({
  open,
  session,
  elapsedSeconds,
  onClose,
  onComplete,
}: {
  open: boolean;
  session: Session;
  elapsedSeconds: number;
  onClose: () => void;
  onComplete: (body: {
    focusRating: number | null;
    notes: string | null;
    title: string;
    activeSeconds?: number;
  }) => void;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [title, setTitle] = useState(session.title);
  const [notes, setNotes] = useState('');
  const [trim, setTrim] = useState(false);
  const initialisedFor = useRef<number | null>(null);

  // Escape closes the dialog but this stays mounted, so reset only for a
  // different block — resetting on every open would wipe a half-written draft.
  useEffect(() => {
    if (!open || initialisedFor.current === session.id) return;
    initialisedFor.current = session.id;
    setTitle(session.title);
    setRating(null);
    setNotes('');
    setTrim(false);
  }, [open, session.id, session.title]);

  // The draft above survives a close; the trim box must not. It is a verdict on
  // the clock as it stood when the dialog opened, and "Keep working" says that
  // verdict was wrong. Left ticked, it would trim hours of later work down to
  // the plan. `open` is a plain boolean, so this does not re-run on the tick.
  useEffect(() => {
    if (open) setTrim(false);
  }, [open]);

  // Rate with the number keys; the dialog is the only thing focused.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key >= '1' && e.key <= '5') setRating(Number(e.key));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // A block that ran to twice its length usually means the timer was left on.
  // Its length is the plan for a pomodoro and the estimate for a stopwatch. A
  // stopwatch with no estimate has nothing to trim *to*, so it never offers one:
  // any figure would be invented, and trimming to it destroys the real time.
  const trimTo =
    session.plannedSeconds ?? (session.estimatedMinutes ? session.estimatedMinutes * 60 : null);
  const looksUnattended = trimTo != null && trimTo > 0 && elapsedSeconds > trimTo * 2;
  const trimMinutes = trimTo == null ? 0 : Math.round(trimTo / 60);
  const yardstick =
    session.plannedSeconds != null ? 'the planned block' : `your ${trimMinutes}m estimate`;

  return (
    <Modal open={open} onClose={onClose} title="How did that block go?">
      <div className="space-y-4">
        <Field
          label="What did you actually do?"
          hint="This is the line you'll read back later — make it specific."
        >
          <input
            className={inputClass}
            value={title}
            data-autofocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <Field label="Focus level" hint="Press 1–5." group>
          <RatingPicker value={rating} onChange={setRating} />
        </Field>

        <Field label="Notes (optional)">
          <textarea
            className={`${inputClass} min-h-20 resize-y`}
            placeholder="What you found, where you stopped, what's next"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="rounded-lg border border-hairline bg-raised px-3 py-2 text-xs text-ink-2">
          Logging <span className="tabular font-medium text-ink">{duration(elapsedSeconds)}</span>
          {session.interruptions > 0 && ` · ${session.interruptions} interruption(s)`}
          {looksUnattended && (
            <label className="mt-2 flex items-start gap-2 text-muted">
              <input
                type="checkbox"
                checked={trim}
                onChange={(e) => setTrim(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                That's more than double {yardstick}. Trim it to {trimMinutes}m instead?
              </span>
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Keep working
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onComplete({
                focusRating: rating,
                notes: notes.trim() || null,
                title: title.trim() || session.title,
                // Only while the offer is on screen, and never a zero or empty length.
                ...(trim && looksUnattended && trimTo ? { activeSeconds: trimTo } : {}),
              })
            }
          >
            Log block
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- side rail */

function PlanQuickStart({
  plan,
  dark,
  disabled,
  loading,
  onStart,
}: {
  plan: PlanItem[];
  dark: boolean;
  /** A block is already running. */
  disabled: boolean;
  /** Starting one branches on the default timer, so it waits for the settings. */
  loading: boolean;
  onStart: (item: PlanItem) => void;
}) {
  const open = plan.filter((p) => !p.done);
  if (!open.length) {
    return <Empty>No plan for today yet — add blocks on the Today tab.</Empty>;
  }
  return (
    <>
      {disabled && (
        <p className="mb-2 text-[11px] text-muted">
          Finish the block you're on to start one of these.
        </p>
      )}
      <ul className="space-y-1.5">
      {open.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            disabled={disabled || loading}
            onClick={() => onStart(item)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border
              border-hairline bg-raised px-2.5 py-2 text-left text-xs transition-colors
              hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Swatch color={seriesColor(item.projectColor, dark)} />
              <span className="truncate text-ink">{item.title}</span>
            </span>
            <span className="tabular shrink-0 text-muted">{item.plannedMinutes}m</span>
          </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function RecentBlocks({ sessions, dark }: { sessions: Session[]; dark: boolean }) {
  const done = sessions.filter((s) => s.status === 'completed').slice(0, 5);
  return (
    <Card title="Last few blocks">
      {done.length ? (
        <ul className="-mx-1 space-y-0.5">
          {done.map((s) => (
            <li key={s.id}>
              <EntryRow session={s} dark={dark} compact />
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Your first block of the day is still ahead of you.</Empty>
      )}
    </Card>
  );
}
