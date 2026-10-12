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
 */
export function InterruptionChooser({
  onChoose,
}: {
  onChoose: (reason: InterruptionReason | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // What a screen reader is told once one is picked. The count on the screen changes, and
  // nothing says so aloud.
  const [said, setSaid] = useState('');
  const menuId = useId();
  const headingId = useId();
  // Holds the button and its list and draws no box of its own, so the row's layout and the
  // list's placement against the row are as if it were not there. Button hands out no ref, so
  // the button is found in here.
  const root = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const trigger = () => root.current?.querySelector('button');
  const choices = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // The first reason is focused as it opens: a keyboard user is already in the list. On a short
  // screen the list can open below the fold, so the whole of it is brought into view too.
  useEffect(() => {
    if (!open) return;
    choices()[0]?.focus();
    menu.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(reason: InterruptionReason | null, label: string) {
    setOpen(false);
    setSaid(`Logged an interruption: ${label}`);
    // The list is gone and the focus with it: it goes back to the button, so the next key
    // press is made from where it was before.
    trigger()?.focus();
    onChoose(reason);
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
    else if (e.key === 'ArrowDown' && !open) {
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        title="Log a distraction without stopping the clock"
      >
        Got interrupted
      </Button>
      <span role="status" className="sr-only">
        {said}
      </span>
      {open && (
        <div
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
