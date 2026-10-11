import { useEffect, useRef, useState } from 'react';
import type { PlanItem, SavedTimer, Session, TimerMode } from '../api';
import { DayBar } from '../components/DayBar';
import { EntryRow } from '../components/EntryRow';
import { SavedTimers } from '../components/SavedTimers';
import {
  DurationPicker,
  EstimatePicker,
  ModePicker,
  ProjectPicker,
  RatingPicker,
} from '../components/pickers';
import { TimerRing } from '../components/TimerRing';
import { Button, Card, Empty, Field, inputClass, Modal, Swatch } from '../components/ui';
import {
  requestNotificationPermission,
  useBlockEndAlert,
  useDayStats,
  useLiveSession,
  usePlan,
  useProjects,
  useSessionActions,
  useSettings,
  useTimerActions,
  useTimers,
  useToday,
} from '../hooks';
import { clock, duration, timeOfDay } from '../lib/format';
import { seriesColor } from '../lib/palette';

export function FocusPage({ dark }: { dark: boolean }) {
  const live = useLiveSession();
  useBlockEndAlert(live);
  const { data: today } = useToday();
  const { data: projects = [] } = useProjects();
  const { data: plan = [] } = usePlan(today?.today);
  const { data: stats } = useDayStats(today?.today);
  const { data: settings, isPending: settingsPending } = useSettings();
  const { data: timers = [] } = useTimers();
  const actions = useSessionActions();
  const timerActions = useTimerActions();
  const [finishing, setFinishing] = useState(false);

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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        {live.session ? (
          <LiveBlock live={live} dark={dark} onFinish={() => setFinishing(true)} />
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
            onClose={() => setFinishing(false)}
            onComplete={(body) => {
              actions.complete.mutate({ id: live.session!.id, ...body });
              setFinishing(false);
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
  defaultMinutes,
  defaultMode,
  settingsReady,
  dark,
  pending,
  error,
  onStart,
}: {
  projects: { id: number; name: string; color: string }[];
  defaultMinutes: number;
  defaultMode: TimerMode;
  /** False until the settings have settled: the two defaults above are only a guess before then. */
  settingsReady: boolean;
  dark: boolean;
  pending: boolean;
  error?: string;
  onStart: (input: {
    projectId: number | null;
    title: string;
    intent: string | null;
    mode: TimerMode;
    plannedMinutes?: number;
    estimatedMinutes?: number | null;
  }) => void;
}) {
  // Undefined until the person picks: it follows the project worked on most
  // recently. Null is an explicit "No project" and has to stick, so nothing
  // may fill it back in.
  const [projectPick, setProjectPick] = useState<number | null | undefined>(undefined);
  const projectId = projectPick === undefined ? (projects[0]?.id ?? null) : projectPick;
  const [title, setTitle] = useState('');
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

  // One path for Enter and the button, so they can never send different things.
  function start() {
    // Only a pomodoro ever notifies, so a stopwatch has no reason to ask.
    if (!stopwatch) requestNotificationPermission();
    onStart({
      projectId,
      title: title.trim(),
      intent: intent.trim() || null,
      mode,
      ...(stopwatch ? { estimatedMinutes: estimate } : { plannedMinutes: minutes }),
    });
  }

  return (
    <Card title="Start a block" subtitle="One thing at a time. Name it now, rate it after.">
      <div className="space-y-4">
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
            projects={projects as never}
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
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs">
            <Swatch color={color} />
            <span className="text-ink-2">{session.projectName ?? 'No project'}</span>
          </div>
          <h1 className="mt-1.5 max-w-lg text-xl font-semibold text-ink">{session.title}</h1>
          {session.intent && <p className="mt-1 text-xs text-muted">{session.intent}</p>}
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

        <div className="flex flex-wrap items-center justify-center gap-2">
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
          <Button
            onClick={() => actions.interrupt.mutate(session.id)}
            title="Log a distraction without stopping the clock"
          >
            Got interrupted
          </Button>
          <Button variant="primary" onClick={onFinish}>
            Done
          </Button>
          <Button variant="danger" onClick={() => actions.abandon.mutate(session.id)}>
            Discard
          </Button>
        </div>

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
