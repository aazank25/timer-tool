import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  reason,
  type Project,
  type Task,
  type TaskInput,
  type TaskMove,
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
import { useCarryOver } from '../insights';
import { addDays, dayLabel, duration, todayKey } from '../lib/format';
import { seriesColor } from '../lib/palette';

type View = 'open' | 'completed' | 'all';
type GroupBy = 'week' | 'project' | 'status';

const VIEWS: { value: View; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

// "Week", not "week added": the week a task sits in is its own, and a task that was carried
// forward is in a later week than the one it was added in.
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'week', label: 'Week' },
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

/** 90 -> "1.5h", 120 -> "2h", 100 -> "1.67h": two decimals at most, no trailing zeros. */
const hoursText = (minutes: number) => String(Number((minutes / 60).toFixed(2)));

/** The Monday of the week a day is in: a Sunday belongs to the week before it, as on the server. */
function mondayOf(day: string): string {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(day, -dow);
}

/** "Oct 5, 2026": with the year, because a tooltip has no heading to say which one. */
const fullDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

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
  // What a screen reader is told after a move. The count makes a new node each time: the
  // same words said twice in a row would otherwise change nothing in the page, and so be
  // announced only once.
  const [announcement, setAnnouncement] = useState({ text: '', count: 0 });

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
  const carryOver = useCarryOver();

  const activeProjects = projects.filter((p) => !p.archived);
  const thisYear = (todayInfo?.today ?? todayKey()).slice(0, 4);
  const groups = groupTasks(tasks ?? [], groupBy, thisYear);

  // What the button below would carry: every task that is not done and sits in a week before
  // this one, whatever the list is cut to. Worked out from the server's today, which turns
  // the week over at the day-start hour, so nothing is said until that has arrived.
  const thisWeek = todayInfo ? mondayOf(todayInfo.today) : null;
  const behind =
    thisWeek == null
      ? 0
      : (everyTask ?? []).filter((t) => t.status !== 'completed' && t.weekOf < thisWeek).length;

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

  // True once the move is made and the list has been read again, false if it was refused.
  async function moveTask(task: Task, edge: Edge, anchor: Task): Promise<boolean> {
    setError(null);
    const to: TaskMove = edge === 'before' ? { before: anchor.id } : { after: anchor.id };
    try {
      await taskActions.move.mutateAsync({ id: task.id, to });
      // Where it went, and not only that it moved: it is somewhere else on the page now,
      // and a screen reader cannot see where.
      const where = edge === 'before' ? 'above' : 'below';
      setAnnouncement((a) => ({
        text: `Moved "${task.title}" ${where} "${anchor.title}"`,
        count: a.count + 1,
      }));
      return true;
    } catch (err) {
      setError(reason(err, 'Could not move the task'));
      return false;
    }
  }

  async function carryIntoThisWeek() {
    setError(null);
    try {
      // Settles once the lists have been read again, so the banner is gone by the time it does.
      const { carried } = await carryOver.mutateAsync();
      setAnnouncement((a) => ({
        text: `Carried ${carried} unfinished task${carried === 1 ? '' : 's'} into this week`,
        count: a.count + 1,
      }));
    } catch (err) {
      setError(reason(err, 'Could not carry the tasks into this week'));
    }
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
      {/* Says a move aloud. Taken out of the flow by sr-only, so it adds no space of its own. */}
      <div role="status" aria-live="polite" className="sr-only">
        <span key={announcement.count}>{announcement.text}</span>
      </div>

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

      {behind > 0 && (
        <CarryOverBanner
          count={behind}
          pending={carryOver.isPending}
          onCarry={() => void carryIntoThisWeek()}
        />
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
            // Only the weeks are the bands a task can be moved in: by project or status the
            // rows of a card are not one band, so there is nothing to drag within.
            reorderable={groupBy === 'week'}
            startBlockedReason={startBlockedReason}
            onOpen={setEditing}
            onStatus={changeStatus}
            onStart={(task) => void startBlock(task)}
            onMove={moveTask}
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

/* ------------------------------------------------------------ carry over banner */

/**
 * Unfinished tasks left behind in earlier weeks, and the one button that brings them into this
 * one. It says how many there are and what carrying does, so the button is not a surprise: they
 * go to the bottom of their priority in this week, in the order they had. It carries every one
 * of them, so the count is of every one, not of what the list below is cut to.
 */
function CarryOverBanner({
  count,
  pending,
  onCarry,
}: {
  count: number;
  pending: boolean;
  onCarry: () => void;
}) {
  return (
    <section
      aria-label="Unfinished tasks from earlier weeks"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border
        border-accent/40 bg-accent/10 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {count} unfinished task{count === 1 ? '' : 's'} from earlier weeks
        </p>
        <p className="mt-0.5 text-xs text-ink-2">
          Carrying them moves them into this week, below what is already there and in the order
          they had.
        </p>
      </div>
      <Button variant="primary" size="sm" disabled={pending} onClick={onCarry}>
        {pending ? 'Carrying…' : 'Carry into this week'}
      </Button>
    </section>
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

/** The side of a row a dragged task would be put on. */
type Edge = 'before' | 'after';

/**
 * What a drag carries, beside the task's id as plain text, when it is the drag of a row.
 * Nothing else has it, so the rows take nothing else that is dragged over them: a text
 * selection, a link, a file.
 */
const DRAG_TYPE = 'application/x-focusdesk-task';

/**
 * How long after a move was answered a new one is still turned away, when the page never
 * draws a new order for it to wait for (see `move`). Enough for it to draw the list just read.
 */
const SETTLE_MS = 100;

/** What a row needs to be moved by hand, handed down by the card it is in. */
interface RowReorder {
  /** Which side of this row a drop would land on right now, if one would. */
  edge: Edge | null;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLTableRowElement>) => void;
  onDragLeave: (e: DragEvent<HTMLTableRowElement>) => void;
  onDrop: (e: DragEvent<HTMLTableRowElement>) => void;
}

function TaskGroup({
  group,
  dark,
  reorderable,
  startBlockedReason,
  onOpen,
  onStatus,
  onStart,
  onMove,
}: {
  group: Group;
  dark: boolean;
  /** Whether the rows have a handle. Only when the card is one week of the list. */
  reorderable: boolean;
  startBlockedReason: string | null;
  onOpen: (task: Task) => void;
  onStatus: (task: Task, status: TaskStatus) => void;
  onStart: (task: Task) => void;
  /** Put the task on this side of the anchor. Resolves to whether that was done, once the list has been read again. */
  onMove: (task: Task, edge: Edge, anchor: Task) => Promise<boolean>;
}) {
  const headingId = useId();
  const n = group.tasks.length;
  const body = useRef<HTMLTableSectionElement>(null);

  // The id of the task whose handle is being dragged, and nothing else about it. A refetch
  // in the middle of a drag (the list is polled while a block runs) replaces every row with
  // a new object, so one kept from the start would not be found among them: the task is
  // looked up in the rows as they are when it is needed. A ref and not state: the page does
  // not draw from it, and dragover cannot read the drag's own data to find out what is
  // being dragged.
  const dragged = useRef<number | null>(null);
  // Where a drop would land, and so where the line is drawn.
  const [dropAt, setDropAt] = useState<{ id: number; edge: Edge } | null>(null);
  // A move that has been asked for and not yet drawn. Anything that would start another is
  // turned away until it has been: a key press is ignored and a drag does not start, and
  // nothing is queued, so two moves cannot be worked out from the same rows. A ref, so a
  // second key that arrives before the page has drawn the first sees it.
  const moving = useRef(false);
  // That move has been answered and the list read again, so its order is on its way to the
  // page and the next draw of the rows is the one to wait for.
  const answered = useRef(false);
  // The task a key moved and the handle that had focus when it did, for the focus to be
  // given back to the task's handle once the rows are in their new order, if it was drawn anew.
  const refocus = useRef<{ id: number; handle: HTMLElement } | null>(null);
  // Lets a move go when the page never draws an order for it.
  const fallback = useRef<number | undefined>(undefined);
  // The rows' ids in order, which is how a new order is told from the old, and the order
  // they were last drawn in.
  const order = group.tasks.map((t) => t.id).join(',');
  const drawn = useRef(order);

  /** The move is over: what it was waiting for has happened, or never will. */
  function release() {
    window.clearTimeout(fallback.current);
    moving.current = false;
    answered.current = false;
    refocus.current = null;
  }
  useEffect(() => () => window.clearTimeout(fallback.current), []);

  // The dragged task as it is among the rows now, or null when it is not among them.
  const draggedTask = () => group.tasks.find((t) => t.id === dragged.current) ?? null;

  // The order is what to watch for: once it has changed, the new one is on the page.
  useLayoutEffect(() => {
    drawn.current = order;
    // A drag whose task has left the card is over, whatever the browser says: when the
    // row it was taken by is gone, dragend goes to a node that is not on the page and
    // never gets here, and the drag would be taken up again by whatever is dragged next.
    if (dragged.current != null && draggedTask() == null) endDrag();

    // A row that changes place in the DOM can lose focus, and a move is exactly that. React
    // hands focus back to a node it has only moved, so a handle still on the page is left
    // alone: with focus on the body anyway, someone has clicked blank space while the list
    // was being read again, and giving it back would make their next arrow key move the row
    // once more. A handle drawn anew is a different node, and the old one with its focus is
    // gone: the new one is given it, but only when focus is nowhere. Anyone who has clicked
    // or tabbed on has chosen where it is, and taking it back would swallow what they type.
    const kept = refocus.current;
    const focus = document.activeElement;
    if (kept && !kept.handle.isConnected && (focus == null || focus === document.body)) {
      body.current?.querySelector<HTMLElement>(`[data-task-handle="${kept.id}"]`)?.focus();
    }
    // The rows are in the order the move made: the next one can be worked out from them.
    if (answered.current) release();
  }, [order]);

  async function move(task: Task, edge: Edge, anchor: Task, handle: HTMLElement | null) {
    if (moving.current) return;
    moving.current = true;
    answered.current = false;
    // The handle a key was pressed on: it is the one with focus to keep. A drop has none.
    if (handle) refocus.current = { id: task.id, handle };
    // The rows as they will be once it is drawn: the task is put on its side of the anchor.
    const rows = group.tasks.filter((t) => t.id !== task.id);
    rows.splice(rows.findIndex((t) => t.id === anchor.id) + (edge === 'after' ? 1 : 0), 0, task);
    const expected = rows.map((t) => t.id).join(',');
    const moved = await onMove(task, edge, anchor);
    answered.current = true;
    // Refused, so the rows are as they were, or already drawn in the order it makes (the
    // list can be read before the rest of the move settles): nothing is left to wait for.
    if (!moved || drawn.current === expected) {
      release();
      return;
    }
    // The list has been read again, but the page draws it a moment later, and the effect
    // above lets go when it has. It does not always draw a different order (the server may
    // have found the task already there, or the list could not be read again), and then
    // that never comes, so this lets go too.
    fallback.current = window.setTimeout(release, SETTLE_MS);
  }

  // The other rows of its priority in this card: the ones it can be put beside. Its week
  // is this card, and the server refuses any other.
  const sameBand = (task: Task) => group.tasks.filter((t) => t.priority === task.priority);

  /** Arrow up puts it before the row above it of its priority, arrow down after the one below. */
  function onHandleKey(task: Task, e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // With a modifier held the arrows belong to the browser or the screen reader.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // They would scroll the page as well as move the row.
    e.preventDefault();
    if (moving.current) return;
    const band = sameBand(task);
    const up = e.key === 'ArrowUp';
    const beside = band[band.findIndex((t) => t.id === task.id) + (up ? -1 : 1)];
    // Already first or last of its priority in the card.
    if (!beside) return;
    void move(task, up ? 'before' : 'after', beside, e.currentTarget);
  }

  function onHandleDragStart(task: Task, e: DragEvent<HTMLButtonElement>) {
    if (moving.current) {
      e.preventDefault();
      return;
    }
    dragged.current = task.id;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag without some data, and it has to be set here.
    e.dataTransfer.setData('text/plain', String(task.id));
    // What the rows know a drag of a row by: dragover can read the types, not the data.
    e.dataTransfer.setData(DRAG_TYPE, String(task.id));
    // What follows the pointer is the whole row, not the little handle it was taken by.
    const row = e.currentTarget.closest('tr');
    if (row) {
      const box = row.getBoundingClientRect();
      e.dataTransfer.setDragImage(row, e.clientX - box.left, e.clientY - box.top);
    }
  }

  function endDrag() {
    dragged.current = null;
    setDropAt(null);
  }

  /** The pointer's half of the row: the top half is before it, the bottom half after. */
  const edgeOf = (e: DragEvent<HTMLTableRowElement>): Edge => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? 'before' : 'after';
  };

  /**
   * Where the drag over a row would put the dragged task, or null when it would not go
   * there. It is a drag of a row from this card's handles, over another row of the same
   * priority, on a side that is a different place: directly below a row's own place is
   * before the one after it, and directly above is after the one before it, and both
   * leave the order as it is. There is no line at such a place, and a drop is refused.
   */
  function slot(
    e: DragEvent<HTMLTableRowElement>,
    target: Task,
  ): { from: Task; edge: Edge } | null {
    const from = draggedTask();
    if (!from || !e.dataTransfer.types.includes(DRAG_TYPE)) return null;
    if (from.id === target.id || from.priority !== target.priority) return null;
    const edge = edgeOf(e);
    const band = sameBand(from);
    const gap = band.findIndex((t) => t.id === target.id) - band.findIndex((t) => t.id === from.id);
    if ((edge === 'before' && gap === 1) || (edge === 'after' && gap === -1)) return null;
    return { from, edge };
  }

  function onRowDragOver(task: Task, e: DragEvent<HTMLTableRowElement>) {
    const to = slot(e, task);
    if (!to) {
      // Left alone, the browser refuses the drop. A line drawn from the other half of
      // this row is taken away.
      setDropAt((now) => (now?.id === task.id ? null : now));
      return;
    }
    // This is what makes a row a target.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropAt((now) =>
      now?.id === task.id && now.edge === to.edge ? now : { id: task.id, edge: to.edge },
    );
  }

  function onRowDragLeave(task: Task, e: DragEvent<HTMLTableRowElement>) {
    // Crossing from one cell of the row into the next fires this as well, and the line
    // should stay: only leaving the row altogether takes it away.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropAt((now) => (now?.id === task.id ? null : now));
  }

  function onRowDrop(task: Task, e: DragEvent<HTMLTableRowElement>) {
    const to = slot(e, task);
    if (!to) return;
    e.preventDefault();
    endDrag();
    void move(to.from, to.edge, task, null);
  }

  const reorderFor = (task: Task): RowReorder => ({
    edge: dropAt?.id === task.id ? dropAt.edge : null,
    onKeyDown: (e) => onHandleKey(task, e),
    onDragStart: (e) => onHandleDragStart(task, e),
    onDragEnd: endDrag,
    onDragOver: (e) => onRowDragOver(task, e),
    onDragLeave: (e) => onRowDragLeave(task, e),
    onDrop: (e) => onRowDrop(task, e),
  });

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
          className={`w-full ${
            reorderable ? 'min-w-[59rem]' : 'min-w-[57rem]'
          } table-fixed border-collapse text-left text-xs`}
        >
          <colgroup>
            {reorderable && <col className="w-8" />}
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
              {reorderable && (
                <th scope="col" className="pb-1.5">
                  <span className="sr-only">Reorder</span>
                </th>
              )}
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
          <tbody ref={body}>
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                dark={dark}
                startBlockedReason={startBlockedReason}
                onOpen={onOpen}
                onStatus={onStatus}
                onStart={onStart}
                reorder={reorderable ? reorderFor(task) : undefined}
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
  reorder,
}: {
  task: Task;
  dark: boolean;
  startBlockedReason: string | null;
  onOpen: (task: Task) => void;
  onStatus: (task: Task, status: TaskStatus) => void;
  onStart: (task: Task) => void;
  /** Present when the row can be moved by hand, which is when it has a handle. */
  reorder?: RowReorder;
}) {
  const done = task.status === 'completed';
  // The line a drop would land on, 2px in the accent colour at the top or the bottom of
  // the row. It is an inset shadow on every cell: a border would push the row about, and
  // a shadow on the <tr> is not painted in a table with collapsed borders.
  const line =
    reorder?.edge === 'before'
      ? 'shadow-[inset_0_2px_0_0_var(--accent)]'
      : reorder?.edge === 'after'
        ? 'shadow-[inset_0_-2px_0_0_var(--accent)]'
        : '';
  const cell = `py-2 pr-3 align-middle ${line}`;
  return (
    <tr
      className={`border-t border-hairline ${done ? 'text-muted' : 'text-ink'}`}
      onDragOver={reorder?.onDragOver}
      onDragLeave={reorder?.onDragLeave}
      onDrop={reorder?.onDrop}
    >
      {reorder && (
        <td className={`py-2 pr-1 align-middle ${line}`}>
          <button
            type="button"
            draggable
            data-task-handle={task.id}
            aria-label={`Move "${task.title}"`}
            title="Drag to reorder within its priority, or use ↑ ↓"
            onKeyDown={reorder.onKeyDown}
            onDragStart={reorder.onDragStart}
            onDragEnd={reorder.onDragEnd}
            // The ring is drawn inside the button: it sits flush at the left edge of the box
            // that scrolls the table, and a ring outside it would be cut off there.
            className="grid size-7 cursor-grab place-items-center rounded-md text-muted
              transition-colors hover:text-ink active:cursor-grabbing focus-visible:outline-2
              focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <GripIcon />
          </button>
        </td>
      )}
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
          {/* The word says it was carried; the week it was added in is in the tooltip. */}
          {task.carriedFrom && (
            <span
              title={`Added the week of ${fullDay(task.carriedFrom)}`}
              className="mt-0.5 shrink-0 rounded-full border border-hairline px-1.5 py-px
                text-[10px] font-medium text-muted"
            >
              carried
            </span>
          )}
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
      <td className={`py-2 align-middle ${line}`}>
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

/** Six dots, two by three: the handle a row is taken by. */
function GripIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 16" className="h-4 w-3" fill="currentColor">
      <circle cx="3.5" cy="3" r="1.3" />
      <circle cx="8.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8.5" cy="8" r="1.3" />
      <circle cx="3.5" cy="13" r="1.3" />
      <circle cx="8.5" cy="13" r="1.3" />
    </svg>
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
  const [weekOf, setWeekOf] = useState(task.weekOf);
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
    if (!weekOf) {
      setError('A task needs a week');
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
    // Only when it was changed: the week files the task, so saying it again would be a move
    // for no reason, and a task that was carried must keep the week it was carried into.
    if (weekOf !== task.weekOf) patch.weekOf = weekOf;
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

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Week of"
              hint={
                task.carriedFrom
                  ? `Added the week of ${dayLabel(task.carriedFrom)}. Any day works.`
                  : 'Any day works: it files under that week’s Monday.'
              }
            >
              <input
                type="date"
                className={inputClass}
                value={weekOf}
                onChange={(e) => setWeekOf(e.target.value)}
              />
            </Field>
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
