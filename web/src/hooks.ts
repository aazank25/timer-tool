import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type Session, type TaskFilter, type TaskInput, type TaskMove } from './api';
import { clock } from './lib/format';

/* ------------------------------------------------------------------ theme */

export type Theme = 'system' | 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void, boolean] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('focusdesk.theme') as Theme | null) ?? 'system',
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem('focusdesk.theme', theme);
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  return [theme, setTheme, theme === 'dark' || (theme === 'system' && systemDark)];
}

/* ------------------------------------------------------------------- tick */

/** Re-render on an interval so a countdown or a count-up moves without refetching. */
export function useTick(ms = 1000): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return Date.now();
}

/* ------------------------------------------------------------------ queries */

export const keys = {
  today: ['today'] as const,
  projects: (archived: boolean) => ['projects', archived] as const,
  active: ['session', 'active'] as const,
  day: (day: string) => ['stats', 'day', day] as const,
  range: (from: string, to: string) => ['stats', 'range', from, to] as const,
  plan: (day: string) => ['plan', day] as const,
  tasks: (f: TaskFilter) => ['tasks', f.view ?? 'open', f.projectId ?? 'all'] as const,
  timers: ['timers'] as const,
  settings: ['settings'] as const,
  calendarSources: ['calendar', 'sources'] as const,
  calendarEvents: (from: string, to: string) => ['calendar', 'events', from, to] as const,
};

/** How often a running block is re-read: the live session itself, and what shows its time. */
const LIVE_POLL_MS = 15_000;

/** Everything that changes when a block starts, stops or is edited. */
function invalidateTimeline(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['session'] });
  void qc.invalidateQueries({ queryKey: ['stats'] });
  void qc.invalidateQueries({ queryKey: ['plan'] });
  void qc.invalidateQueries({ queryKey: ['projects'] });
  // A task's logged time is the sum of its blocks, so it moves with them.
  void qc.invalidateQueries({ queryKey: ['tasks'] });
  void qc.invalidateQueries({ queryKey: ['timers'] });
  void qc.invalidateQueries({ queryKey: ['calendar', 'events'] });
  void qc.invalidateQueries({ queryKey: ['wrapup'] });
}

export function useToday() {
  return useQuery({ queryKey: keys.today, queryFn: api.today, staleTime: 60_000 });
}

export function useProjects(includeArchived = false) {
  return useQuery({
    queryKey: keys.projects(includeArchived),
    queryFn: () => api.listProjects(includeArchived),
    staleTime: 30_000,
  });
}

export function useDayStats(day: string | undefined) {
  return useQuery({
    queryKey: keys.day(day ?? 'today'),
    queryFn: () => api.dayStats(day),
    enabled: day !== undefined,
  });
}

export function useRangeStats(from: string, to: string) {
  return useQuery({
    queryKey: keys.range(from, to),
    queryFn: () => api.rangeStats({ from, to }),
  });
}

export function usePlan(day: string | undefined) {
  return useQuery({
    queryKey: keys.plan(day ?? ''),
    queryFn: () => api.listPlan(day as string),
    enabled: !!day,
  });
}

/**
 * `poll` is for a caller that shows logged time while a block is running. A block
 * on the clock counts toward its task's total and the server measures it live, so
 * the figure goes stale as the clock runs: it is re-read at the live-session poll's
 * own pace. With nothing running nothing changes, so there is nothing to poll for.
 */
export function useTasks(filter: TaskFilter = {}, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.tasks(filter),
    queryFn: () => api.listTasks(filter),
    refetchInterval: poll ? LIVE_POLL_MS : false,
  });
}

export function useTimers() {
  return useQuery({ queryKey: keys.timers, queryFn: () => api.listTimers(), staleTime: 30_000 });
}

export function useTimerActions() {
  const qc = useQueryClient();
  const onDone = () => void qc.invalidateQueries({ queryKey: ['timers'] });
  return {
    save: useMutation({ mutationFn: api.saveTimer, onSuccess: onDone }),
    unsave: useMutation({ mutationFn: api.unsaveTimer, onSuccess: onDone }),
  };
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 60_000 });
}

export function useCalendarSources() {
  return useQuery({ queryKey: keys.calendarSources, queryFn: api.calendarSources });
}

export function useCalendarEvents(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: keys.calendarEvents(from, to),
    queryFn: () => api.calendarEvents({ from, to }),
    enabled,
  });
}

/* ------------------------------------------------------- the live session */

export interface LiveSession {
  session: Session | null;
  /** Elapsed seconds, interpolated between server polls. */
  elapsedSeconds: number;
  /** Both null for a stopwatch: with no planned length there is nothing to count down from. */
  remainingSeconds: number | null;
  overrunSeconds: number | null;
  isRunning: boolean;
}

/**
 * The block on the clock as the server last said it, polled. Whatever only needs to know
 * what state a block is in reads this: `useLiveSession` adds a tick every second to it,
 * which is a re-render a dialog on screen has no use for. Both read the one query.
 */
