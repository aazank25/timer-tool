import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useExpiring } from '../lib/expiring';
import { errorText } from '../lib/tone';
import {
  ALREADY_ANSWERED,
  answerProblem,
  inDisplayOrder,
  useActOnPrompt,
  usePrompts,
  type Prompt,
  type PromptAction,
} from '../prompts';
import { Button } from './ui';

/** How many banners are shown before the rest are folded away behind "Show N more". */
const SHOWN = 3;

/** How long a line of status stays, and how long a screen reader's announcement is kept. */
const NOTE_MS = 8_000;
const ANNOUNCEMENT_MS = 6_000;

/**
 * How long focus is still looked after once an answer has settled: the list that follows an
 * answer refused as out of date is read after the refusal, and may be what takes its button away.
 */
const FOCUS_WATCH_MS = 1_500;

const ALL_CLEAR = 'Nothing else needs your attention.';

/**
 * The primary action's fill. White on the global accent is 4.42:1 in the light theme and 3.64:1 in
 * the dark one, short of the 4.5:1 that 12px text needs; a fifth of black mixed into it clears that
 * in both (6.3 and 5.3) and is still the accent's blue. Local, so the global token stays as it is.
 */
const PRIMARY_FILL = 'bg-[color-mix(in_srgb,var(--accent)_80%,black)]!';

/**
 * What needs your attention, as banners under the clock on every page: time you were away,
 * a block left running, a meeting that has started or ended. The ones about something happening
 * now come first, and only the first few are shown, so a long list cannot push the page off the
 * screen. An answer that opens a page goes there; any other is sent to the server, which says
 * what is left.
 */
