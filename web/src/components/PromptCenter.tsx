import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { reason } from '../api';
import { useActOnPrompt, usePrompts, type Prompt, type PromptAction } from '../prompts';
import { Button } from './ui';

/**
 * What needs your attention, as banners under the clock on every page: time you were away,
 * a block left running, a meeting that has started or ended. Oldest first, because the one
 * that has waited longest is the one most likely to be stale. An answer that opens a page
 * goes there; any other is sent to the server, which says what is left.
 */
export function PromptCenter() {
  const { data: prompts } = usePrompts();
  const act = useActOnPrompt();
  const navigate = useNavigate();
  // Why the last answer to each prompt was refused, shown on that prompt.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function answer(prompt: Prompt, action: PromptAction) {
    if (action.open) {
      navigate(action.open);
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[prompt.id];
      return next;
    });
    act.mutate(
      { id: prompt.id, action: action.id },
      {
        onError: (err) =>
          setErrors((current) => ({ ...current, [prompt.id]: reason(err, 'Could not do that') })),
      },
    );
  }

  // The wrapper is always there, empty or not, so that a banner which arrives while you are
  // looking at something else is announced when it is added to it. Only additions: the body
  // of a long-block banner counts up as the block runs and must not be read out again.
  return (
    <div aria-live="polite" aria-relevant="additions">
      {prompts?.length ? (
        <section
          aria-label="Needs your attention"
          className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6"
        >
          <ul className="space-y-2">
            {prompts.map((prompt) => (
              <PromptBanner
                key={prompt.id}
                prompt={prompt}
                // One answer at a time: the list that comes back may not have this one in it.
                disabled={act.isPending}
                working={
                  act.isPending && act.variables?.id === prompt.id ? act.variables.action : null
                }
                error={errors[prompt.id]}
                onAnswer={(action) => answer(prompt, action)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PromptBanner({
  prompt,
  disabled,
  working,
  error,
  onAnswer,
}: {
  prompt: Prompt;
  disabled: boolean;
  /** The action being sent for this prompt right now, if one is. */
  working: string | null;
  error: string | undefined;
  onAnswer: (action: PromptAction) => void;
}) {
  const titleId = useId();
  return (
    <li>
      {/* A group named by its headline, so a button's name is heard with the banner it is on. */}
      <div
        role="group"
        aria-labelledby={titleId}
        aria-busy={working != null}
        className="flex flex-col gap-2 rounded-xl border border-l-4 border-hairline border-l-accent
          bg-surface px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]
          sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="min-w-0 flex-1">
          <p id={titleId} className="break-words text-sm font-medium text-ink">
            {prompt.title}
          </p>
          <p className="break-words text-xs text-ink-2">{prompt.body}</p>
          {error && (
            <p role="alert" className="mt-1 text-xs text-critical">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 sm:shrink-0 sm:justify-end">
          {prompt.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.primary ? 'primary' : 'default'}
              disabled={disabled}
              onClick={() => onAnswer(action)}
            >
              {working === action.id ? 'Working…' : action.label}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}
