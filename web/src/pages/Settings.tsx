import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, inputBase, inputClass } from '../components/ui';
import { useCalendarSources, useSettings, useTheme } from '../hooks';
import { api } from '../api';
import { useQueryClient } from '@tanstack/react-query';

const NUMBER_FIELDS: { key: string; label: string; hint?: string; min: number; max: number }[] = [
  { key: 'focus_minutes', label: 'Default block length (min)', min: 1, max: 480 },
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
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  async function save() {
    setError(null);
    try {
      await api.updateSettings(draft);
      await qc.invalidateQueries();
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
          {NUMBER_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                type="number"
                min={f.min}
                max={f.max}
                className={inputClass}
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="Timezone" hint="Day boundaries and hour-of-day reports use this.">
            <input
              className={inputClass}
              value={draft.timezone ?? ''}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
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

      <Card title="Appearance">
        <Field label="Theme">
          <div className="flex gap-1.5">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={theme === t ? 'primary' : 'default'}
                onClick={() => setTheme(t)}
                className="capitalize"
              >
                {t}
              </Button>
            ))}
          </div>
        </Field>
      </Card>

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
      setMessage(
        failed.length
          ? `${failed.map((f) => `${f.label}: ${f.error}`).join('; ')}`
          : `Synced ${total} event${total === 1 ? '' : 's'}.`,
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
            <input
              className={`${inputBase} min-w-56 flex-1`}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
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
