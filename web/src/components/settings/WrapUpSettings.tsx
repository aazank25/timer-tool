import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { Button, Card, Field, inputBase } from '../ui';

/** Half past five: what a reminder is set to when it is switched on and no time is chosen. */
const FALLBACK_TIME = '17:30';
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * When the end-of-day wrap-up is due, or never. It is a card of its own, with its own
 * draft and its own Save, and it sends the one setting it owns. The page's Save settings
 * button sends only the fields edited in its own card, and this key is not one of them, so
 * the two never write the same setting and neither can undo the other.
 */
export function WrapUpSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  // Null until the person touches the control: it follows what is saved. The setting is a
  // time, or an empty string for off, and "on" and "which time" are kept apart so that
  // clearing the time box does not read as having switched it off.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = settings?.wrapup_time;
  const storedOn = stored !== undefined && stored !== '';
  const on = enabled ?? storedOn;
  const clock = time ?? (storedOn ? stored : FALLBACK_TIME);
  // What would be saved: the time, or nothing, which is how off is stored.
  const wanted = on ? clock : '';
  const valid = !on || HH_MM.test(clock);
  const changed = stored !== undefined && wanted !== stored;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const all = await api.updateSettings({ wrapup_time: wanted });
      // The saved settings are one cache for the page: the fields on it that nobody has
      // edited follow it, so they have this one as it is now without a second read.
      qc.setQueryData(keys.settings, all);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(reason(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="End-of-day wrap-up"
      subtitle="The time you want to be reminded to close out the day"
    >
      <div className="space-y-3">
        <Field label="Reminder" group>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={on ? 'primary' : 'default'}
              aria-pressed={on}
              disabled={stored === undefined}
              onClick={() => setEnabled(true)}
            >
              At a set time
            </Button>
            <Button
              size="sm"
              variant={!on ? 'primary' : 'default'}
              aria-pressed={!on}
              disabled={stored === undefined}
              onClick={() => setEnabled(false)}
            >
              Off
            </Button>
          </div>
        </Field>
        {on && (
          <Field
            label="Time"
            hint="In the timezone set above. The wrap-up page is always there when you want it."
          >
            <input
              type="time"
              className={`${inputBase} w-36`}
              value={clock}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!changed || !valid || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {!valid && <span className="text-xs text-muted">Pick a time, or choose Off.</span>}
          {saved && (
            <span role="status" className="text-xs text-good">
              Saved
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
