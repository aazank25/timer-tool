import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  type Project,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from '../api';
import { ProjectPicker } from '../components/pickers';
import { Button, Card, Empty, Field, inputBase, inputClass, Modal, Swatch } from '../components/ui';
import {
  keys,
  useLiveSession,
  useProjects,
  useSessionActions,
  useSettings,
  useTaskActions,
  useTasks,
  useToday,
} from '../hooks';
import { dayLabel, duration, todayKey } from '../lib/format';
import { seriesColor } from '../lib/palette';

type View = 'open' | 'completed' | 'all';
type GroupBy = 'week' | 'project' | 'status';

const VIEWS: { value: View; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'week', label: 'Week added' },
  { value: 'project', label: 'Project' },
  { value: 'status', label: 'Status' },
];

/** In the order a task moves through them, which is also the order of the status groups. */
const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'held_up', label: 'Held up' },
  { value: 'completed', label: 'Completed' },
];

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskStatus,
  string
>;
const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label])) as Record<
  TaskPriority,
  string
>;

/**
 * Each status is tinted from the app's own tokens, and always carries its text
 * label: the tint helps you scan a column, it never says anything alone. The
 * text stays ink so it keeps its contrast on every tint, in both themes.
 */
const STATUS_TONE: Record<TaskStatus, string> = {
  not_started: 'border-hairline bg-raised text-ink-2',
  in_progress: 'border-accent/40 bg-accent/10 text-ink',
  held_up: 'border-warning/50 bg-warning/15 text-ink',
  completed: 'border-good/40 bg-good/10 text-ink',
};

/**
 * What went wrong, in words. A refused request only says "Invalid request", so the
 * first field the server named is added to it, or you could not tell which one.
 */
function reason(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const fields =
    err instanceof ApiError
      ? (err.details as { fieldErrors?: Record<string, string[]> })?.fieldErrors
      : undefined;
  const first = Object.entries(fields ?? {})[0];
  return first ? `${err.message} (${first[0]}: ${first[1]?.[0] ?? 'not allowed'})` : err.message;
}

/** 90 -> "1.5h", 120 -> "2h", 100 -> "1.67h": two decimals at most, no trailing zeros. */
const hoursText = (minutes: number) => String(Number((minutes / 60).toFixed(2)));

interface Group {
  key: string;
  label: string;
  color: string | null;
  tasks: Task[];
}

function groupOf(task: Task, by: GroupBy, thisYear: string): Omit<Group, 'tasks'> {
  if (by === 'week') {
    const year = task.weekOf.slice(0, 4);
    const label = `Week of ${dayLabel(task.weekOf)}${year === thisYear ? '' : `, ${year}`}`;
    return { key: task.weekOf, label, color: null };
  }
  if (by === 'project') {
    return {
      key: String(task.projectId ?? 'none'),
      label: task.projectName ?? 'No project',
      color: task.projectId == null ? null : task.projectColor,
    };
  }
  return { key: task.status, label: STATUS_LABEL[task.status], color: null };
}

/**
 * The server already lists the newest week first, so the weeks come out in that
 * order as they are met. Projects go by name with "No project" last, and
 * statuses in the order a task moves through them.
 */