export function useActiveSession() {
  return useQuery({
    queryKey: keys.active,
    queryFn: api.activeSession,
    refetchInterval: LIVE_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/**
 * The server owns the clock: it stores when each run/pause segment began, so
 * elapsed time survives a refresh, a closed lid or a restarted process. This
 * polls that truth and interpolates between polls so the display still ticks
 * once a second.
 */
export function useLiveSession(): LiveSession & { isLoading: boolean } {
  const query = useActiveSession();
  const now = useTick(1000);
  const session = query.data?.session ?? null;
  const isRunning = session?.status === 'running';

  const elapsedSeconds = useMemo(() => {
    if (!session) return 0;
    if (!isRunning) return session.elapsedSeconds;
    const drift = Math.max(0, (now - query.dataUpdatedAt) / 1000);
    return Math.round(session.elapsedSeconds + drift);
  }, [session, isRunning, now, query.dataUpdatedAt]);

  const planned = session?.plannedSeconds ?? null;
  return {
    session,
    elapsedSeconds,
    remainingSeconds: planned == null ? null : Math.max(0, planned - elapsedSeconds),
    overrunSeconds: planned == null ? null : Math.max(0, elapsedSeconds - planned),
    isRunning,
    isLoading: query.isLoading,
  };
}

/* ---------------------------------------------------------------- mutations */

export function useSessionActions() {
  const qc = useQueryClient();
  const onDone = () => invalidateTimeline(qc);

  return {
    start: useMutation({ mutationFn: api.startSession, onSuccess: onDone }),
    pause: useMutation({ mutationFn: api.pauseSession, onSuccess: onDone }),
    resume: useMutation({ mutationFn: api.resumeSession, onSuccess: onDone }),
    interrupt: useMutation({ mutationFn: api.addInterruption, onSuccess: onDone }),
    extend: useMutation({
      mutationFn: ({ id, minutes }: { id: number; minutes: number }) =>
        api.extendSession(id, minutes),
      onSuccess: onDone,
    }),
    complete: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: number;
        focusRating?: number | null;
        notes?: string | null;
        title?: string;
        activeSeconds?: number;
      }) => api.completeSession(id, body),
      onSuccess: onDone,
    }),
    abandon: useMutation({ mutationFn: api.abandonSession, onSuccess: onDone }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
        api.updateSession(id, body),
      onSuccess: onDone,
    }),
    remove: useMutation({ mutationFn: api.deleteSession, onSuccess: onDone }),
    logManual: useMutation({ mutationFn: api.logManual, onSuccess: onDone }),
  };
}

export function useProjectActions() {
  const qc = useQueryClient();
  const onDone = () => {
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
  return {
    create: useMutation({ mutationFn: api.createProject, onSuccess: onDone }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
        api.updateProject(id, body),
      onSuccess: onDone,
    }),
    archive: useMutation({ mutationFn: api.archiveProject, onSuccess: onDone }),
  };
}

export function useCalendarActions() {
  const qc = useQueryClient();
  const onDone = () => {
    void qc.invalidateQueries({ queryKey: ['calendar'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
  return {
    assignProject: useMutation({
      mutationFn: ({ id, projectId }: { id: string; projectId: number | null }) =>
        api.assignEventProject(id, projectId),
      onSuccess: onDone,
    }),
    sync: useMutation({ mutationFn: api.syncCalendars, onSuccess: onDone }),
  };
}

export function useTaskActions() {
  const qc = useQueryClient();
  const onDone = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    // A block carries the title of the task it is on, so a rename or a delete has to
    // reach the day's blocks (the log, the rollups) and the block on the clock too.
    void qc.invalidateQueries({ queryKey: ['stats'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
  };
  return {
    create: useMutation({ mutationFn: api.createTask, onSuccess: onDone }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & TaskInput) => api.updateTask(id, body),
      onSuccess: onDone,
    }),
    remove: useMutation({ mutationFn: api.deleteTask, onSuccess: onDone }),
    // Only the order changes, so only the lists of tasks are read again. The promise is
    // returned so the mutation settles only after they have been, which lets a caller
    // wait out the move, the new order read included, before it does anything that
    // depends on the rows being where they now are. The page draws that order a moment
    // after this settles, so a caller that has to know it is drawn waits for that too.
    move: useMutation({
      mutationFn: ({ id, to }: { id: number; to: TaskMove }) => api.moveTask(id, to),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    }),
  };
}

export function usePlanActions() {
  const qc = useQueryClient();
  const onDone = () => void qc.invalidateQueries({ queryKey: ['plan'] });
  return {
    create: useMutation({ mutationFn: api.createPlanItem, onSuccess: onDone }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
        api.updatePlanItem(id, body),
      onSuccess: onDone,
    }),
    remove: useMutation({ mutationFn: api.deletePlanItem, onSuccess: onDone }),
  };
}

/* ------------------------------------------------------------ notification */

/**
 * Keep the tab title showing the clock, and for a pomodoro tell the user once
 * when the planned time is up. The block keeps running — overrun is real work
 * and gets counted — this just stops it going unnoticed. A stopwatch has no
 * end to announce, so it only ever updates the title and never notifies.
 */
export function useBlockEndAlert(live: LiveSession): void {
  const alerted = useRef<number | null>(null);
  const baseTitle = useRef(document.title);

  useEffect(() => {
    const { session, isRunning, elapsedSeconds, remainingSeconds, overrunSeconds } = live;
    if (!session || !isRunning) {
      document.title = baseTitle.current;
      return;
    }
    if (remainingSeconds == null || overrunSeconds == null) {
      document.title = `${clock(elapsedSeconds)} · ${session.title}`;
      return;
    }
    document.title =
      overrunSeconds > 0
        ? `+${Math.floor(overrunSeconds / 60)}m over · ${session.title}`
        : `${Math.ceil(remainingSeconds / 60)}m · ${session.title}`;

    if (remainingSeconds > 0 || alerted.current === session.id) return;
    alerted.current = session.id;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Block complete', {
        body: `${session.title} — ${session.plannedMinutes}m done. Rate it and take a break.`,
        tag: `focusdesk-${session.id}`,
      });
    }
  }, [live]);

  useEffect(
    () => () => {
      document.title = baseTitle.current;
    },
    [],
  );
}

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}
