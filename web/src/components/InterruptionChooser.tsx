import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { INTERRUPTION_REASONS, type InterruptionReason } from '../lib/interruptions';
import { Button } from './ui';

// A minimum height and not a fixed one: on a narrow screen "Someone stopped by" wraps, and a
// label of two lines has to be able to make its box taller instead of being squeezed into it.
const ITEM =
  'flex min-h-9 w-full items-center rounded-lg border border-hairline bg-raised px-2.5 py-1.5 ' +
  'text-left text-sm leading-tight text-ink transition-colors hover:border-accent ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * "Got interrupted", with what it was one tap away. The button opens a short list of the
 * reasons and "No reason"; choosing one logs it and closes the list, so naming it costs one
 * more tap and no typing, and the clock is never stopped for it. "No reason" is there so a
 * hurried tap is still logged, and counts as an interruption with nothing said about it.
 *
 * A menu, so the keyboard works the way one does: the button opens it (Enter, Space or the
 * down arrow) with the first reason focused, the arrows, Home and End move between the
 * choices, Enter or Space picks one, Escape closes it and gives the focus back to the button,
 * and Tab leaves it. A click anywhere else closes it too.
 *
 * It sits in a row of buttons and puts its list under that row, against the row's own width,
 * which has to be `relative`: wherever a narrow screen wraps this button to, the list stays
 * inside the card and the page never scrolls sideways for it.
 *
 * On a break there is nothing to ask: reasons are only ever read for focus blocks, so a
 * choice made there would go nowhere. `askReason` is false for it, and the button logs the
 * interruption with a tap and no list.
 */
export function InterruptionChooser({
  onChoose,
  askReason = true,
}: {
  /** Logs it. Settles when the interruption is written and rejects if it could not be. */
  onChoose: (reason: InterruptionReason | null) => Promise<unknown>;
  askReason?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // What a screen reader is told once one is logged. The count on the screen changes, and
  // nothing says so aloud. The count makes a new node each time, as on the Tasks page: the
  // same words said twice in a row would otherwise change nothing in the page, and so be
  // announced only once.
  const [said, setSaid] = useState({ text: '', count: 0 });
  const menuId = useId();
  const headingId = useId();
  // Holds the button and its list and draws no box of its own, so the row's layout and the
  // list's placement against the row are as if it were not there. Button hands out no ref, so
  // the button is found in here.
  const root = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const trigger = () => root.current?.querySelector('button');
  const choices = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // The first reason is focused as it opens: a keyboard user is already in the list. On a short
  // screen the list can open below the fold, so the whole of it is brought into view too: the
  // frame round it, and not only the list inside, or its padding and border (9px of them) are
  // left below the edge of the screen.
  useEffect(() => {
    if (!open) return;
    choices()[0]?.focus();
    frame.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function log(reason: InterruptionReason | null, label: string | null) {
    // Said once it is written, not when it is asked for: said first, it would be wrong whenever
    // the request fails. A failure is not said here at all, the screen shows it in an alert.
    onChoose(reason).then(
      () =>
        setSaid((s) => ({
          text: `Logged an interruption${label ? `: ${label}` : ''}`,
          count: s.count + 1,
        })),
      () => {},
    );
  }

  function choose(reason: InterruptionReason | null, label: string) {
    setOpen(false);
    // The list is gone and the focus with it: it goes back to the button, so the next key
    // press is made from where it was before.
    trigger()?.focus();
    log(reason, label);
  }

  function onEscape(e: KeyboardEvent) {
    // Anything listening on the document for Escape (a dialog) is not meant to hear this one.
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    trigger()?.focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape' && open) onEscape(e);
    else if (e.key === 'ArrowDown' && !open && askReason) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') return onEscape(e);
    // Focus moves on, and the list is closed behind it.
    if (e.key === 'Tab') return setOpen(false);
    const list = choices();
    const at = list.findIndex((el) => el === document.activeElement);
    const to =
      e.key === 'ArrowDown'
        ? (at + 1) % list.length
        : e.key === 'ArrowUp'
          ? (at - 1 + list.length) % list.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? list.length - 1
              : null;
    if (to == null) return;
    e.preventDefault();
    list[to]?.focus();
  }

  return (
    <span ref={root} className="contents">
      <Button
        aria-haspopup={askReason ? 'menu' : undefined}
        aria-expanded={askReason ? open : undefined}
        aria-controls={askReason && open ? menuId : undefined}
        onClick={() => (askReason ? setOpen((v) => !v) : log(null, null))}
        onKeyDown={onTriggerKeyDown}
        title="Log a distraction without stopping the clock"
      >
        Got interrupted
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        <span key={said.count}>{said.text}</span>
      </span>
      {open && (
        <div
          ref={frame}
          className="absolute left-1/2 top-full z-20 mt-2 w-[22rem] max-w-full -translate-x-1/2
            rounded-xl border border-hairline bg-surface p-2 shadow-lg"
        >
          <p id={headingId} className="px-1 pb-1.5 text-[11px] font-medium text-muted">
            What pulled you away?
          </p>
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={headingId}
            onKeyDown={onMenuKeyDown}
            className="grid grid-cols-2 gap-1.5"
          >
            {INTERRUPTION_REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="menuitem"
                onClick={() => choose(r.key, r.label)}
                className={ITEM}
              >
                {r.label}
              </button>
            ))}
            {/* Dashed and last: the way out that says nothing, apart from the named reasons. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(null, 'no reason')}
              className={`${ITEM} col-span-2 border-dashed text-ink-2`}
            >
              No reason
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
