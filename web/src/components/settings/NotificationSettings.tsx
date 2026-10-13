import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { isMac, isWindows, trayName } from '../../lib/platform';
import { errorText } from '../../lib/tone';
import { Button, Card } from '../ui';

/** The switches on this card, each a setting that is 'true' unless it has been turned off. */
type Key =
  | 'notifications'
  | 'notify_away'
  | 'notify_long_block'
  | 'notify_meetings'
  | 'notify_wrapup'
  | 'notify_week_review'
  | 'notify_idle'
  | 'notify_block_done';

/** The kinds of pop-up, in the order the card lists them, each with the setting that holds it. */
const KINDS: { key: Exclude<Key, 'notifications'>; label: string; hint?: string }[] = [
  { key: 'notify_away', label: 'Away time to keep or drop' },
  { key: 'notify_long_block', label: 'A block running long' },
  { key: 'notify_meetings', label: 'Meetings starting and ending' },
  { key: 'notify_wrapup', label: 'End-of-day wrap-up' },
  { key: 'notify_week_review', label: 'Monday weekly review' },
  { key: 'notify_idle', label: 'Nothing on the clock' },
  {
    key: 'notify_block_done',
    label: 'Pomodoro finished',
    hint: "Shown by the Focus page when a Pomodoro's time is up, in the app or in a browser tab.",
  },
];

/** What the test said, and whether it went well. */
type Result = { ok: boolean; text: string };

/**
 * What to try when a test pop-up did not appear, in the words of this computer. For the desktop
 * app the app is FocusDesk; in a browser it is the browser, whose own site settings come first.
 */
function nothingAppeared(inApp: boolean): string {
  if (inApp) {
    if (isMac()) return 'check System Settings → Notifications → FocusDesk → Allow notifications.';
    if (isWindows()) return 'check Settings → System → Notifications → FocusDesk.';
    return "check your system's notification settings for FocusDesk.";
  }
  const system = isMac()
    ? 'System Settings → Notifications → your browser'
    : isWindows()
      ? 'Settings → System → Notifications → your browser'
      : "your system's notification settings for your browser";
  return `allow notifications for this page in your browser's site settings, then check ${system}.`;
}

/**
 * Show a sample pop-up from this page, the way a browser does it: with the permission of the
 * person, which is asked for first if it has not been. Resolves to what to tell them.
 */
async function testInBrowser(): Promise<Result> {
  if (!('Notification' in window)) {
    return { ok: false, text: 'This browser cannot show notifications.' };
  }
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== 'granted') {
    return {
      ok: false,
      text:
        permission === 'denied'
          ? 'Notifications are blocked for this page.'
          : 'Notifications were not allowed.',
    };
  }
  new Notification('FocusDesk', { body: 'This is a test notification.' });
  return { ok: true, text: 'Sent.' };
}

/**
 * Whether FocusDesk may pop up a notification, and for what. Every box is saved the moment it is
 * ticked, as the theme is, and only its own setting is sent. These only decide about pop-ups from
 * the operating system: the banners in the window and the menu bar's list show everything.
 */
export function NotificationSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const base = useId();
  // What has been ticked and is on its way to the server, so that the box moves when it is
  // pressed and not when the answer comes back.
  const [sending, setSending] = useState<Partial<Record<Key, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Only the desktop app pops up the six kinds that come from the server, and can show a sample
  // from the system itself.
  const inApp = typeof window.focusdesk?.testNotification === 'function';

  if (!settings) {
    return (
      <Card title="Notifications">
        <p className="text-xs text-muted">Loading…</p>
      </Card>
    );
  }

  /** On unless it has been turned off: the same reading the desktop app and the clock give it. */
  const isOn = (key: Key) => sending[key] ?? settings[key] !== 'false';
  const master = isOn('notifications');

  async function toggle(key: Key, on: boolean) {
    setError(null);
    setSending((now) => ({ ...now, [key]: on }));
    try {
      qc.setQueryData(keys.settings, await api.updateSettings({ [key]: on }));
    } catch (err) {
      setError(reason(err, 'Could not save'));
    } finally {
      setSending(({ [key]: _done, ...rest }) => rest);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      if (typeof window.focusdesk?.testNotification === 'function') {
        const sent = await window.focusdesk.testNotification();
        setResult(
          sent.ok
            ? { ok: true, text: 'Sent.' }
            : { ok: false, text: sent.error ?? 'The app could not show it.' },
        );
      } else {
        setResult(await testInBrowser());
      }
    } catch (err) {
      setResult({ ok: false, text: reason(err, 'The test could not be sent.') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card title="Notifications" subtitle="What FocusDesk may pop up on your screen">
      <div className="flex items-start gap-2.5">
        <input
          id={`${base}-master`}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-accent"
          checked={master}
          aria-describedby={`${base}-master-hint`}
          onChange={(e) => void toggle('notifications', e.target.checked)}
        />
        <div>
          <label htmlFor={`${base}-master`} className="block text-sm font-medium text-ink">
            Pop-up notifications
          </label>
          <p id={`${base}-master-hint`} className="mt-0.5 text-[11px] text-muted">
            The master switch. Off, nothing below pops up.
          </p>
        </div>
      </div>

      <div
        className="mt-3 space-y-2.5 border-t border-hairline pt-3"
        role="group"
        aria-label="Pop up for"
      >
        {KINDS.map(({ key, label, hint }) => (
          <div key={key} className="flex items-start gap-2.5">
            <input
              id={`${base}-${key}`}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-accent disabled:cursor-not-allowed"
              checked={isOn(key)}
              disabled={!master}
              aria-describedby={hint ? `${base}-${key}-hint` : undefined}
              onChange={(e) => void toggle(key, e.target.checked)}
            />
            <div>
              <label
                htmlFor={`${base}-${key}`}
                className={`block text-xs font-medium leading-4 ${master ? 'text-ink-2' : 'text-muted'}`}
              >
                {label}
              </label>
              {hint && (
                <p id={`${base}-${key}-hint`} className="mt-0.5 text-[11px] text-muted">
                  {hint}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className={`mt-3 text-xs ${errorText}`}>
          {error}
        </p>
      )}

      <p className="mt-3 text-[11px] text-muted">
        These only decide about pop-ups. The banners in the app, and the Needs attention list in the{' '}
        {trayName()}, still show everything.
        {!inApp &&
          ' The desktop app sends all of them but Pomodoro finished, so in a browser only that one pops up.'}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
        <Button disabled={testing} onClick={() => void test()}>
          {testing ? 'Sending…' : 'Send a test notification'}
        </Button>
        <p
          role="status"
          aria-live="polite"
          className={`text-xs ${result && !result.ok ? errorText : 'text-ink-2'}`}
        >
          {result?.text}
        </p>
      </div>
      {result && (
        <p className="mt-2 text-[11px] text-muted">
          If nothing appeared, {nothingAppeared(inApp)}
        </p>
      )}
    </Card>
  );
}
