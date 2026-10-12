import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { Button, Card } from '../ui';

/** What the desktop app's close button can do, as `close_behavior` stores it. */
const CHOICES = [
  {
    value: 'ask',
    label: 'Ask me',
    hint: 'The close button asks whether to keep FocusDesk running in the menu bar or quit, with a box to stop asking.',
  },
  {
    value: 'menu-bar',
    label: 'Keep running in the menu bar',
    hint: 'The window goes and FocusDesk stays in the menu bar, where the clock, away detection and the reminders keep going. Quit from its menu-bar icon.',
  },
  {
    value: 'quit',
    label: 'Quit',
    hint: 'The close button quits FocusDesk. While it is closed there is no menu-bar clock, away detection or reminders; a block on the clock still counts.',
  },
] as const;

/**
 * What the red close button of the desktop app's window does. Saved the moment one is picked, as
 * the theme is: there is nothing else on this card to save with it.
 */
export function WindowSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = CHOICES.find((c) => c.value === settings?.close_behavior) ?? CHOICES[0];

  async function pick(value: string) {
    if (saving || value === current.value) return;
    setSaving(true);
    setError(null);
    try {
      qc.setQueryData(keys.settings, await api.updateSettings({ close_behavior: value }));
    } catch (err) {
      setError(reason(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Closing the window" subtitle="What the desktop app's close button does">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="When you close the window">
        {CHOICES.map((c) => (
          <Button
            key={c.value}
            size="sm"
            variant={current.value === c.value ? 'primary' : 'default'}
            aria-pressed={current.value === c.value}
            onClick={() => void pick(c.value)}
          >
            {c.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">{current.hint}</p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}
