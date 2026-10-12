import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, request, type ProjectSlice, type Session, type TaskStatus } from './api';
import { useActiveSession } from './hooks';

/* ------------------------------------------------------------------- shapes */

/** A task that a block worked on during the day. */
export interface WrapUpDayTask {
  id: number;
  title: string;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  status: TaskStatus;
  estimatedMinutes: number | null;
  /** What the day's blocks put on it, the one on the clock included. */
  secondsToday: number;
  /** Everything logged on it, ever, so it can be read against its estimate. */
  loggedSeconds: number;
}

/**
 * A day as it stands when it is being closed out. Every figure counts a block still on
 * the clock by its live elapsed time, which the stats screens do not.
 */
export interface WrapUpDay {
  day: string;
  focusSeconds: number;
  blocks: number;
  avgFocusRating: number | null;
  byProject: ProjectSlice[];
  /** The day's focus blocks, oldest first. */
  sessions: Session[];
  /** Finished focus blocks nobody has rated yet. */
  unrated: number[];
  /** Every task a block worked on, most time first. */
  tasks: WrapUpDayTask[];
  note: string | null;
  wrappedUpAt: string | null;
  /** The latest earlier day that has a note: what you meant to do. */
  previous: { day: string; note: string } | null;
}

export interface WrapUpWeekTask {
  id: number;
  title: string;
  projectName: string | null;
  projectColor: string | null;
  status: TaskStatus;
  estimatedMinutes: number | null;
  /** Zero for a task that is listed for some other reason than time. */
  secondsThisWeek: number;
  loggedSeconds: number;
  completedOn: string | null;
}

export interface WrapUpWeek {
  /** The Monday that names the week. */
  week: string;
  from: string;
  to: string;
  focusSeconds: number;
  activeDays: number;
  blocks: number;
  avgFocusRating: number | null;
  /** Monday to Sunday, every day there whether or not it had any work. */
  days: { day: string; focusSeconds: number; blocks: number }[];
  byProject: ProjectSlice[];
  /** Every task a block worked on this week, most time first. */
  tasks: WrapUpWeekTask[];
  /** Tasks finished this week. */
  completed: WrapUpWeekTask[];
  /** Tasks from this week's sheet that are still not done. */
  unfinished: WrapUpWeekTask[];
  note: string | null;
  reviewedAt: string | null;
}

/* ---------------------------------------------------------------------- api */

export const wrapUpApi = {
  day: (day: string) => request<WrapUpDay>('GET', `/wrapup/day${qs({ day })}`),
  /** Null, or blank, clears it. */
  saveDayNote: (day: string, note: string | null) =>
    request<WrapUpDay>('PUT', `/wrapup/day/${day}`, { note }),
  finishDay: (day: string) => request<WrapUpDay>('POST', `/wrapup/day/${day}/done`),

  /** Any day of the week names it. */
  week: (week: string) => request<WrapUpWeek>('GET', `/wrapup/week${qs({ week })}`),
  saveWeekNote: (week: string, note: string | null) =>
    request<WrapUpWeek>('PUT', `/wrapup/week/${week}`, { note }),
  finishWeek: (week: string) => request<WrapUpWeek>('POST', `/wrapup/week/${week}/done`),
};

/* -------------------------------------------------------------------- hooks */

export const wrapUpKeys = {
  all: ['wrapup'] as const,
  day: (day: string) => ['wrapup', 'day', day] as const,
  week: (week: string) => ['wrapup', 'week', week] as const,
};

/**
 * How often a running block is re-read. The server measures it live, so the figures go
 * stale as the clock runs; the same pace as the live session itself (hooks.ts).
 */
const LIVE_POLL_MS = 15_000;

/**
 * `day` is undefined until the server has said which day it is, and nothing is read
 * before. `poll` is for a caller with a block on the clock, like `useTasks`: its time is
 * part of what the page shows, and with nothing running nothing changes to poll for.
 */
export function useWrapUpDay(day: string | undefined, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: wrapUpKeys.day(day ?? ''),
    queryFn: () => wrapUpApi.day(day as string),
    enabled: day !== undefined,
    refetchInterval: poll ? LIVE_POLL_MS : false,
  });
}

export function useWrapUpWeek(week: string | undefined, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: wrapUpKeys.week(week ?? ''),
    queryFn: () => wrapUpApi.week(week as string),
    enabled: week !== undefined,
    refetchInterval: poll ? LIVE_POLL_MS : false,
  });
}

/**
 * Read the wrap-up again whenever the block on the clock changes: another one is started, or
 * this one is paused, resumed or stopped, from the menu bar or another window. Every figure
 * here counts the block live, so the moment it changes they are wrong, and the polling above
 * only runs while one is running: once it has stopped nothing would read the page again, and
 * it would go on saying the block is still on the clock. Watches the live-session query the
 * whole app shares, which is polled and read again when the window gets the focus, so a change
 * is noticed within that time. The first answer is not a change: it is what the page opened on.
 */
export function useRefreshWhenTheClockChanges() {
  const qc = useQueryClient();
  const { data } = useActiveSession();
  const session = data?.session;
  // What is on the clock, in a word: undefined until the first answer, so that is not a change.
  const now =
    data === undefined ? undefined : `${session?.id ?? 'none'}:${session?.status ?? 'none'}`;
  const seen = useRef(now);
  useEffect(() => {
    const was = seen.current;
    seen.current = now;
    if (now === undefined || was === undefined || was === now) return;
    void qc.invalidateQueries({ queryKey: wrapUpKeys.all });
  }, [now, qc]);
}

export function useWrapUpActions() {
  const qc = useQueryClient();
  // The reply to each save is the whole day or week again, so it goes straight into the
  // cache and the screen does not wait on a second read. The rest of the wrap-up is read
  // again behind it: a note is also the next day's "yesterday you planned".
  const refresh = () => void qc.invalidateQueries({ queryKey: wrapUpKeys.all });
  return {
    saveDayNote: useMutation({
      mutationFn: ({ day, note }: { day: string; note: string | null }) =>
        wrapUpApi.saveDayNote(day, note),
      onSuccess: (view) => {
        qc.setQueryData(wrapUpKeys.day(view.day), view);
        refresh();
      },
    }),
    finishDay: useMutation({
      mutationFn: wrapUpApi.finishDay,
      onSuccess: (view) => {
        qc.setQueryData(wrapUpKeys.day(view.day), view);
        refresh();
      },
    }),
    saveWeekNote: useMutation({
      mutationFn: ({ week, note }: { week: string; note: string | null }) =>
        wrapUpApi.saveWeekNote(week, note),
      onSuccess: (view) => {
        qc.setQueryData(wrapUpKeys.week(view.week), view);
        refresh();
      },
    }),
    finishWeek: useMutation({
      mutationFn: wrapUpApi.finishWeek,
      onSuccess: (view) => {
        qc.setQueryData(wrapUpKeys.week(view.week), view);
        refresh();
      },
    }),
    // The status of a task is the Tasks tab's to change, so this goes through its route. What
    // the wrap-up shows of the task, and the Tasks tab itself, both have to hear about it,
    // and useTaskActions only tells the second.
    setTaskStatus: useMutation({
      // `completedOn` is for finishing a task on a day other than today: left out, the server
      // stamps today.
      mutationFn: ({
        id,
        status,
        completedOn,
      }: {
        id: number;
        status: TaskStatus;
        completedOn?: string;
      }) => api.updateTask(id, completedOn ? { status, completedOn } : { status }),
      onSuccess: () => {
        refresh();
        void qc.invalidateQueries({ queryKey: ['tasks'] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
      },
    }),
  };
}
