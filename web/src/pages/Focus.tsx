import { useEffect, useState } from 'react';
import type { PlanItem, SavedTimer, Session } from '../api';
import { DayBar } from '../components/DayBar';
import { EntryRow } from '../components/EntryRow';
import { SavedTimers } from '../components/SavedTimers';
import { DurationPicker, ProjectPicker, RatingPicker } from '../components/pickers';
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
  const { data: settings } = useSettings();
  const { data: timers = [] } = useTimers();
  const actions = useSessionActions();
  const timerActions = useTimerActions();
  const [finishing, setFinishing] = useState(false);

  const defaultMinutes = Number(settings?.focus_minutes ?? 45);

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
                onStart={(timer: SavedTimer) =>
                  actions.start.mutate({
                    projectId: timer.projectId,
                    title: timer.title,
                    plannedMinutes: timer.plannedMinutes ?? defaultMinutes,
                  })
                }
                onPin={(timer: SavedTimer) =>
                  timerActions.save.mutate({
                    projectId: timer.projectId,
                    title: timer.title,
                    plannedMinutes: timer.plannedMinutes,
                  })
                }
                onUnpin={(id: number) => timerActions.unsave.mutate(id)}
              />
            </Card>
            <StartBlock
              projects={projects}
              defaultMinutes={defaultMinutes}
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
            onStart={(item) =>
              actions.start.mutate({
                projectId: item.projectId,
                title: item.title,
                plannedMinutes: item.plannedMinutes,
                planItemId: item.id,
              })
            }
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
  dark,
  pending,
  error,
  onStart,
}: {
  projects: { id: number; name: string; color: string }[];
  defaultMinutes: number;
  dark: boolean;
  pending: boolean;
  error?: string;
  onStart: (input: {
    projectId: number | null;
    title: string;
    intent: string | null;
    plannedMinutes: number;
  }) => void;
}) {
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.id ?? null);
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [minutes, setMinutes] = useState(defaultMinutes);

  useEffect(() => setMinutes(defaultMinutes), [defaultMinutes]);
  useEffect(() => {
    if (projectId === null && projects.length) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const canStart = title.trim().length > 0 && !pending;

  return (
    <Card title="Start a block" subtitle="One thing at a time. Name it now, rate it after.">
      <div className="space-y-4">
        <Field label="What are you working on?">
          <input
            className={inputClass}
            placeholder="e.g. Competitor RCM dashboard teardown"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart) {
                requestNotificationPermission();
                onStart({
                  projectId,
                  title: title.trim(),
                  intent: intent.trim() || null,
                  plannedMinutes: minutes,
                });
              }
            }}
          />
        </Field>

        <Field label="Project">
          <ProjectPicker
            projects={projects as never}
            value={projectId}
            onChange={setProjectId}
            dark={dark}
          />
        </Field>

        <Field label="Length">
          <DurationPicker value={minutes} onChange={setMinutes} />
        </Field>

        <Field label="Intent (optional)" hint="What does done look like? Useful when you review.">
          <input
            className={inputClass}
            placeholder="e.g. see how they lay out AR aging"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
          />
        </Field>

        {error && <p className="text-xs text-critical">{error}</p>}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canStart}
          onClick={() => {
            requestNotificationPermission();
            onStart({
              projectId,
              title: title.trim(),
              intent: intent.trim() || null,
              plannedMinutes: minutes,
            });
          }}
        >
          Start {minutes}-minute block
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
          paused={session.status === 'paused'}
          color={color}
        />

        <dl className="flex gap-6 text-center text-xs">
          <div>
            <dt className="text-muted">Worked</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">{clock(live.elapsedSeconds)}</dd>
          </div>
          <div>
            <dt className="text-muted">Planned</dt>
            <dd className="tabular mt-0.5 text-sm text-ink">{session.plannedMinutes}m</dd>
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
          <Button onClick={() => actions.extend.mutate({ id: session.id, minutes: 5 })}>
            +5 min
          </Button>
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

        {live.overrunSeconds > 0 && (
          <p className="text-xs text-warning">
            {duration(live.overrunSeconds)} past the planned {session.plannedMinutes}m — still
            counting.
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

  useEffect(() => {
    if (open) {
      setTitle(session.title);
      setRating(null);
      setNotes('');
      setTrim(false);
    }
  }, [open, session.title]);

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
  const looksUnattended = elapsedSeconds > session.plannedSeconds * 2;

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

        <Field label="Focus level" hint="Press 1–5.">
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
                That's more than double the planned block. Trim it to{' '}
                {session.plannedMinutes}m instead?
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
                ...(trim ? { activeSeconds: session.plannedSeconds } : {}),
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
  onStart,
}: {
  plan: PlanItem[];
  dark: boolean;
  disabled: boolean;
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
            disabled={disabled}
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
