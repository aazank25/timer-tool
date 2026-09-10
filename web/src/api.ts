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

export interface Session {
  id: number;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  title: string;
  intent: string | null;
  kind: 'focus' | 'break';
  plannedMinutes: number;
  plannedSeconds: number;
  startedAt: string;
  endedAt: string | null;
  day: string;
  elapsedSeconds: number;
  remainingSeconds: number;
  overrunSeconds: number;
  interruptions: number;
  focusRating: number | null;
  focusScore: number | null;
  notes: string | null;
  status: SessionStatus;
  isLive: boolean;
  calendarEventId: string | null;
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

const qs = (params: Record<string, string | number | undefined>) => {
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
    title: string;
    intent?: string | null;
    plannedMinutes?: number;
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
  }) => request<Session>('POST', '/sessions/manual', body),
  pauseSession: (id: number) => request<Session>('POST', `/sessions/${id}/pause`),
  resumeSession: (id: number) => request<Session>('POST', `/sessions/${id}/resume`),
  addInterruption: (id: number) => request<Session>('POST', `/sessions/${id}/interruption`, {}),
  extendSession: (id: number, minutes: number) =>
    request<Session>('POST', `/sessions/${id}/extend`, { minutes }),
  completeSession: (
    id: number,
    body: { focusRating?: number | null; notes?: string | null; title?: string; activeSeconds?: number },
  ) => request<Session>('POST', `/sessions/${id}/complete`, body),
  abandonSession: (id: number) => request<Session>('POST', `/sessions/${id}/abandon`, {}),
  updateSession: (id: number, body: Record<string, unknown>) =>
    request<Session>('PATCH', `/sessions/${id}`, body),
  deleteSession: (id: number) => request<{ deleted: number }>('DELETE', `/sessions/${id}`),

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
      results: { sourceId: string; label: string; ok: boolean; events: number; error?: string }[];
      syncedAt: string;
    }>('POST', '/calendar/sync'),
  calendarEvents: (params: { day?: string; from?: string; to?: string }) =>
    request<CalendarEvent[]>('GET', `/calendar/events${qs(params)}`),
  assignEventProject: (id: string, projectId: number | null) =>
    request<CalendarEvent>('PATCH', `/calendar/events/${encodeURIComponent(id)}`, { projectId }),
};
