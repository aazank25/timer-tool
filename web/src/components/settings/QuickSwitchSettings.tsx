import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason, type Settings } from '../../api';
import { keys, useSettings } from '../../hooks';
import { formatShortcut } from '../../lib/shortcut';
import { Button, Card, Field, inputClass } from '../ui';

/**
 * What the shortcut is until it is changed. Not Command+Shift+K: that is Browse DMs in Slack and
 * Delete Line in VS Code, and a global shortcut takes the key from every app.
 */
const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+K';

/** Where the last shortcut that was saved is kept, so that Off and then On brings it back. */
const REMEMBERED = 'focusdesk.quickSwitchShortcut';

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED) || null;
  } catch {
    // Storage is blocked: the card's own draft still has it for as long as the card is open.
    return null;
  }
}

function remember(shortcut: string) {
  try {
    localStorage.setItem(REMEMBERED, shortcut);
  } catch {
    // As above.
  }
}

type Status = { tone: 'good' | 'bad' | 'plain'; text: string };

/**
 * The shortcut that opens the quick-switch box from any app. Self-contained: it keeps its own
 * draft and saves only its own setting.
 */
export function QuickSwitchSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const saved = settings?.quick_switch_hotkey;
  // Nothing can be typed until what is saved has arrived: it would be written over the draft.
  const loading = saved === undefined;
  const [on, setOn] = useState(true);
  // Starts from the last shortcut that was saved, so a card that opens with the shortcut off
  // still has something to turn on with.
  const [text, setText] = useState(() => remembered() ?? DEFAULT_SHORTCUT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  // The draft follows what is saved, when that arrives or is changed from elsewhere. When the
  // shortcut is off there is nothing saved to follow, and the draft stays the last one there was.
  useEffect(() => {
    if (saved === undefined) return;
    setOn(saved !== '');
    if (saved) {
      remember(saved);
      setText(saved);
    }
  }, [saved]);

  /** Take what the server has just stored as the saved shortcut, here and in the shared cache. */
  function adopt(next: Settings) {
    // Into the shared cache, so every card on the page reads the shortcut as it is now saved.
    // The page's own Save sends only what was typed there, so this cannot be undone by it, and
    // its unsaved edits stay as they are.
    qc.setQueryData(keys.settings, next);
    const shortcut = next.quick_switch_hotkey;
    setOn(shortcut !== '');
    if (shortcut) {
      remember(shortcut);
      setText(shortcut);
    }
  }

  /**
   * Ask the desktop app to read the setting again and register it, and say what came of it.
   * Only the desktop app can: a browser cannot hold a shortcut that works in other apps.
   */
  async function activate(afterSave: boolean) {
    if (typeof window.focusdesk?.reloadHotkey !== 'function') {
      if (afterSave) setStatus({ tone: 'plain', text: 'Saved. The shortcut works in the desktop app.' });
      return;
    }
    try {
      const result = await window.focusdesk.reloadHotkey();
      const active = result.accelerator ? formatShortcut(result.accelerator) : null;
      if (result.ok) {
        setStatus(
          active ? { tone: 'good', text: `Active: ${active}` } : { tone: 'plain', text: 'Turned off.' },
        );
        return;
      }
      const why = result.error ?? 'It could not be registered.';
      if (!afterSave) {
        // Only looking: what is saved stays, because the app that holds it may let go of it.
        setStatus({ tone: 'bad', text: `${why}${active ? ` Still active: ${active}.` : ''}` });
        return;
      }
      // Just saved, and the app would not have it. What is saved is what the next start registers,
      // so it goes back to the shortcut that works: left as it is, a restart would find one that
      // cannot be had and end up with none.
      let outcome: string;
      try {
        adopt(await api.updateSettings({ quick_switch_hotkey: result.accelerator ?? '' }));
        outcome = active
          ? `Not saved: ${active} is still your shortcut.`
          : 'Not saved: quick switch is off until you save a shortcut that works.';
      } catch (err) {
        outcome = `It could not be put back either (${reason(err, 'the server did not answer')}), so the saved shortcut may not be the one that works.`;
      }
      setStatus({ tone: 'bad', text: `${why} ${outcome}` });
    } catch (err) {
      setStatus({ tone: 'bad', text: reason(err, 'The app did not answer.') });
    }
  }

  // Shown when the card opens too, so a shortcut that never took (another app had it) is not a
  // silent failure. Reading the setting again changes nothing when it is already registered.
  useEffect(() => {
    void activate(false);
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      adopt(await api.updateSettings({ quick_switch_hotkey: on ? text.trim() : '' }));
      await activate(true);
    } catch (err) {
      setError(reason(err, 'Could not save the shortcut'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Quick switch"
      subtitle="Press a shortcut in any app, type a few letters of a task or saved timer, and press Enter: the block on the clock stops and the new one starts."
    >
      <div className="space-y-3">
        <Field label="Enabled" group>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={on ? 'primary' : 'default'}
              aria-pressed={on}
              disabled={loading}
              onClick={() => {
                setOn(true);
                // Back to the last shortcut, unless the box was emptied while it was off.
                setText((current) => (current.trim() ? current : (remembered() ?? DEFAULT_SHORTCUT)));
              }}
            >
              On
            </Button>
            <Button
              size="sm"
              variant={on ? 'default' : 'primary'}
              aria-pressed={!on}
              disabled={loading}
              onClick={() => setOn(false)}
            >
              Off
            </Button>
          </div>
        </Field>

        <Field
          label="Shortcut"
          hint="One key and one or more modifiers, joined with +. Modifiers: CommandOrControl, Command, Control, Super, Alt, Option, Shift. At least one of the first four is needed, because Shift or Alt alone would take ordinary typing from every app; F1–F24 are the exception and can take any modifier. Keys: A–Z, 0–9, F1–F24, Space, Tab, Enter, Escape, Backspace, Delete, Insert, Up, Down, Left, Right, Home, End, PageUp, PageDown, Plus. For example CommandOrControl+Alt+K, Control+Alt+Space or Shift+F5. CommandOrControl+Shift+F and CommandOrControl+Shift+Space are FocusDesk's own."
        >
          <input
            className={inputClass}
            value={text}
            // Off keeps what was typed, so turning it on again has it to hand.
            disabled={loading || !on}
            spellCheck={false}
            autoComplete="off"
            placeholder={DEFAULT_SHORTCUT}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim() && !busy) void save();
            }}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={busy || loading || (on && !text.trim())}
            onClick={() => void save()}
          >
            Save
          </Button>
          {status && (
            <span
              className={`text-xs ${
                status.tone === 'good'
                  ? 'text-good'
                  : status.tone === 'bad'
                    ? 'text-critical'
                    : 'text-muted'
              }`}
            >
              {status.text}
            </span>
          )}
          {error && (
            <span role="alert" className="text-xs text-critical">
              {error}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
