import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, reason, type Settings } from '../../api';
import { keys, useSettings } from '../../hooks';
import { isMac } from '../../lib/platform';
import { formatShortcut, recordKeyPress, sameShortcut, type KeyLayout } from '../../lib/shortcut';
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

/** What the desktop app says of the three shortcuts after registering them. */
type HotkeyReply = Awaited<ReturnType<FocusdeskBridge['reloadHotkeys']>>;

/**
 * What a row says under its buttons: how it stands, or why a change was not made. A note that
 * `fades` has said its piece and goes after a few seconds; how a shortcut stands stays.
 */
type Note = { tone: 'good' | 'bad' | 'plain'; text: string; fades?: boolean };
type Notes = Partial<Record<Key, Note>>;

/** How long "Saved." stays up. */
const SAVED_MS = 4_000;

/** What a row says while it waits for a key, and, after it, what cannot be done. */
const PROMPT = 'Press the new shortcut — Esc to cancel.';
const PROMPT_NOTE = "A key that another app is using can't be recorded here.";

/**
 * The longest a row waits for a key. The desktop app gives its shortcuts back by itself after a
 * minute (see suspendHotkeys), and from then on a key it holds would run its action and not be
 * recorded, so the row stops listening before that and does not go on saying that it hears.
 */
const LISTEN_MS = 50_000;

/** The part of the Keyboard API that the recorder asks for. Chromium has it; other browsers do not. */
type NavigatorWithKeyboard = Navigator & {
  keyboard?: { getLayoutMap?: () => Promise<KeyLayout> };
};

/**
 * Ask the desktop app to let go of the shortcuts that work in any app (true) or to take them again
 * (false). Never rejects and does nothing in a browser, which has no such app: the recorder works
 * without it, only a key the app holds is then not heard.
 */
async function letGoOfShortcuts(on: boolean): Promise<void> {
  try {
    await window.focusdesk?.suspendHotkeys?.(on);
  } catch {
    // The app takes them back by itself (see suspendHotkeys). There is nothing to do about it here.
  }
}

/**
 * What this keyboard types, key by key, or null when the browser cannot say (only Chromium has the
 * Keyboard API, and only in a secure context, which http://127.0.0.1 is) or will not. Never
 * rejects, and never throws.
 */
