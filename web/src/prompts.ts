import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';

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
    onSuccess: ({ prompts }) => {
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
