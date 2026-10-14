import type { InterruptionReason } from './lib/interruptions';

export interface Project {
  id: number;
  name: string;
  color: string;
  description: string | null;
  weeklyTargetMinutes: number | null;
  notionUrl: string | null;
  archived: boolean;
  totalSeconds: number;
  blockCount: number;
  lastWorkedAt: string | null;
  createdAt: string;
}

export type SessionStatus = 'running' | 'paused' | 'completed' | 'abandoned';

/** A pomodoro counts down a fixed length; a stopwatch just counts up until you stop it. */
export type TimerMode = 'stopwatch' | 'pomodoro';

export interface Session {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  /** The task this block was the work on, if any. */
  taskId: number | null;
  taskTitle: string | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  mode: TimerMode;
  /** The planned fields are null for a stopwatch: it has no length to count down from. */
  plannedMinutes: number | null;
  plannedSeconds: number | null;
  /** A guess to compare against. Display only; it never feeds a score or a countdown. */
  estimatedMinutes: number | null;
  startedAt: string;
  endedAt: string | null;
  day: string;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  overrunSeconds: number | null;
  interruptions: number;
  focusRating: number | null;
  focusScore: number | null;
  notes: string | null;
  status: SessionStatus;
  isLive: boolean;
  calendarEventId: string | null;
}

export type TaskPriority = 'high' | 'medium' | 'low';
export type TaskStatus = 'not_started' | 'in_progress' | 'held_up' | 'completed';

/** A smaller unit of work than a project, or one that belongs to no project at all. */
export interface Task {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Total effort across every block it takes. Display only: never a block's own estimate. */
  estimatedMinutes: number | null;
  addedOn: string;
  /**
   * The Monday of the week it sits in: the sheet's "Week Of". It starts as the week it was
   * added, and moves when the task is carried forward or filed under another week.
   */
  weekOf: string;
  /**
   * The Monday of the week it was first carried forward from, once it has been, otherwise null.
   * Filing a task under another week by hand is not carrying it, and clears this.
   */
  carriedFrom: string | null;
  startDate: string | null;
  targetDate: string | null;
  completedOn: string | null;
  notes: string | null;
  results: string | null;
  position: number;
  /** Focus time logged on it, a block still on the clock included. */
  loggedSeconds: number;
  blockCount: number;
  lastWorkedAt: string | null;
  /** Past its target day and not completed. */
  overdue: boolean;
}

export interface TaskFilter {
  view?: 'open' | 'completed' | 'all';
  /** A project's id, or 'none' for the tasks that belong to no project. */
  projectId?: number | 'none';
}

/**
 * Where a move puts a task: right before another task of its week and priority, or right
 * after. Exactly one key, and the other cannot be there at all.
 */
export type TaskMove = { before: number; after?: never } | { after: number; before?: never };

/** Undefined leaves a field as it is; null clears the ones that can be empty. */
export interface TaskInput {
  title?: string;
  projectId?: number | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  estimatedMinutes?: number | null;
  addedOn?: string;
  /** Any day of the week to file it under: the server takes it to that week's Monday. */
  weekOf?: string;
  startDate?: string | null;
  targetDate?: string | null;
  completedOn?: string | null;
  notes?: string | null;
  results?: string | null;
}

export interface PlanItem {
  id: number;
  day: string;
  position: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  plannedMinutes: number;
  calendarEventId: string | null;
  sessionId: number | null;
  sessionStatus: SessionStatus | null;
  actualSeconds: number;
  done: boolean;
}

export interface SavedTimer {
  id: number | null;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  mode: TimerMode;
  /** Always null for a stopwatch: it has no length to start with. */
  plannedMinutes: number | null;
  pinned: boolean;
  useCount: number;
  totalSeconds: number;
  lastUsedAt: string | null;
}

export interface ProjectSlice {
  projectId: number | null;
  name: string;
  color: string;
  seconds: number;
  blocks: number;
  avgFocusScore: number | null;
  share: number;
}

