import { useEffect, useState } from 'react';
import { ModePicker } from '../components/pickers';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { ShortcutSettings } from '../components/settings/ShortcutSettings';
import { WrapUpSettings } from '../components/settings/WrapUpSettings';
import { PromptSettings } from '../components/settings/PromptSettings';
import { WindowSettings } from '../components/settings/WindowSettings';
import { Button, Card, Empty, Field, inputBase, inputClass } from '../components/ui';
import { keys, useCalendarSources, useSettings, useTheme } from '../hooks';
import { api } from '../api';
import { useQueryClient } from '@tanstack/react-query';

const NUMBER_FIELDS: { key: string; label: string; hint?: string; min: number; max: number }[] = [
  { key: 'focus_minutes', label: 'Pomodoro length (min)', min: 1, max: 480 },
  { key: 'short_break_minutes', label: 'Short break (min)', min: 1, max: 120 },
  { key: 'long_break_minutes', label: 'Long break (min)', min: 1, max: 240 },
  { key: 'blocks_before_long_break', label: 'Blocks before a long break', min: 1, max: 12 },
  { key: 'daily_target_minutes', label: 'Daily focus target (min)', min: 0, max: 1440 },
  {
    key: 'day_start_hour',
    label: 'Day starts at (hour)',
    hint: 'A block before this hour counts toward the previous day.',
    min: 0,
    max: 12,
  },
];

export function SettingsPage() {
  const { data: settings } = useSettings();
  const [theme, setTheme] = useTheme();
  const qc = useQueryClient();
  // What has been typed on this page and not saved from it, key by key: a key is here only
  // while its value is not what is saved. The fields show an edit where there is one and what
  // is saved everywhere else, so whatever lands in the saved settings (a card of its own on
  // this page saving, another window) reaches every field the person has not touched, and
  // never writes over one they have. Save sends the edits and only those, so it cannot undo
  // what another card saved either, however many of them there are.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: Record<string, string> = { ...settings, ...edits };
  const changed = Object.fromEntries(Object.entries(edits).filter(([k, v]) => settings?.[k] !== v));

  function edit(key: string, value: string) {
    setEdits(({ [key]: _was, ...rest }) =>
      settings?.[key] === value ? rest : { ...rest, [key]: value },
    );
  }

  // An edit the saved value has caught up with is not one any more (the same value was saved
  // from somewhere else).
  useEffect(() => {
    if (!settings) return;
    setEdits((now) => {
      const keep = Object.entries(now).filter(([k, v]) => settings[k] !== v);
      return keep.length === Object.keys(now).length ? now : Object.fromEntries(keep);
    });
  }, [settings]);

  async function save() {
    setError(null);
    const sent = changed;
    try {
      if (Object.keys(sent).length > 0) {
        // The reply is every setting as saved, so the cache has it before the lists are read again.
        qc.setQueryData(keys.settings, await api.updateSettings(sent));
      }
      await qc.invalidateQueries();
      // What was sent is what is saved now, as the server stored it ("045" is saved as 45), so
      // it stops being an edit: unless it has been typed over since, which is still the person's.
      setEdits((now) => Object.fromEntries(Object.entries(now).filter(([k, v]) => sent[k] !== v)));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Settings</h1>
        <p className="text-xs text-muted">
          Stored locally in your own SQLite file — nothing leaves this machine unless you connect a
          calendar feed.
        </p>
      </div>

      <Card title="Timer" subtitle="Defaults for new blocks">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Default timer"
            hint="A stopwatch counts up until you stop it; a Pomodoro counts down a fixed length."
            group
          >
            <ModePicker
              value={draft.default_timer_mode === 'pomodoro' ? 'pomodoro' : 'stopwatch'}
              onChange={(mode) => edit('default_timer_mode', mode)}
            />
          </Field>
          {NUMBER_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                type="number"
                min={f.min}
                max={f.max}
                className={inputClass}
                value={draft[f.key] ?? ''}
                onChange={(e) => edit(f.key, e.target.value)}
              />
            </Field>
          ))}
          <Field label="Timezone" hint="Day boundaries and hour-of-day reports use this.">
            <input
              className={inputClass}
              value={draft.timezone ?? ''}
              onChange={(e) => edit('timezone', e.target.value)}
              placeholder="America/New_York"
            />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={() => void save()}>
            Save settings
          </Button>
          {saved && <span className="text-xs text-good">Saved</span>}
          {error && <span className="text-xs text-critical">{error}</span>}
        </div>
      </Card>

      <WrapUpSettings />

      <Card title="Appearance">
        <Field label="Theme" group>
          <div className="flex gap-1.5">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={theme === t ? 'primary' : 'default'}
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
                className="capitalize"
              >
                {t}
              </Button>
            ))}
          </div>
        </Field>
      </Card>

      <ShortcutSettings />
      <WindowSettings />
      <PromptSettings />
      <NotificationSettings />

      <CalendarSettings />
    </div>
  );
}