export function PromptCenter() {
  const { data: prompts } = usePrompts();
  const act = useActOnPrompt();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  const listId = useId();
  const ordered = useMemo(() => inDisplayOrder(prompts), [prompts]);
  // Why the last answer to each prompt was refused, shown on that prompt.
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What an answer has to say when the banner it was given on is gone. It stays in the region
  // for a while after, which a banner that has already vanished could not.
  const [note, say] = useExpiring(NOTE_MS);
  const [expanded, setExpanded] = useState(false);

  // One answer at a time, held in a ref and not in the state of the mutation: that is only
  // updated when the page is drawn again, so two presses in the same task would both get through.
  const answering = useRef(false);
  const banners = useRef(new Map<string, HTMLElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  /** The button an answer was given with, and where it stood, so focus can follow it if it goes. */
  const focusAfter = useRef<{ id: string; at: number; button: HTMLElement } | null>(null);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) banners.current.set(id, el);
    else banners.current.delete(id);
  }, []);

  // A label that two banners share ("Keep it", "Dismiss") says nothing about which banner it is
  // on when it is heard by itself, so those get the banner's headline in their names. Two
  // stretches of five minutes away have one headline too, and then the sentence is added as well.
  // Otherwise the visible label stands as the name.
  const nameOf = useMemo(() => {
    const labels = new Map<string, number>();
    const pairs = new Map<string, number>();
    const pair = (p: Prompt, a: PromptAction) => `${a.label}\n${p.title}`;
    const bump = (counts: Map<string, number>, key: string) =>
      counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const p of ordered) {
      for (const a of p.actions) {
        bump(labels, a.label);
        bump(pairs, pair(p, a));
      }
    }
    const base = (p: Prompt, a: PromptAction): string | undefined => {
      if ((labels.get(a.label) ?? 0) < 2) return undefined;
      const named = `${a.label}: ${p.title}`;
      return (pairs.get(pair(p, a)) ?? 0) < 2 ? named : `${named}. ${p.body}`;
    };
    // Two banners can say exactly the same (two meetings of one name that ended together), and
    // then not even the sentence tells their buttons apart: those are numbered in the order shown.
    const uses = new Map<string, number>();
    for (const p of ordered) {
      for (const a of p.actions) {
        const name = base(p, a);
        if (name) bump(uses, name);
      }
    }
    const names = new Map<string, string | undefined>();
    const counted = new Map<string, number>();
    for (const p of ordered) {
      for (const a of p.actions) {
        const name = base(p, a);
        const of = name ? (uses.get(name) ?? 0) : 0;
        if (name && of > 1) {
          bump(counted, name);
          names.set(`${p.id}\n${a.id}`, `${name} (${counted.get(name)} of ${of})`);
        } else {
          names.set(`${p.id}\n${a.id}`, name);
        }
      }
    }
    return (p: Prompt, a: PromptAction): string | undefined => names.get(`${p.id}\n${a.id}`);
  }, [ordered]);

  // Told to a screen reader, which is not shown. Only a banner that arrives after the first list is
  // news: what was waiting when the page opened would be read out again on every load, and a
  // banner whose body counts up (a block left running) is not a new banner each time it does.
  const [announcement, announce, announced] = useExpiring(ANNOUNCEMENT_MS);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!prompts) return;
    const before = known.current;
    known.current = new Set(prompts.map((p) => p.id));
    if (!before) return;
    const arrived = ordered.filter((p) => !before.has(p.id));
    if (arrived.length) announce(`Needs your attention: ${arrived.map((p) => p.title).join('. ')}`);
    // A meeting prompt is worked out from the synced calendar, and the day's meetings on the Today
    // page are read on a slower clock of their own: bring them up to date with the banner, so a
    // meeting that is asked about is on that page too.
    if (arrived.some((p) => p.kind.startsWith('meeting-'))) {
      void qc.invalidateQueries({ queryKey: ['calendar', 'events'] });
    }
  }, [prompts, ordered, announce, qc]);

  // A prompt that is no longer listed has no banner left to show its error on, and one that comes
  // back must not come back with the error it had.
  useEffect(() => {
    if (!prompts) return;
    const listed = new Set(prompts.map((p) => p.id));
    setErrors((current) => {
      const kept = Object.entries(current).filter(([id]) => listed.has(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [prompts]);

  // Folded again once there is nothing to fold away, so the next time there is it starts folded.
  useEffect(() => {
    if (ordered.length <= SHOWN) setExpanded(false);
  }, [ordered.length]);

  // When the button an answer was given with goes (the banner is answered, or no longer offers
  // that answer), the browser drops focus on the page, and a keyboard user starts again from the
  // top. It goes to the banner now where that one was, else the closest above it, else the
  // heading. An answer that was refused leaves its button in place and focus on it. This runs
  // after every draw, since the draw that removes the button is not the one that set the note
  // the heading may be waiting on; it does nothing until the button is gone.
  useEffect(() => {
    const intent = focusAfter.current;
    if (!intent) return;
    const focused = document.activeElement;
    if (intent.button.isConnected) {
      if (focused !== intent.button) focusAfter.current = null;
      return;
    }
    if (focused && focused !== document.body) {
      focusAfter.current = null;
      return;
    }
    const same = ordered.find((p) => p.id === intent.id);
    const next = same ?? ordered[Math.min(intent.at, ordered.length - 1)];
    const target = next ? banners.current.get(next.id)?.querySelector<HTMLElement>('button') : null;
    target?.focus();
    // A banner folded away cannot take focus: the heading can.
    if (document.activeElement !== target) heading.current?.focus();
    if (document.activeElement !== document.body) focusAfter.current = null;
  });

  function answer(prompt: Prompt, action: PromptAction, button: HTMLElement) {
    if (answering.current) return;
    if (action.open) {
      navigate(action.open);
      return;
    }
    answering.current = true;
    say(null);
    setErrors((current) => {
      const next = { ...current };
      delete next[prompt.id];
      return next;
    });
    // Only a keyboard user (or anyone who had focus on it) has focus to look after.
    focusAfter.current =
      document.activeElement === button
        ? { id: prompt.id, at: ordered.findIndex((p) => p.id === prompt.id), button }
        : null;
    act.mutate(
      { id: prompt.id, action: action.id },
      {
        // With nothing left the region stays a moment longer: it is where focus lands, and says so.
        onSuccess: ({ prompts: left }) => {
          if (left.length === 0) say(ALL_CLEAR);
        },
        onError: (err) => {
          const problem = answerProblem(err);
          if (problem.stale) say(ALREADY_ANSWERED);
          else setErrors((current) => ({ ...current, [prompt.id]: problem.text }));
        },
        onSettled: () => {
          answering.current = false;
          setTimeout(() => {
            if (focusAfter.current?.button === button) focusAfter.current = null;
          }, FOCUS_WATCH_MS);
        },
      },
    );
  }

  const folded = ordered.length - SHOWN;
  return (
    <div>
      {/* Always there, so that what is put in it is announced; only what arrives later goes in.
          Each announcement is an element of its own, so a repeat of the last is said again. */}
      <div role="status" className="sr-only">
        <span key={announced}>{announcement}</span>
      </div>
      {ordered.length > 0 || note ? (
        <section
          aria-labelledby={headingId}
          className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6"
        >
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <h2
              id={headingId}
              ref={heading}
              tabIndex={-1}
              className="rounded text-xs font-medium text-ink-2 focus-visible:outline-2
                focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Needs your attention
            </h2>
            {folded > 0 && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? 'Show fewer' : `Show ${folded} more`}
                <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
              </Button>
            )}
          </div>
          {/* Always inside the region while it is shown, so a line put in it is announced. */}
          <div role="status">
            {note && (
              <p
                className="mb-2 rounded-lg border border-hairline bg-raised px-3 py-2 text-xs
                  text-ink-2"
              >
                {note}
              </p>
            )}
          </div>
          {ordered.length > 0 && (
            <ul id={listId} className="flex flex-col gap-2">
              {ordered.map((prompt, at) => (
                <PromptBanner
                  key={prompt.id}
                  prompt={prompt}
                  folded={!expanded && at >= SHOWN}
                  nameOf={nameOf}
                  // One answer at a time: the list that comes back may not have this one in it.
                  busy={act.isPending}
                  working={
                    act.isPending && act.variables?.id === prompt.id ? act.variables.action : null
                  }
                  error={errors[prompt.id]}
                  register={register}
                  onAnswer={(action, button) => answer(prompt, action, button)}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function PromptBanner({
  prompt,
  folded,
  nameOf,
  busy,
  working,
  error,
  register,
  onAnswer,
}: {
  prompt: Prompt;
  /** Out of sight behind "Show N more". Still listed, so what it controls exists. */
  folded: boolean;
  /** What a button is called when its label alone would not say which banner it is on. */
  nameOf: (prompt: Prompt, action: PromptAction) => string | undefined;
  /** An answer is on its way, to this banner or another. */
  busy: boolean;
  /** The action being sent for this prompt right now, if one is. */
  working: string | null;
  error: string | undefined;
  register: (id: string, el: HTMLElement | null) => void;
  onAnswer: (action: PromptAction, button: HTMLElement) => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <li hidden={folded}>
      {/* A group named by its headline and described by its sentence, so a button, or the group
          itself, is heard with the banner it is on: two away stretches can have one headline. */}
      <div
        ref={(el) => register(prompt.id, el)}
        role="group"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={working != null}
        className="flex flex-col gap-2 rounded-xl border border-l-4 border-hairline border-l-accent
          bg-surface px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]
          sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="min-w-0 flex-1">
          <p id={titleId} className="break-words text-sm font-medium text-ink">
            {prompt.title}
          </p>
          <p id={bodyId} className="break-words text-xs text-ink-2">
            {prompt.body}
          </p>
          {error && (
            <p role="alert" className={`mt-1 text-xs ${errorText}`}>
              {error}
            </p>
          )}
        </div>
        {/* Labels wrap inside the banner, however long a project's name is that one carries. */}
        <div className="flex min-w-0 flex-wrap gap-1.5 sm:max-w-[60%] sm:shrink-0 sm:justify-end">
          {prompt.actions.map((action) => {
            const sending = working === action.id;
            return (
              <Button
                key={action.id}
                size="sm"
                variant={action.primary ? 'primary' : 'default'}
                // Not disabled: a button that is disabled cannot keep focus, which would fall to
                // the page. The press is ignored by the guard instead.
                aria-disabled={busy || undefined}
                // While it is sending, its name is what it shows.
                aria-label={sending ? undefined : nameOf(prompt, action)}
                // The ones that are waiting are dimmed; the one being sent says so in words.
                className={`h-auto! min-h-7 max-w-full py-1 [overflow-wrap:anywhere]
                  aria-disabled:cursor-progress ${sending ? '' : 'aria-disabled:opacity-60'}
                  ${action.primary ? PRIMARY_FILL : ''}`}
                onClick={(e) => onAnswer(action, e.currentTarget)}
              >
                {sending ? 'Working…' : action.label}
              </Button>
            );
          })}
        </div>
      </div>
    </li>
  );
}
