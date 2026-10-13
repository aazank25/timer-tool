import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { isMac } from '../../lib/platform';
import { formatShortcut, recordKeyPress, sameShortcut } from '../../lib/shortcut';
import { errorText } from '../../lib/tone';
import { Button, Card } from '../ui';

type Key = 'show_hotkey' | 'pause_hotkey' | 'quick_switch_hotkey';

/** The three shortcuts, top to bottom, as the card lists them. */
const ROWS: {
  key: Key;
  /** Where the desktop app reports this one when it is asked to read the settings again. */
  status: 'show' | 'pause' | 'quickSwitch';
  label: string;
  about: string;
  /** What it is until it is changed, as the server ships it (DEFAULT_SETTINGS in server/src/db.ts). */
  fallback: string;
}[] = [
  {
    key: 'show_hotkey',
    status: 'show',
    label: 'Show FocusDesk',
    about: 'Brings the window to the front.',
    fallback: 'CommandOrControl+Shift+F',
  },
  {
    key: 'pause_hotkey',
    status: 'pause',
    label: 'Pause or resume',
    about: 'Pauses the block on the clock, or picks it up again.',
    fallback: 'CommandOrControl+Shift+Space',
  },
  {
    key: 'quick_switch_hotkey',
    status: 'quickSwitch',
    label: 'Quick switch',
    about:
      'A small box over whatever you are doing. Type a few letters of a task or saved timer and press Enter: the block on the clock stops and the new one starts.',
    fallback: 'CommandOrControl+Alt+K',
  },
];

/**
 * What a row says under its buttons: how it stands, or why a change was not made. A note that
 * `fades` has said its piece and goes after a few seconds; how a shortcut stands stays.
 */
type Note = { tone: 'good' | 'bad' | 'plain'; text: string; fades?: boolean };
type Notes = Partial<Record<Key, Note>>;

/** How long "Saved." stays up. */
const SAVED_MS = 4_000;

const PROMPT = 'Press the new shortcut — Esc to cancel';

/** How the desktop app says one shortcut stands, in the words of the card. */
function standing(status: HotkeyStatus | undefined): Note | undefined {
  if (!status) return undefined;
  if (!status.ok) return { tone: 'bad', text: status.error ?? 'It could not be registered.' };
  return status.accelerator ? { tone: 'good', text: 'Active' } : { tone: 'plain', text: 'Off' };
}

/**
 * Why the server refused a shortcut, in its own words. Something that is not a shortcut comes
 * back as "Invalid request" with the reason under the field, which is the part worth showing;
 * a shortcut that another action has comes back as the sentence itself.
 */
function refusal(err: unknown, key: Key): string {
  if (err instanceof ApiError) {
    const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)
      ?.fieldErrors;
    const said = fields?.[key]?.[0];
    if (said) return said;
  }
  return reason(err, 'Could not save the shortcut');
}

/**
 * The key that was just recorded comes up after the recording is over, and on a button in
 * Firefox a Space coming up is a click even when its going down was cancelled. So the next
 * time that key comes up, it is swallowed.
 */