export interface DayStats {
  day: string;
  focusSeconds: number;
  breakSeconds: number;
  blocks: number;
  completedBlocks: number;
  abandonedBlocks: number;
  interruptions: number;
  avgFocusRating: number | null;
  avgFocusScore: number | null;
  ratedBlocks: number;
  targetMinutes: number;
  longestStreakSeconds: number;
  byProject: ProjectSlice[];
  byHour: { hour: number; seconds: number }[];
  sessions: Session[];
}

export interface RangeStats {
  from: string;
  to: string;
  totalFocusSeconds: number;
  totalBlocks: number;
  activeDays: number;
  avgFocusScore: number | null;
  avgSecondsPerActiveDay: number;
  days: {
    day: string;
    focusSeconds: number;
    blocks: number;
    avgFocusScore: number | null;
    byProject: { projectId: number | null; seconds: number }[];
  }[];
  byProject: ProjectSlice[];
  byHour: { hour: number; seconds: number }[];
}

export interface CalendarEvent {
  id: string;
  provider: string;
  calendarLabel: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendees: string[];
  day: string;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  loggedSeconds: number;
}

export interface CalendarSource {
  id: string;
  label: string;
  host: string;
  enabled: boolean;
}

export type Settings = Record<string, string>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * What went wrong, in words. A refused request only says "Invalid request", so the
 * first field the server named is added to it, or you could not tell which one.
 */
export function reason(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const fields =
    err instanceof ApiError
      ? (err.details as { fieldErrors?: Record<string, string[]> })?.fieldErrors
      : undefined;
  const first = Object.entries(fields ?? {})[0];
  return first ? `${err.message} (${first[0]}: ${first[1]?.[0] ?? 'not allowed'})` : err.message;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = payload as { error?: string; details?: unknown } | undefined;
    throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`, err?.details);
  }
  return payload as T;
}

export const qs = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length
    ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`
    : '';
};