function CalendarSettings() {
  const { data, refetch } = useCalendarSources();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    setBusy(true);
    try {
      await api.addCalendarSource({ label: label.trim() || 'Calendar', url: url.trim() });
      setLabel('');
      setUrl('');
      await refetch();
      await sync();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add feed');
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.syncCalendars();
      const failed = res.results.filter((r) => !r.ok);
      const total = res.results.reduce((a, r) => a + r.events, 0);
      // Meetings a feed has that could not be read stay as they were, so say how many there are:
      // without that, one that went missing or out of date would look like one that was synced.
      const skipped = res.results.reduce((a, r) => a + (r.skipped ?? 0), 0);
      const aside = skipped ? `; ${skipped} meeting${skipped === 1 ? '' : 's'} could not be read` : '';
      setMessage(
        failed.length
          ? `${failed.map((f) => `${f.label}: ${f.error}`).join('; ')}`
          : `Synced ${total} event${total === 1 ? '' : 's'}${aside}.`,
      );
      if (failed.length) setError(`${failed.length} feed(s) failed`);
      await qc.invalidateQueries({ queryKey: ['calendar'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Calendar"
      subtitle="Read-only subscription feed — no OAuth app, no write access"
      action={
        data?.sources.length ? (
          <Button size="sm" onClick={() => void sync()} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {data?.sources.length ? (
          <ul className="space-y-1.5">
            {data.sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-lg border
                  border-hairline bg-raised px-2.5 py-2 text-xs"
              >
                <span className="min-w-0">
                  <span className="text-ink">{s.label}</span>
                  <span className="ml-2 text-muted">{s.host}</span>
                </span>
                <button
                  type="button"
                  className="text-muted hover:text-critical"
                  onClick={async () => {
                    await api.removeCalendarSource(s.id);
                    await refetch();
                    await qc.invalidateQueries({ queryKey: ['calendar'] });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No calendar connected.</Empty>
        )}

        <details className="text-xs text-muted">
          <summary className="cursor-pointer text-ink-2">Where do I find the feed URL?</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              <span className="text-ink-2">Google Calendar</span> — Settings → your calendar →
              Integrate calendar → <em>Secret address in iCal format</em>.
            </li>
            <li>
              <span className="text-ink-2">Outlook / Microsoft 365</span> — Calendar → Share →
              Publish a calendar → pick <em>Can view all details</em> → copy the ICS link.
            </li>
          </ul>
          <p className="mt-2">
            Treat the URL like a password: anyone holding it can read that calendar. It is stored in
            your local database and never sent back to this page.
          </p>
        </details>

        <div className="space-y-2 border-t border-hairline pt-3">
          <div className="flex flex-wrap gap-2">
            <input
              className={`${inputBase} w-40`}
              placeholder="Label (e.g. Work)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            {/* The address is a secret: masked on screen, and kept from spell-check, autofill and
                autocorrect, any of which can pass on what is typed here. */}
            <input
              className={`${inputBase} min-w-56 flex-1`}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button variant="primary" onClick={() => void add()} disabled={!url.trim() || busy}>
              Add feed
            </Button>
          </div>
          {data?.lastSyncedAt && (
            <p className="text-[11px] text-muted">
              Last synced {new Date(data.lastSyncedAt).toLocaleString()}
            </p>
          )}
          {message && <p className="text-[11px] text-ink-2">{message}</p>}
          {error && <p className="text-[11px] text-critical">{error}</p>}
        </div>
      </div>
    </Card>
  );
}