async function readKeyLayout(): Promise<KeyLayout | null> {
  try {
    return (await (navigator as NavigatorWithKeyboard).keyboard?.getLayoutMap?.()) ?? null;
  } catch {
    return null;
  }
}

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

  /**
   * Ask the desktop app to read the three settings again, and say how each one stands. Resolves
   * to what it said, or null when there is no desktop app or it did not answer.
   */
  async function reload() {
    if (typeof window.focusdesk?.reloadHotkeys !== 'function') return null;
    try {
      const result = await window.focusdesk.reloadHotkeys();
      setAppError(null);
      const next: Notes = {};
      for (const row of ROWS) {
        const note = standing(result[row.status]);
        if (note) next[row.key] = note;
      }
      setNotes(next);
      return result;
    } catch (err) {
      setAppError(
        `The desktop app did not say which shortcuts are active (${reason(err, 'no answer')}).`,
      );
      return null;
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
    // What it was a moment ago, as the cache has it now and not as this render did: the key
    // handler that calls this was made when listening began, and the settings may have been read
    // again since.
    const before = (qc.getQueryData<Settings>(keys.settings) ?? settings)?.[key] ?? '';
    setListening(null);
    setHint(null);
    setBusy(true);
    setNotes((now) => ({ ...now, [key]: undefined }));
    let saved: string;
    try {
      const updated = await api.updateSettings({ [key]: value });
      qc.setQueryData(keys.settings, updated);
      saved = String(updated[key] ?? value);
    } catch (err) {
      // Nothing was saved, so the row goes on showing the shortcut it had.
      setNotes((now) => ({ ...now, [key]: { tone: 'bad', text: refusal(err, key) } }));
      setBusy(false);
      return;
    }
    if (inApp) await keepWhatWorks(key, before, saved, await reload());
    else setNotes((now) => ({ ...now, [key]: { tone: 'plain', text: 'Saved.', fades: true } }));
    setBusy(false);
  }

  /**
   * What is saved once the desktop app has said it could not register what was just saved. It goes
   * on with the shortcut it had (or none), and the setting is put back to that, so that what is
   * saved is what works and the next start of the app does not try the key that was refused and
   * end up with none. Three things leave it as it was saved:
   *
   *   - The desktop app could not read the settings (code 'unreadable'): it tried nothing, and
   *     what it says of the shortcut is not about this key.
   *   - It has the shortcut that was saved: there is nothing to put back.
   *   - It has no shortcut, and the one saved before was not off. "None" then does not mean that
   *     the shortcut was off: its key may merely not have been had when the app started (another
   *     app held it), and writing off back would turn a shortcut off that the person never did.
   *     The new one stays saved, and the note says that it could not be registered.
   *
   * Only a shortcut that was off stays off.
   */
  async function keepWhatWorks(key: Key, before: string, saved: string, result: HotkeyReply | null) {
    const row = ROWS.find((r) => r.key === key);
    const status = row && result?.[row.status];
    if (!status || status.ok || status.code === 'unreadable') return;
    const working = status.accelerator ?? '';
    if (working !== '' && saved !== '' && sameShortcut(working, saved, mac)) return;
    if (working === '' && before !== '') {
      const said = status.error ?? 'It could not be registered.';
      const text = `${said} It stays saved, and FocusDesk tries it again when the app starts.`;
      setNotes((now) => ({ ...now, [key]: { tone: 'bad', text } }));
      return;
    }
    try {
      qc.setQueryData(keys.settings, await api.updateSettings({ [key]: working }));
    } catch {
      // The note already says it could not be registered; the setting stays as it was saved.
      return;
    }
    // The app is told what is saved now: it still goes by the one that was refused, and so does the
    // menu bar, which says when a shortcut is not working. The note is put up after, since
    // reading them again puts up each row's own.
    await reload();
    const kept = working ? `Kept ${formatShortcut(working)}.` : 'It stays off.';
    const text = `${status.error ?? ''} ${kept}`.trim();
    setNotes((now) => ({ ...now, [key]: { tone: 'bad', text } }));
  }

  // Whether any row is waiting for a key. What has to be so for as long as one is (the shortcuts
  // let go of, the layout known, a limit on the wait) is per recording and not per row: moving
  // from one row to another is the same recording.
  const recording = listening !== null;

  // The desktop app holds the three shortcuts for every app, and a key it holds never reaches this
  // page: its action runs, and the recorder hears nothing (Ctrl+Shift+Space would pause the block
  // on the clock, and the quick-switch key would open the box over the card). So the app is asked
  // to let go of them for as long as a row listens, and to take them again when it stops, whichever
  // way that comes about: a key recorded, Esc, a click elsewhere, the window losing the focus, the
  // card going away. The app also takes them back by itself if this page cannot say so (the page
  // crashes, is reloaded, or the window is left), and after a minute at most.
  useEffect(() => {
    if (!recording) return;
    void letGoOfShortcuts(true);
    return () => void letGoOfShortcuts(false);
  }, [recording]);

  // Off a Mac a shortcut is registered by what the key types on this keyboard and not by where the
  // key is (on a French keyboard A is where Q is), so the recorder is told the layout, asked for
  // when a row starts listening. Chromium has it; a browser that does not simply records keys by
  // their position, and so does a Mac, which registers by position.
  const layout = useRef<KeyLayout | null>(null);
  useEffect(() => {
    layout.current = null;
    if (!recording || mac) return;
    let wanted = true;
    void readKeyLayout().then((map) => {
      if (wanted) layout.current = map;
    });
    return () => {
      wanted = false;
      layout.current = null;
    };
  }, [recording, mac]);

  // A row does not wait for ever: the app gives its shortcuts back after a minute, so the row stops
  // before that and does not go on saying that it hears.
  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(() => {
      setListening(null);
      setHint(null);
    }, LISTEN_MS);
    return () => clearTimeout(timer);
  }, [recording]);

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
      const heard = recordKeyPress(e, mac, layout.current);
      switch (heard.kind) {
        case 'waiting':
          break;
        case 'cancel':
          stop();
          break;
        case 'unusable':
        case 'too-loose':
        case 'reserved':
          setHint(heard.hint);
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
                    <span className="font-medium text-ink">{PROMPT}</span> {PROMPT_NOTE}
                    {hint && ` ${hint}`}
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
