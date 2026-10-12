import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { reason, type TaskStatus } from '../api';
import { timeOfDay } from '../lib/format';
import { Button, Card, inputClass } from './ui';

/* ------------------------------------------------------------------ the way in */

/**
 * A link that looks like a small button: the way into the wrap-up from the Today and
 * Review headers. It is an <a> because it goes somewhere, and the arrow says so.
 */
export function WrapUpLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg border
        border-hairline bg-raised px-2.5 text-xs font-medium text-ink transition-colors
        hover:border-axis focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-accent"
    >
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

/* ------------------------------------------------------------------- the notes */

/**
 * The text in a note box. It starts as the saved note and follows the server when that
 * changes underneath it (another window saved, or the reply to this one's own save
 * landed), but never over something typed since: a draft that has moved on is the
 * person's, not the cache's.
 */
export function useDraft(saved: string | null): [string, (text: string) => void] {
  const [draft, setDraft] = useState(saved ?? '');
  const seen = useRef(saved);
  useEffect(() => {
    const was = seen.current ?? '';
    seen.current = saved;
    setDraft((now) => (now.trim() === was ? (saved ?? '') : now));
  }, [saved]);
  return [draft, setDraft];
}

/**
 * A note that saves itself: when the box loses focus, or on Enter in a one-line one (Ctrl or
 * Cmd+Enter in a longer one). The keys save and leave the focus where it is: making the box
 * lose it to save would drop the focus on the page, and the next Tab would start again from
 * the top, in the sidebar. It says where it stands (not saved yet, saving, saved) in words,
 * so nobody has to wonder whether what they typed went anywhere. What is kept is the trimmed
 * text, and an empty box clears the note. The draft is the parent's, so the summary beside
 * it can show it.
 */
