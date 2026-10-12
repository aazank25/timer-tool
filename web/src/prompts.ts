import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, request } from './api';

/**
 * "Needs your attention": what the server has a question about, as it lists them
 * (server/src/lib/prompts.ts). The banners under the clock show them, and so will the
 * desktop app's notifications.
 */
export interface PromptAction {
  /** What is sent back to answer it. */
  id: string;
  label: string;
  /** The answer most people want. */
  primary?: boolean;
  /** A route of this app to go to. It is handled here and never sent to the server. */
  open?: string;
}

export interface Prompt {
  /** Stays the same for as long as the same thing is pending. */
  id: string;
  kind: string;
  title: string;
  /** One sentence. */
  body: string;
  /** When it became due. */
  createdAt: string;
  actions: PromptAction[];
}

export const promptKeys = { all: ['prompts'] as const };

/** How often the list is read again; it is also read whenever the window is focused. */
const PROMPT_POLL_MS = 15_000;

export const promptApi = {
  list: () => request<Prompt[]>('GET', '/prompts'),
  act: (body: { id: string; action: string }) =>
    request<{ prompts: Prompt[] }>('POST', '/prompts/act', body),
};

/** Everything that needs your attention, oldest first. */
export function usePrompts() {
  return useQuery({
    queryKey: promptKeys.all,
    queryFn: promptApi.list,
    refetchInterval: PROMPT_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Answer a prompt. The server hands back the list as it stands, so that is what is shown next. */
export function useActOnPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: promptApi.act,
    // A list that was on its way back when the answer was sent still has the prompt in it, and
    // landing after the answer it would put the banner back. Stopping it is what makes the list
    // the answer brings the last word.
    onMutate: () => qc.cancelQueries({ queryKey: promptKeys.all }),
    onSuccess: async ({ prompts }) => {
      // A poll that began while the answer was out is the same: the server may have read it before
      // it took the answer. The stop is waited for because a stopped read puts back the list the
      // query had when it began, which would be written over the one set below.
      await qc.cancelQueries({ queryKey: promptKeys.all });
      qc.setQueryData(promptKeys.all, prompts);
      // The answer may have paused or resumed the block, logged time on a meeting or taken
      // time off a block, so anything that shows the clock or the day is out of date too.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== promptKeys.all[0] });
    },
    // A prompt that was answered somewhere else, or has stopped being true, is refused as
    // no longer current. Either way what is on screen is out of date.
    onError: () => void qc.invalidateQueries({ queryKey: promptKeys.all }),
  });
}

/**
 * The kinds that are about something happening this minute, in the order they go out of date: a
 * meeting that has started, one that has ended, a block that has run long. Anything else (time you
 * were away) will keep.
 */
const TIME_CRITICAL = ['meeting-start', 'meeting-end', 'long-block'];

const NO_PROMPTS: readonly Prompt[] = [];

/**
 * The order the banners are shown in. Only the first few are on screen, so what comes first is
 * what gets seen: the time-critical kinds go first, then the rest, and within a kind the server's
 * order (oldest first) is kept.
 */
export function inDisplayOrder(prompts: readonly Prompt[] | undefined): readonly Prompt[] {
  if (!prompts?.length) return NO_PROMPTS;
  const rank = (p: Prompt) => {
    const at = TIME_CRITICAL.indexOf(p.kind);
    return at === -1 ? TIME_CRITICAL.length : at;
  };
  // Array.prototype.sort is stable, which is what keeps the server's order within a rank.
  return [...prompts].sort((a, b) => rank(a) - rank(b));
}

/** Said when an answer was refused because the question had already gone. */
export const ALREADY_ANSWERED = 'That was already answered, so nothing changed.';

const NO_ANSWER = "Couldn't reach FocusDesk. Try again.";
const NOT_OFFERED = "That choice isn't available any more.";
const SERVER_SIDE = "Something went wrong on FocusDesk's side. Try again.";

export type AnswerProblem =
  /** The question is gone: answered somewhere else, or no longer true. Nothing is wrong. */
  | { stale: true }
  | { stale: false; text: string };

/**
 * Why an answer did not go through, in words for the person and not the server's or the browser's
 * own: "Unknown action: log-resume", "Failed to fetch" and "Unexpected token '<'" mean nothing to
 * them. A 409 is not a failure at all, so it is told apart: the caller says so in its own way.
 */
export function answerProblem(err: unknown): AnswerProblem {
  if (err instanceof ApiError) {
    if (err.status === 409) return { stale: true };
    // The prompt is still there but no longer offers that answer, as when what it was about
    // changed between the list and the press.
    if (err.status === 400) return { stale: false, text: NOT_OFFERED };
    return { stale: false, text: SERVER_SIDE };
  }
  // fetch itself rejects, with a TypeError, when nothing answered at all.
  if (err instanceof TypeError) return { stale: false, text: NO_ANSWER };
  // Anything else is a reply that was not one of ours, such as a proxy's error page where the
  // JSON should have been.
  return { stale: false, text: SERVER_SIDE };
}
