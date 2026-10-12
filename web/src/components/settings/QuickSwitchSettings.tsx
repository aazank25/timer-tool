import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { formatShortcut } from '../../lib/shortcut';
import { Button, Card, Field, inputClass } from '../ui';

/** What the shortcut is until it is changed, and what a switched-off one comes back as. */
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+K';

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
  const [text, setText] = useState(DEFAULT_SHORTCUT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  // The draft follows what is saved, when that arrives or is changed from elsewhere.
  useEffect(() => {
    if (saved === undefined) return;
    setOn(saved !== '');
    setText(saved || DEFAULT_SHORTCUT);
  }, [saved]);

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
      } else {
        setStatus({
          tone: 'bad',
          text: `${result.error ?? 'It could not be registered.'}${
            active ? ` Still active: ${active}.` : ''
          }`,
        });
      }
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
      const next = await api.updateSettings({ quick_switch_hotkey: on ? text.trim() : '' });
      // The Timer card saves every setting it loaded, this one included, so it has to be handed
      // the new value or its next Save would quietly put the old shortcut back. (That also
      // resets whatever it had typed and not yet saved, which is the lesser harm.)
      qc.setQueryData(keys.settings, next);
      setText(next.quick_switch_hotkey || DEFAULT_SHORTCUT);
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
              onClick={() => setOn(true)}
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
          hint="One or more modifiers and one key, joined with +. Modifiers: CommandOrControl, Command, Control, Alt, Option, Shift, Super. Keys: A–Z, 0–9, F1–F24, Space, Tab, Enter, Escape, Backspace, Delete, Insert, Up, Down, Left, Right, Home, End, PageUp, PageDown, Plus. For example CommandOrControl+Shift+K, Control+Alt+Space or Command+Shift+F5."
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