function swallowKeyUp(code: string) {
  const stop = () => {
    document.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', stop);
  };
  const onUp = (e: KeyboardEvent) => {
    if (e.code !== code) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  document.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', stop);
}

/**
 * The three shortcuts that work from any app: show the window, pause or resume, and quick
 * switch. A shortcut is recorded by pressing it and saved the moment it is pressed, and the
 * desktop app is then asked to register it, so the card can say whether it took. Self-contained:
 * it saves only its own settings, one at a time.
 */
export function ShortcutSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const mac = isMac();
  // Only the desktop app can hold a shortcut that works in other apps. A browser tab can still
  // edit them, since they are only settings.
  const inApp = typeof window.focusdesk?.reloadHotkeys === 'function';
  // The row that is waiting for a key press, if any. One at a time.
  const [listening, setListening] = useState<Key | null>(null);
  // What the recorder says while it waits: a key that was pressed and cannot be used.
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Notes>({});
  const [appError, setAppError] = useState<string | null>(null);
  const loading = settings === undefined;

  /** Ask the desktop app to read the three settings again, and say how each one stands. */
  async function reload() {
    if (typeof window.focusdesk?.reloadHotkeys !== 'function') return;
    try {
      const result = await window.focusdesk.reloadHotkeys();
      setAppError(null);
      const next: Notes = {};
      for (const row of ROWS) {
        const note = standing(result[row.status]);
        if (note) next[row.key] = note;
      }
      setNotes(next);
    } catch (err) {
      setAppError(
        `The desktop app did not say which shortcuts are active (${reason(err, 'no answer')}).`,
      );
    }
  }

  // Shown when the card opens too, so a shortcut that never took (another app had it) is not a
  // silent failure. Reading the settings again changes nothing for one that is registered.
  useEffect(() => {
    void reload();
  }, []);

  // "Saved." goes by itself. Nothing is left to say once it is read.
  useEffect(() => {
    if (!ROWS.some((row) => notes[row.key]?.fades)) return;
    const timer = setTimeout(() => {
      setNotes((now) => {
        const kept: Notes = {};
        for (const row of ROWS) {
          const note = now[row.key];
          if (note && !note.fades) kept[row.key] = note;
        }
        return kept;
      });
    }, SAVED_MS);
    return () => clearTimeout(timer);
  }, [notes]);

  /** Save one shortcut ('' is off), then, in the desktop app, see whether it took. */
  async function save(key: Key, value: string) {
    setListening(null);
    setHint(null);
    setBusy(true);
    setNotes((now) => ({ ...now, [key]: undefined }));
    try {
      qc.setQueryData(keys.settings, await api.updateSettings({ [key]: value }));
    } catch (err) {
      // Nothing was saved, so the row goes on showing the shortcut it had.
      setNotes((now) => ({ ...now, [key]: { tone: 'bad', text: refusal(err, key) } }));
      setBusy(false);
      return;
    }
    if (inApp) await reload();
    else setNotes((now) => ({ ...now, [key]: { tone: 'plain', text: 'Saved.', fades: true } }));
    setBusy(false);
  }

  // While a row is listening every key press is the recorder's: none of them reaches the page.
  // It stops by itself on a click elsewhere or when the window loses the focus, so it cannot be
  // left listening with nobody there.
  useEffect(() => {
    if (listening === null) return;
    const key = listening;
    const stop = () => {
      setListening(null);
      setHint(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A key pressed to compose text in an input method is not a shortcut.
      if (e.isComposing || e.keyCode === 229) return;
      // Tab would move the focus, and ⌘S would save the page.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const heard = recordKeyPress(e, mac);
      switch (heard.kind) {
        case 'waiting':
          break;
        case 'cancel':
          stop();
          break;
        case 'unusable':
          setHint(
            'That key cannot be part of a shortcut. Try a letter, a number, an F key, Space or an arrow',
          );
          break;
        case 'too-loose':
          setHint(
            `Hold ${mac ? '⌘ or ⌃' : 'Ctrl'} as well, or the shortcut would take that key away from every app (F1–F24 can go with Shift or Alt alone)`,
          );
          break;
        case 'shortcut':
          swallowKeyUp(e.code);
          void save(key, heard.accelerator);
          break;
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      // The button that turns listening on and off does it itself.
      if (e.target instanceof Element && e.target.closest('[data-listening-toggle]')) return;
      stop();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', stop);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', stop);
    };
  }, [listening, mac]);

  const windowKey = mac ? '⌘K' : 'Ctrl+K';

  return (
    <Card title="Keyboard shortcuts" subtitle="Press these from any app while FocusDesk is running.">
      {!inApp && (
        <p className="mb-3 rounded-lg border border-hairline bg-raised px-3 py-2 text-xs text-ink-2">
          Shortcuts work in the FocusDesk desktop app, not in a browser tab. You can still set them
          here.
        </p>
      )}

      <ul className="divide-y divide-hairline">
        {ROWS.map((row) => {
          const value = settings?.[row.key] ?? '';
          const on = value !== '';
          const isListening = listening === row.key;
          const note = notes[row.key];
          const said = isListening ? PROMPT : note?.text;
          // Reset is for a shortcut that has been changed. It keeps its place when it is not
          // wanted (hidden, not removed), so the buttons stay in line from one row to the next.
          const resettable = on && !sameShortcut(value, row.fallback, mac);
          return (
            <li key={row.key} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-ink">{row.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{row.about}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <kbd
                    className={`inline-flex items-center justify-center rounded-lg border bg-raised px-2.5 py-1 font-sans text-sm text-ink ${
                      mac ? 'min-w-28' : 'min-w-56'
                    } ${isListening ? 'border-accent ring-2 ring-accent/30' : 'border-hairline'}`}
                  >
                    {loading ? '…' : on ? formatShortcut(value) : <span className="text-muted">Off</span>}
                  </kbd>
                  <Button
                    size="sm"
                    variant={isListening ? 'primary' : 'default'}
                    data-listening-toggle=""
                    disabled={busy || loading}
                    aria-label={`${isListening ? 'Cancel changing' : 'Change'} the ${row.label} shortcut`}
                    onClick={() => {
                      setHint(null);
                      setListening(isListening ? null : row.key);
                    }}
                  >
                    {isListening ? 'Cancel' : 'Change'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || loading}
                    aria-label={`Turn ${on ? 'off' : 'on'} the ${row.label} shortcut`}
                    onClick={() => void save(row.key, on ? '' : row.fallback)}
                  >
                    {on ? 'Turn off' : 'Turn on'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || loading}
                    aria-label={`Reset the ${row.label} shortcut to its default`}
                    className={resettable ? '' : 'invisible max-sm:hidden'}
                    onClick={() => void save(row.key, row.fallback)}
                  >
                    Reset
                  </Button>
                </div>
              </div>
              {/*
                Always there, so that what is put in it is read out: the prompt, then how it went.
                In the app it always has something to say (Active, Off, or why not), so its line is
                kept; in a browser it has nothing until a shortcut is changed, and takes no room.
              */}
              <p
                role="status"
                aria-live="polite"
                className={`text-xs ${inApp || said ? 'mt-1.5' : ''} ${inApp ? 'min-h-4' : ''} ${
                  !isListening && note?.tone === 'bad'
                    ? errorText
                    : !isListening && note?.tone === 'good'
                      ? 'text-good-ink'
                      : 'text-ink-2'
                }`}
              >
                {isListening ? (
                  <>
                    <span className="font-medium text-ink">{PROMPT}</span>
                    {hint && `. ${hint}.`}
                  </>
                ) : (
                  said
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {appError && (
        <p role="alert" className={`mt-3 text-xs ${errorText}`}>
          {appError}
        </p>
      )}

      <div className="mt-4 space-y-1.5 border-t border-hairline pt-3">
        <p className="text-xs text-ink-2">
          Inside the FocusDesk window, <span className="font-medium text-ink">{windowKey}</span>{' '}
          opens quick switch. That key is fixed, and only works in the window.
        </p>
        <p className="text-[11px] text-muted">
          A shortcut set above is taken from every app while FocusDesk is running, so making{' '}
          {windowKey} one would stop {windowKey} working in Slack or the browser. Each needs{' '}
          {mac ? '⌘ or ⌃' : 'Ctrl'} as well as a key (F1–F24 can go with Shift or Alt alone).
        </p>
      </div>
    </Card>
  );
}
