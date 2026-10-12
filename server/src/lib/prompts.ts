import { db } from '../db.js';
import { awayProvider } from './away.js';
import { badRequest, conflict } from './http.js';
import { longBlockProvider } from './long-block.js';
import { meetingEndProvider, meetingStartProvider } from './meetings.js';

/**
 * "Needs your attention": the things the app has a question about, as one list. The web
 * client shows them as banners and the desktop app as notifications, so what is asked and
 * how it is answered lives here once. Each kind of prompt is a provider, and a new kind
 * (an end-of-day wrap-up, a weekly review) is one more provider registered below.
 */

export interface PromptAction {
  /** What is sent back to answer it. Not shown. */
  id: string;
  label: string;
  /** The answer most people want. */
  primary?: boolean;
  /**
   * A route of the client to go to, such as '/?finish=1'. The client handles it itself and
   * never sends it here: there is nothing for the server to do.
   */
  open?: string;
}

export interface Prompt {
  /** Stays the same for as long as the same thing is pending: 'away:12', 'long-block:345:1'. */
  id: string;
  /** What sort of question it is, and so which provider answers for it. */
  kind: string;
  /** A short headline. */
  title: string;
  /** One sentence. */
  body: string;
  /** When it became due, as an ISO time: what the list is ordered by, and how a client tells it is new. */
  createdAt: string;
  /** Every prompt has at least one that answers it on the server, so it can be got rid of. */
  actions: PromptAction[];
}

export interface PromptProvider {
  /** The kind of every prompt it lists. */
  kind: string;
  /** What is due now. Worked out from the data as it stands, so it asks nothing twice. */
  list(now: Date): Prompt[];
  /**
   * Answer a prompt it listed with one of the actions it offered. Both are checked before
   * this is called, and it runs in a transaction, so one that throws leaves nothing changed.
   */
  act(id: string, action: string, now: Date): void;
}

const providers: PromptProvider[] = [];

/** Add a kind of prompt. Returns a function that takes it away again, which tests use. */
export function registerPromptProvider(provider: PromptProvider): () => void {
  if (providers.some((p) => p.kind === provider.kind)) {
    throw new Error(`A provider for "${provider.kind}" prompts is already registered`);
  }
  providers.push(provider);
  return () => {
    const at = providers.indexOf(provider);
    if (at >= 0) providers.splice(at, 1);
  };
}

for (const provider of [
  awayProvider,
  longBlockProvider,
  meetingStartProvider,
  meetingEndProvider,
]) {
  registerPromptProvider(provider);
}

/**
 * Oldest first by the instant it fell due, and by id for ones that fell due together. The
 * times are compared as instants and the ids as plain text, so what comes first does not
 * depend on how a provider writes its times or on the machine's locale.
 */
const byDue = (a: Prompt, b: Prompt) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Everything due, oldest first, so the one that has waited longest is on top. */
export function listPrompts(now: Date = new Date()): Prompt[] {
  const all: Prompt[] = [];
  for (const provider of providers) {
    // One kind failing must not hide the others: that is a question you would never see.
    try {
      all.push(...provider.list(now));
    } catch (err) {
      console.error(`[prompts] could not list "${provider.kind}" prompts`, err);
    }
  }
  return all.sort(byDue);
}

/**
 * Answer a prompt, and hand back the list as it is now. The prompt is looked up in what is
 * due this moment and not taken on trust from the caller: one that has been answered
 * elsewhere, or has stopped being true, is a 409, so a notification left on screen cannot
 * act on something that no longer applies.
 */
export function actOnPrompt(id: string, action: string, now: Date = new Date()): Prompt[] {
  const prompt = listPrompts(now).find((p) => p.id === id);
  if (!prompt) throw conflict('That prompt is no longer current');
  const chosen = prompt.actions.find((a) => a.id === action);
  if (!chosen) throw badRequest(`Unknown action: ${action}`);
  // Opening a page is the client's own business.
  if (chosen.open) throw badRequest('That action is carried out by the app, not the server');
  const provider = providers.find((p) => p.kind === prompt.kind);
  if (!provider) throw conflict('That prompt is no longer current');
  db.transaction(() => provider.act(id, action, now))();
  return listPrompts(now);
}
