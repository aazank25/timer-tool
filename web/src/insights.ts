import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qs, request } from './api';
import type { InterruptionReason } from './lib/interruptions';

/**
 * What pulled you away from your focus blocks over a window of days. `unspecified` is the
 * interruptions counted with no reason: logged before reasons existed, or logged with "No
 * reason". `total` is always the reasons given plus that.
 */
export interface InterruptionStats {
  from: string;
  to: string;
  total: number;
  /** Most often first, and only the reasons that were given. */
  byReason: { reason: InterruptionReason; label: string; count: number }[];
  unspecified: number;
}

/** How a kind of estimate has held up. The median is null under three: too few to say. */
export interface Accuracy {
  count: number;
  /** Actual over estimate: 1.5 ran half as long again as the guess, 0.8 came in a fifth under. */
  medianRatio: number | null;
}

export interface EstimateStats {
  from: string;
  to: string;
  blocks: Accuracy;
  tasks: Accuracy;
  /** "No project" is the entry with a null id. */
  byProject: {
    projectId: number | null;
    name: string;
    color: string;
    blocks: Accuracy;
    tasks: Accuracy;
  }[];
}

export interface CarryOverResult {
  carried: number;
  /** The Monday of the week they were carried into. */
  weekOf: string;
}

export const insightsApi = {
  interruptionStats: (params: { from?: string; to?: string }) =>
    request<InterruptionStats>('GET', `/stats/interruptions${qs(params)}`),
  estimateStats: (params: { from?: string; to?: string }) =>
    request<EstimateStats>('GET', `/stats/estimates${qs(params)}`),
  carryOver: () => request<CarryOverResult>('POST', '/tasks/carry-over'),
};

/* ------------------------------------------------------------------ queries */

// Under 'stats', so everything that already re-reads the stats when a block ends or is edited
// reads these again too: an interruption logged a moment ago shows on the next look.
export function useInterruptionStats(from: string, to: string) {
  return useQuery({
    queryKey: ['stats', 'interruptions', from, to] as const,
    queryFn: () => insightsApi.interruptionStats({ from, to }),
  });
}

export function useEstimateStats(from: string, to: string) {
  return useQuery({
    queryKey: ['stats', 'estimates', from, to] as const,
    queryFn: () => insightsApi.estimateStats({ from, to }),
  });
}

/* ---------------------------------------------------------------- mutations */

/**
 * Bring the unfinished tasks of earlier weeks into this one. It changes the week of tasks and
 * nothing a block or a stat is made of, so only the lists of tasks are read again.
 */
export function useCarryOver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: insightsApi.carryOver,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