export function NoteField({
  label,
  placeholder,
  draft,
  onDraft,
  saved,
  onSave,
  multiline = false,
}: {
  /** The box's accessible name: its card says what it is for, but a screen reader needs it on the box. */
  label: string;
  placeholder?: string;
  draft: string;
  onDraft: (text: string) => void;
  /** The note as the server has it. */
  saved: string | null;
  /** Resolves once it is saved, rejects with why not. Null clears the note. */
  onSave: (note: string | null) => Promise<unknown>;
  multiline?: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Only the latest save may say how it went: a slow one must not overwrite a newer answer.
  const latest = useRef(0);
  const text = draft.trim();
  const dirty = text !== (saved ?? '');

  async function commit() {
    if (!dirty) return;
    const mine = ++latest.current;
    setPhase('saving');
    setError(null);
    try {
      await onSave(text || null);
      if (mine === latest.current) setPhase('saved');
    } catch (err) {
      if (mine !== latest.current) return;
      setPhase('failed');
      setError(reason(err, 'Could not save the note'));
    }
  }

  // How to save, and where it stands. The line is never empty, so the box does not grow and
  // shrink as it changes, and a note nobody has written yet still says how it will be kept.
  const how = multiline ? 'click away' : 'press Enter or click away';
  const isSaved =
    phase !== 'saving' && phase !== 'failed' && !dirty && (phase === 'saved' || saved != null);
  const status =
    phase === 'saving'
      ? 'Saving…'
      : phase === 'failed'
        ? null
        : dirty
          ? `Not saved yet — ${how} to save`
          : isSaved
            ? '✓ Saved'
            : `Saves when you ${how}`;

  return (
    <div>
      {multiline ? (
        <textarea
          aria-label={label}
          className={`${inputClass} min-h-20 resize-y`}
          placeholder={placeholder}
          maxLength={500}
          rows={3}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            // Enter is a new line here, so the shortcut is the one a chat box uses.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit();
          }}
        />
      ) : (
        <input
          type="text"
          aria-label={label}
          className={inputClass}
          placeholder={placeholder}
          maxLength={500}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            // Not while an input method is composing a character: that Enter belongs to it.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commit();
          }}
        />
      )}
      <div className="mt-1.5 min-h-4 text-[11px]">
        <span role="status" className={isSaved ? 'font-medium text-good' : 'text-muted'}>
          {status}
        </span>
        {error && (
          <span role="alert" className="text-critical">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- the summary */

type Copied = 'idle' | 'copied' | 'selected';

/**
 * The summary, as the text that will be pasted, and the button that copies it. Where the
 * clipboard cannot be written to (a page that is not a secure context has none, and a
 * browser may refuse it) the text is selected instead and the person is told to copy it
 * themselves, so the button never just does nothing.
 */
export function SummaryCard({ text }: { text: string }) {
  const body = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<Copied>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function selectText() {
    const el = body.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    let result: Copied = 'copied';
    try {
      if (!navigator.clipboard) throw new Error('No clipboard here');
      await navigator.clipboard.writeText(text);
    } catch {
      selectText();
      result = 'selected';
    }
    setCopied(result);
    window.clearTimeout(timer.current);
    // The fallback stays up longer: there is a key to press before it is of any use.
    timer.current = window.setTimeout(() => setCopied('idle'), result === 'copied' ? 2500 : 10000);
  }

  return (
    <Card
      title="Summary"
      subtitle="Plain text, ready to paste into Slack"
      action={
        <div className="flex items-center">
          {/* Always there, so a screen reader is listening when its words change. */}
          <span
            role="status"
            className={`text-xs font-medium text-good ${copied === 'copied' ? 'mr-2' : ''}`}
          >
            {copied === 'copied' ? '✓ Copied' : ''}
          </span>
          <Button size="sm" variant="primary" onClick={() => void copy()}>
            Copy summary
          </Button>
        </div>
      }
    >
      {/* Focusable, so the keyboard can scroll and select it; a group, because a bare <pre> may not carry a name. */}
      <pre
        ref={body}
        role="group"
        aria-label="Summary text"
        tabIndex={0}
        className="whitespace-pre-wrap break-words rounded-lg border border-hairline bg-raised
          px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2 focus-visible:outline-2
          focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {text}
      </pre>
      {copied === 'selected' && (
        <p role="status" className="mt-2 text-xs text-ink-2">
          The clipboard is not available here, so the summary is selected: press Ctrl+C (⌘C on a
          Mac) to copy it.
        </p>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------- done */

/** "Mon, Oct 12 at 5:42 PM": the day is there because a wrap-up can be done the next morning. */
function stampText(iso: string): string {
  const day = new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} at ${timeOfDay(iso)}`;
}

/**
 * The last step: the button that closes the day or the week, and, once it has, when. The
 * button stays on the page, pressed, rather than going away: the stamp is the record, and
 * seeing it beside the button is how you know it took.
 */
export function DoneBar({
  button,
  hint,
  doneWord,
  stamp,
  pending,
  error,
  onDone,
}: {
  button: string;
  /** What pressing it does, until it has been pressed. */
  hint: string;
  /** "Wrapped up" or "Reviewed", ahead of the time. */
  doneWord: string;
  /** When it was done, or null if it has not been. */
  stamp: string | null;
  pending: boolean;
  error: string | null;
  onDone: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {stamp ? `${doneWord} ${stampText(stamp)}` : hint}
          </p>
          {error && (
            <p role="alert" className="mt-0.5 text-xs text-critical">
              {error}
            </p>
          )}
        </div>
        <Button variant="primary" disabled={stamp != null || pending} onClick={onDone}>
          {pending ? 'Saving…' : stamp ? `${button} ✓` : button}
        </Button>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------------- status */

/** In the order a task moves through them. */
export const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'held_up', label: 'Held up' },
  { value: 'completed', label: 'Completed' },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskStatus,
  string
>;

/**
 * Each status is tinted from the app's own tokens, as on the Tasks tab, and always carries
 * its text label: the tint helps you scan a column, it never says anything alone.
 */
const STATUS_TONE: Record<TaskStatus, string> = {
  not_started: 'border-hairline bg-raised text-ink-2',
  in_progress: 'border-accent/40 bg-accent/10 text-ink',
  held_up: 'border-warning/50 bg-warning/15 text-ink',
  completed: 'border-good/40 bg-good/10 text-ink',
};

/** A status to read, not to change. */
export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The Tasks tab's status menu: a pill that is also the select. */
export function StatusSelect({
  title,
  status,
  onChange,
}: {
  title: string;
  status: TaskStatus;
  onChange: (status: TaskStatus) => void;
}) {
  return (
    <span className="relative inline-block">
      <select
        aria-label={`Status of ${title}`}
        value={status}
        onChange={(e) => onChange(e.target.value as TaskStatus)}
        className={`cursor-pointer appearance-none rounded-full border py-1 pl-2.5 pr-6 text-xs
          font-medium focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-accent ${STATUS_TONE[status]}`}
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-2 top-1/2 size-2.5 -translate-y-1/2 text-ink-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