export const api = {
  today: () => request<{ today: string; timezone: string; dayStartHour: number }>('GET', '/stats/today'),

  listProjects: (includeArchived = false) =>
    request<Project[]>('GET', `/projects${qs({ includeArchived: includeArchived ? 'true' : undefined })}`),
  createProject: (body: {
    name: string;
    color?: string;
    description?: string | null;
    weeklyTargetMinutes?: number | null;
    notionUrl?: string | null;
  }) => request<Project>('POST', '/projects', body),
  updateProject: (id: number, body: Record<string, unknown>) =>
    request<Project>('PATCH', `/projects/${id}`, body),
  archiveProject: (id: number) => request<Project>('DELETE', `/projects/${id}`),

  activeSession: () => request<{ session: Session | null }>('GET', '/sessions/active'),
  listSessions: (params: { day?: string; from?: string; to?: string; projectId?: number }) =>
    request<Session[]>('GET', `/sessions${qs(params)}`),
  startSession: (body: {
    projectId?: number | null;
    taskId?: number | null;
    title: string;
    intent?: string | null;
    mode?: TimerMode;
    plannedMinutes?: number;
    estimatedMinutes?: number | null;
    kind?: 'focus' | 'break';
    planItemId?: number | null;
    calendarEventId?: string | null;
  }) => request<Session>('POST', '/sessions', body),
  logManual: (body: {
    projectId?: number | null;
    title: string;
    startedAt: string;
    minutes: number;
    focusRating?: number | null;
    notes?: string | null;
    /** The meeting this is the time spent on: it then shows what was logged on it. */
    calendarEventId?: string | null;
  }) => request<Session>('POST', '/sessions/manual', body),
  pauseSession: (id: number) => request<Session>('POST', `/sessions/${id}/pause`),
  resumeSession: (id: number) => request<Session>('POST', `/sessions/${id}/resume`),
  // No reason is the body it always had: the reason is left out, not sent as null.
  addInterruption: (id: number, reason?: InterruptionReason | null) =>
    request<Session>('POST', `/sessions/${id}/interruption`, reason ? { reason } : {}),
  extendSession: (id: number, minutes: number) =>
    request<Session>('POST', `/sessions/${id}/extend`, { minutes }),
  completeSession: (
    id: number,
    body: { focusRating?: number | null; notes?: string | null; title?: string; activeSeconds?: number },
  ) => request<Session>('POST', `/sessions/${id}/complete`, body),
  abandonSession: (id: number) => request<Session>('POST', `/sessions/${id}/abandon`, {}),
  updateSession: (id: number, body: Record<string, unknown> & { taskId?: number | null }) =>
    request<Session>('PATCH', `/sessions/${id}`, body),
  deleteSession: (id: number) => request<{ deleted: number }>('DELETE', `/sessions/${id}`),

  listTasks: (f: TaskFilter = {}) =>
    request<Task[]>('GET', `/tasks${qs({ view: f.view, projectId: f.projectId })}`),
  createTask: (body: TaskInput & { title: string }) => request<Task>('POST', '/tasks', body),
  updateTask: (id: number, body: TaskInput) => request<Task>('PATCH', `/tasks/${id}`, body),
  deleteTask: (id: number) => request<{ deleted: number }>('DELETE', `/tasks/${id}`),
  moveTask: (id: number, to: TaskMove) =>
    request<{ moved: number }>('POST', `/tasks/${id}/move`, to),

  listTimers: (limit = 18) => request<SavedTimer[]>('GET', `/timers${qs({ limit })}`),
  saveTimer: (body: {
    projectId?: number | null;
    title: string;
    plannedMinutes?: number | null;
    mode?: TimerMode;
  }) => request<SavedTimer[]>('POST', '/timers', body),
  unsaveTimer: (id: number) => request<SavedTimer[]>('DELETE', `/timers/${id}`),

  listPlan: (day: string) => request<PlanItem[]>('GET', `/plan${qs({ day })}`),
  createPlanItem: (body: {
    day: string;
    title: string;
    projectId?: number | null;
    plannedMinutes?: number;
    calendarEventId?: string | null;
  }) => request<PlanItem>('POST', '/plan', body),
  updatePlanItem: (id: number, body: Record<string, unknown>) =>
    request<PlanItem>('PATCH', `/plan/${id}`, body),
  deletePlanItem: (id: number) => request<{ deleted: number }>('DELETE', `/plan/${id}`),

  dayStats: (day?: string) => request<DayStats>('GET', `/stats/day${qs({ day })}`),
  rangeStats: (params: { from?: string; to?: string; days?: number }) =>
    request<RangeStats>('GET', `/stats/range${qs(params)}`),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (body: Record<string, string | number | boolean>) =>
    request<Settings>('PATCH', '/settings', body),

  calendarSources: () =>
    request<{ sources: CalendarSource[]; lastSyncedAt: string | null }>('GET', '/calendar/sources'),
  addCalendarSource: (body: { label: string; url: string }) =>
    request<CalendarSource>('POST', '/calendar/sources', body),
  removeCalendarSource: (id: string) =>
    request<{ deleted: string }>('DELETE', `/calendar/sources/${id}`),
  syncCalendars: () =>
    request<{
      results: {
        sourceId: string;
        label: string;
        ok: boolean;
        events: number;
        /** Meetings of a feed that was read that could not be: what the calendar had of them is kept. */
        skipped?: number;
        error?: string;
      }[];
      syncedAt: string;
    }>('POST', '/calendar/sync'),
  calendarEvents: (params: { day?: string; from?: string; to?: string }) =>
    request<CalendarEvent[]>('GET', `/calendar/events${qs(params)}`),
  assignEventProject: (id: string, projectId: number | null) =>
    request<CalendarEvent>('PATCH', `/calendar/events/${encodeURIComponent(id)}`, { projectId }),
};