function groupTasks(tasks: Task[], by: GroupBy, thisYear: string): Group[] {
  const groups = new Map<string, Group>();
  for (const task of tasks) {
    const head = groupOf(task, by, thisYear);
    const group = groups.get(head.key) ?? { ...head, tasks: [] };
    group.tasks.push(task);
    groups.set(head.key, group);
  }
  const list = [...groups.values()];
  if (by === 'project') {
    const rank = (g: Group) => (g.key === 'none' ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }
  if (by === 'status') {
    const rank = (g: Group) => STATUSES.findIndex((s) => s.value === g.key);
    list.sort((a, b) => rank(a) - rank(b));
  }
  return list;
}

export function TasksPage({ dark }: { dark: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('open');
  const [projectFilter, setProjectFilter] = useState<'all' | 'none' | number>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('week');
  const [editing, setEditing] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: projects = [] } = useProjects(true);
  const { data: todayInfo } = useToday();
  const live = useLiveSession();
  const {
    data: tasks,
    isPending,
    error: loadError,
  } = useTasks(
    {
      view,
      projectId: projectFilter === 'all' ? undefined : projectFilter,
    },
    // The Logged column counts the block on the clock, so it is re-read while one runs.
    { poll: live.isRunning },
  );
  // Only to tell "no tasks yet" from "nothing matches these filters": no logged time is shown
  // from it, so it is not polled.
  const { data: everyTask } = useTasks({ view: 'all' });
  const { isPending: settingsPending } = useSettings();
  const { start } = useSessionActions();
  const taskActions = useTaskActions();

  const activeProjects = projects.filter((p) => !p.archived);
  const thisYear = (todayInfo?.today ?? todayKey()).slice(0, 4);
  const groups = groupTasks(tasks ?? [], groupBy, thisYear);

  // Why a block cannot be started from here right now, or null when it can. The
  // server picks the mode and length from the settings, so those have to be in.
  const startBlockedReason = live.session
    ? 'Finish the block you are on first'
    : live.isLoading || settingsPending
      ? 'Loading your timer defaults…'
      : start.isPending
        ? 'Starting…'
        : null;

  function changeStatus(task: Task, status: TaskStatus) {
    setError(null);
    taskActions.update.mutate(
      { id: task.id, status },
      { onError: (err) => setError(reason(err, 'Could not change the status')) },
    );
  }

  async function startBlock(task: Task) {
    setError(null);
    try {
      // No mode, length or estimate: the server's default timer applies, and
      // the task's own estimate is total effort, not this block's.
      const session = await start.mutateAsync({ title: task.title, taskId: task.id });
      // The page is about to change, so hand it the new block rather than let
      // the Focus screen show "start a block" until the poll catches up.
      qc.setQueryData(keys.active, { session });
      navigate('/');
    } catch (err) {
      setError(reason(err, 'Could not start the block'));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Tasks</h1>
        <p className="text-xs text-muted">
          What needs doing, week by week. Start a block on a task and its time counts against the
          estimate.
        </p>
      </div>

      <QuickAdd projects={activeProjects} dark={dark} />

      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <Field label="Show" group>
          <Chips value={view} options={VIEWS} onChange={setView} />
        </Field>
        <Field label="Project">
          <select
            className={`${inputBase} w-52`}
            value={String(projectFilter)}
            onChange={(e) => {
              const v = e.target.value;
              setProjectFilter(v === 'all' || v === 'none' ? v : Number(v));
            }}
          >
            <option value="all">All projects</option>
            <option value="none">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Group by" group>
          <Chips value={groupBy} options={GROUPS} onChange={setGroupBy} />
        </Field>
      </div>

      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}

      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : loadError ? (
        <p role="alert" className="text-xs text-critical">
          {loadError.message}
        </p>
      ) : groups.length === 0 ? (
        // Until the total is known it is not yet clear which of the two empty states this is.
        everyTask === undefined ? null : everyTask.length === 0 ? (
          <Empty>No tasks yet. Add the first one above — start a block on it any time.</Empty>
        ) : (
          <div className="space-y-2">
            <Empty>No tasks match these filters.</Empty>
            {(view !== 'all' || projectFilter !== 'all') && (
              <div className="text-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setView('all');
                    setProjectFilter('all');
                  }}
                >
                  Show all tasks
                </Button>
              </div>
            )}
          </div>
        )
      ) : (
        groups.map((group) => (
          <TaskGroup
            key={group.key}
            group={group}
            dark={dark}
            startBlockedReason={startBlockedReason}
            onOpen={setEditing}
            onStatus={changeStatus}
            onStart={(task) => void startBlock(task)}
          />
        ))
      )}

      {editing && (
        <TaskDialog
          key={editing.id}
          task={editing}
          projects={projects}
          dark={dark}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** A row of buttons that picks one of a few options, like the timer-mode picker. */
function Chips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={value === o.value ? 'primary' : 'default'}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- quick add */

function QuickAdd({ projects, dark }: { projects: Project[]; dark: boolean }) {
  const { create } = useTaskActions();
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  async function add() {
    const trimmed = title.trim();
    if (!trimmed || create.isPending) return;
    setError(null);
    try {
      await create.mutateAsync({ title: trimmed, projectId, priority });
      // The project and priority stay: a run of tasks is usually for the same project.
      setTitle('');
      titleRef.current?.focus();
    } catch (err) {
      setError(reason(err, 'Could not add the task'));
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={titleRef}
          className={`${inputBase} min-w-48 flex-1`}
          placeholder="Add a task — what needs doing?"
          aria-label="New task"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <div className="w-full sm:w-60">
          <ProjectPicker
            projects={projects}
            value={projectId}
            onChange={setProjectId}
            dark={dark}
            ariaLabel="Project for the new task"
          />
        </div>
        <select
          className={`${inputBase} w-28`}
          aria-label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          onClick={() => void add()}
          disabled={!title.trim() || create.isPending}
        >
          Add
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-critical">{error}</p>}
    </Card>
  );
}

/* --------------------------------------------------------------------- list */

function TaskGroup({
  group,
  dark,
  startBlockedReason,
  onOpen,
  onStatus,
  onStart,
}: {
  group: Group;
  dark: boolean;
  startBlockedReason: string | null;
  onOpen: (task: Task) => void;
  onStatus: (task: Task, status: TaskStatus) => void;
  onStart: (task: Task) => void;
}) {
  const headingId = useId();
  const n = group.tasks.length;
  return (
    <Card
      title={
        <span id={headingId} className="flex items-center gap-1.5">
          {group.color && <Swatch color={seriesColor(group.color, dark)} />}
          {/* A bare text node in a flex row cannot shrink below its longest word. */}
          <span className="min-w-0 break-words">{group.label}</span>
        </span>
      }
      subtitle={`${n} task${n === 1 ? '' : 's'}`}
    >
      {/*
        The table scrolls inside its own box, so a narrow screen never scrolls the page.
        The box is positioned so it also clips the screen-reader-only header, which is
        absolutely placed: left unclipped it sits past the right edge and widens the page.
      */}
      <div className="relative overflow-x-auto">
        {/* Fixed columns, so the weeks and projects stacked on the page line up with each other. */}
        <table
          aria-labelledby={headingId}
          className="w-full min-w-[57rem] table-fixed border-collapse text-left text-xs"
        >
          <colgroup>
            <col />
            <col className="w-36" />
            <col className="w-20" />
            <col className="w-32" />
            <col className="w-32" />
            <col className="w-16" />
            <col className="w-32" />
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th scope="col" className="pb-1.5 pr-3 font-medium">
                Task
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">
                Project
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">
                Priority
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">
                Status
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">
                Target
              </th>
              <th scope="col" className="pb-1.5 pr-3 text-right font-medium">
                Est.
              </th>
              <th scope="col" className="pb-1.5 pr-3 text-right font-medium">
                Logged
              </th>
              <th scope="col" className="pb-1.5">
                <span className="sr-only">Start</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                dark={dark}
                startBlockedReason={startBlockedReason}
                onOpen={onOpen}
                onStatus={onStatus}
                onStart={onStart}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TaskRow({
  task,
  dark,
  startBlockedReason,
  onOpen,
  onStatus,
  onStart,
}: {
  task: Task;
  dark: boolean;
  startBlockedReason: string | null;
  onOpen: (task: Task) => void;
  onStatus: (task: Task, status: TaskStatus) => void;
  onStart: (task: Task) => void;
}) {
  const done = task.status === 'completed';
  const cell = 'py-2 pr-3 align-middle';
  return (
    <tr className={`border-t border-hairline ${done ? 'text-muted' : 'text-ink'}`}>
      <td className={cell}>
        <div className="flex items-start gap-1.5">
          {done && (
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="mt-0.5 size-3.5 shrink-0 text-good"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m3 8.5 3.2 3.2L13 4.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <button
            type="button"
            onClick={() => onOpen(task)}
            className={`min-w-0 break-words text-left text-sm hover:underline
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                done ? 'text-muted line-through' : 'font-medium text-ink'
              }`}
          >
            {task.title}
          </button>
        </div>
      </td>
      <td className={`${cell} overflow-hidden`}>
        {task.projectId == null ? (
          <span className="text-muted">No project</span>
        ) : (
          <span className="flex items-center gap-1.5" title={task.projectName ?? undefined}>
            <Swatch color={seriesColor(task.projectColor, dark)} />
            <span className="truncate">{task.projectName}</span>
          </span>
        )}
      </td>
      <td className={cell}>
        <PriorityPill priority={task.priority} />
      </td>
      <td className={cell}>
        <StatusSelect task={task} onChange={(status) => onStatus(task, status)} />
      </td>
      <td className={`${cell} tabular whitespace-nowrap`}>
        {task.targetDate == null ? (
          '—'
        ) : task.overdue ? (
          // The word carries it; the colour only backs it up.
          <span className="font-medium text-critical">{dayLabel(task.targetDate)} · overdue</span>
        ) : (
          dayLabel(task.targetDate)
        )}
      </td>
      <td className={`${cell} tabular whitespace-nowrap text-right`}>
        {task.estimatedMinutes == null ? '—' : `${hoursText(task.estimatedMinutes)}h`}
      </td>
      <td
        className={`${cell} tabular whitespace-nowrap text-right`}
        title={`${task.blockCount} block${task.blockCount === 1 ? '' : 's'}`}
      >
        {duration(task.loggedSeconds)}
        {task.estimatedMinutes != null && ` / ${hoursText(task.estimatedMinutes)}h`}
      </td>
      <td className="py-2 align-middle">
        <button
          type="button"
          aria-label={`Start a block on ${task.title}`}
          title={startBlockedReason ?? `Start a block on "${task.title}"`}
          disabled={startBlockedReason != null}
          onClick={() => onStart(task)}
          className="grid size-7 place-items-center rounded-full border border-hairline bg-raised
            text-[10px] text-ink transition-colors hover:border-accent hover:text-accent
            disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline
            disabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent"
        >
          <span aria-hidden="true">▶</span>
        </button>
      </td>
    </tr>
  );
}

/** High is solid, medium is outlined, low is plain text: the label is always there. */
function PriorityPill({ priority }: { priority: TaskPriority }) {
  const label = PRIORITY_LABEL[priority];
  if (priority === 'low') return <span className="text-[11px] text-muted">{label}</span>;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
        priority === 'high' ? 'bg-ink text-plane' : 'border border-ink/40 text-ink'
      }`}
    >
      {label}
    </span>
  );
}

function StatusSelect({ task, onChange }: { task: Task; onChange: (status: TaskStatus) => void }) {
  return (
    <span className="relative inline-block">
      <select
        aria-label={`Status of ${task.title}`}
        value={task.status}
        onChange={(e) => onChange(e.target.value as TaskStatus)}
        className={`cursor-pointer appearance-none rounded-full border py-1 pl-2.5 pr-6 text-xs
          font-medium focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-accent ${STATUS_TONE[task.status]}`}
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-2 top-1/2 size-2.5 -translate-y-1/2 text-ink-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/* --------------------------------------------------------------- edit dialog */

function TaskDialog({
  task,
  projects,
  dark,
  onClose,
}: {
  task: Task;
  projects: Project[];
  dark: boolean;
  onClose: () => void;
}) {
  const { update, remove } = useTaskActions();
  const [title, setTitle] = useState(task.title);
  const [projectId, setProjectId] = useState(task.projectId);
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [hours, setHours] = useState(
    task.estimatedMinutes == null ? '' : hoursText(task.estimatedMinutes),
  );
  const [addedOn, setAddedOn] = useState(task.addedOn);
  const [startDate, setStartDate] = useState(task.startDate ?? '');
  const [targetDate, setTargetDate] = useState(task.targetDate ?? '');
  const [completedOn, setCompletedOn] = useState(task.completedOn ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [results, setResults] = useState(task.results ?? '');
  const [error, setError] = useState<string | null>(null);

  // A task on an archived project still has to show that project, and keep it.
  const choices = projects.filter((p) => !p.archived || p.id === task.projectId);

  async function save() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('A task needs a title');
      return;
    }
    if (!addedOn) {
      setError('A task needs the day it was added');
      return;
    }
    // Empty means no estimate. The field is in hours and the server stores minutes.
    const minutes = hours.trim() === '' ? null : Math.round(Number(hours) * 60);
    if (minutes != null && !(minutes >= 1 && minutes <= 6000)) {
      setError('The estimate has to be between a minute and 100 hours');
      return;
    }

    // Only what was edited is sent. Dates are the reason: a date field left alone
    // must not be sent as blank, or it would stop the status change on the same
    // save from stamping today's date, as it does from the status menu in the list.
    const patch: TaskInput = {};
    if (trimmed !== task.title) patch.title = trimmed;
    if (projectId !== task.projectId) patch.projectId = projectId;
    if (priority !== task.priority) patch.priority = priority;
    if (status !== task.status) patch.status = status;
    if (minutes !== task.estimatedMinutes) patch.estimatedMinutes = minutes;
    if (addedOn !== task.addedOn) patch.addedOn = addedOn;
    if (startDate !== (task.startDate ?? '')) patch.startDate = startDate || null;
    if (targetDate !== (task.targetDate ?? '')) patch.targetDate = targetDate || null;
    if (completedOn !== (task.completedOn ?? '')) patch.completedOn = completedOn || null;
    if (notes !== (task.notes ?? '')) patch.notes = notes.trim() || null;
    if (results !== (task.results ?? '')) patch.results = results.trim() || null;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: task.id, ...patch });
      onClose();
    } catch (err) {
      setError(reason(err, 'Could not save'));
    }
  }

  async function destroy() {
    if (!window.confirm(`Delete "${task.title}"? Blocks logged on it are kept.`)) return;
    try {
      await remove.mutateAsync(task.id);
      onClose();
    } catch (err) {
      setError(reason(err, 'Could not delete'));
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit task" width="max-w-xl">
      <div className="space-y-3">
        {/* Tall on a short screen, and the modal itself does not scroll: this does. */}
        <div className="max-h-[calc(100dvh-13rem)] space-y-3 overflow-y-auto">
          <Field label="Task">
            <input
              className={inputClass}
              value={title}
              data-autofocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </Field>

          <Field label="Project">
            <ProjectPicker
              projects={choices}
              value={projectId}
              onChange={setProjectId}
              dark={dark}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Priority">
              <select
                className={inputClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select
                className={inputClass}
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estimate (hours)" hint="Blank for none">
              <input
                type="number"
                min={0}
                max={100}
                step={0.25}
                className={inputClass}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Added on">
              <input
                type="date"
                className={inputClass}
                value={addedOn}
                onChange={(e) => setAddedOn(e.target.value)}
              />
            </Field>
            <Field label="Start date">
              <input
                type="date"
                className={inputClass}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field label="Target date">
              <input
                type="date"
                className={inputClass}
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </Field>
            <Field label="Completed on">
              <input
                type="date"
                className={inputClass}
                value={completedOn}
                onChange={(e) => setCompletedOn(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes / updates">
            <textarea
              className={`${inputClass} min-h-20 resize-y`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <Field label="Results">
            <textarea
              className={`${inputClass} min-h-20 resize-y`}
              value={results}
              onChange={(e) => setResults(e.target.value)}
            />
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-xs text-critical">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button variant="danger" onClick={() => void destroy()}>
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!title.trim()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
