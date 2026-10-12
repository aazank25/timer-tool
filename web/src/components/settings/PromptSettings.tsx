import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, reason } from '../../api';
import { keys, useSettings } from '../../hooks';
import { errorText } from '../../lib/tone';
import { promptKeys } from '../../prompts';
import { Button, Card, inputClass } from '../ui';

/** The settings this card edits, and nothing else: it saves only these, and only the ones changed. */
const KEYS = [
  'away_minutes',
  'long_block_minutes',
  'meeting_prompts',
  'work_days',
  'work_start',
  'work_end',
  'nudge_minutes',
] as const;
type Key = (typeof KEYS)[number];

/** What has been typed and not saved yet. A key that is not in it shows what is saved. */
type Edits = Partial<Record<Key, string>>;

/** The most each number of minutes may be: the same limits the server holds them to. */
const MAX_MINUTES = { away_minutes: 240, long_block_minutes: 720, nudge_minutes: 240 } as const;

/** ISO weekday numbers, Monday first, as the server stores them. */
const DAYS = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [7, 'Sun', 'Sunday'],
] as const;

const isMinutes = (text: string, max: number) => /^\d+$/.test(text.trim()) && Number(text) <= max;

type Problems = Partial<Record<keyof typeof MAX_MINUTES | 'hours', string>>;

/**
 * The fields that can have something wrong, in the order they are on the card, and the control
 * of each that holds the cursor when Save is pressed with it wrong (the work hours' first one).
 */
const PROBLEM_ORDER = [
  ['away_minutes', 'away'],
  ['long_block_minutes', 'long'],
  ['hours', 'start'],
  ['nudge_minutes', 'nudge'],
] as const;

/** The edits that are left once those `drop` says are done with are taken out. */
function without(edits: Edits, drop: (key: Key, text: string) => boolean): Edits {
  const kept: Edits = {};
  for (const key of KEYS) {
    const text = edits[key];
    if (text !== undefined && !drop(key, text)) kept[key] = text;
  }
  return kept;
}

/** What is wrong with the values as they stand, in words, by field. The server checks it all again. */
function problemsWith(value: (key: Key) => string): Problems {
  const found: Problems = {};
  for (const key of Object.keys(MAX_MINUTES) as (keyof typeof MAX_MINUTES)[]) {
    if (!isMinutes(value(key), MAX_MINUTES[key])) {
      found[key] = `Enter a whole number of minutes from 0 to ${MAX_MINUTES[key]}.`;
    }
  }
  const [start, end] = [value('work_start'), value('work_end')];
  if (!start || !end) found.hours = 'Pick a start and an end time.';
  else if (end <= start) found.hours = 'Work hours must end after they start.';
  return found;
}

/**
 * Prompts and nudges: when to ask about time you were away or a block left running, whether
 * to offer to pause for meetings, and the work days and hours the nudge and the reminders keep
 * to. It keeps its own edits and saves only its own keys, so it can sit beside the other
 * settings cards without either one overwriting the other.
 */
export function PromptSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const base = useId();
  // What has been typed on this card and not saved from it, key by key: a key is here only while
  // its value is not what is saved. A field shows its edit where there is one and what is saved
  // everywhere else, so whatever lands in the saved settings (another window, another card's Save)
  // reaches every field that has not been touched and never writes over one that has. Save sends
  // the edits and only those, so it cannot undo what another card saved either.
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether Save was pressed while something was still wrong. A field's own message is there as it
  // is typed but is not announced: a number half typed is not yet a mistake. Pressing Save is the
  // moment for saying so.
  const [refused, setRefused] = useState(false);
  // Held in a ref, as the state is only seen on the next draw: a second press in the same task
  // would otherwise send the same save twice.
  const sending = useRef(false);

  // The "Saved" note goes by itself, and must not fire on a card that has gone.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  // An edit the saved value has caught up with is not one any more: the same value was saved
  // from somewhere else.
  useEffect(() => {
    if (!settings) return;
    setEdits((now) => {
      const kept = without(now, (key, text) => settings[key] === text);
      return Object.keys(kept).length === Object.keys(now).length ? now : kept;
    });
  }, [settings]);

  if (!settings) {
    return (
      <Card title="Prompts & nudges">
        <p className="text-xs text-muted">Loading…</p>
      </Card>
    );
  }

  const value = (key: Key): string => edits[key] ?? settings[key] ?? '';
  const changed = KEYS.filter((key) => edits[key] !== undefined && edits[key] !== settings[key]);
  const problems = problemsWith(value);
  const invalid = Object.keys(problems).length > 0;
  const set = (key: Key, text: string) => {
    setSaved(false);
    setRefused(false);
    // Typing back what is saved is not an edit, and the field follows the saved value again.
    setEdits((current) => {
      const { [key]: _was, ...rest } = current;
      return settings[key] === text ? rest : { ...rest, [key]: text };
    });
  };

  const days = new Set(value('work_days').split(',').filter(Boolean).map(Number));
  const toggleDay = (n: number) => {
    const next = new Set(days);
    if (!next.delete(n)) next.add(n);
    set('work_days', [...next].sort((a, b) => a - b).join(','));
  };

  async function save() {
    if (sending.current || changed.length === 0) return;
    if (invalid) {
      // Something was typed that cannot be saved. It is said now, and the cursor goes to the
      // first field with a problem, where its message is read out with its name.
      setRefused(true);
      const first = PROBLEM_ORDER.find(([field]) => problems[field]);
      if (first) document.getElementById(`${base}-${first[1]}`)?.focus();
      return;
    }
    sending.current = true;
    setSaving(true);
    setError(null);
    // The text that is being saved, key by key, to tell which edits it has settled afterwards.
    const sent: Edits = {};
    for (const key of changed) sent[key] = value(key);
    try {
      const body: Record<string, string | number | boolean> = {};
      for (const key of changed) {
        body[key] =
          key === 'meeting_prompts'
            ? value(key) === 'true'
            : key in MAX_MINUTES
              ? Number(value(key))
              : value(key);
      }
      // The answer is every setting as it now is: the cache is brought up to date with it, so
      // every card on the page shows what is saved (the others' unsaved edits stay as they are).
      qc.setQueryData(keys.settings, await api.updateSettings(body));
      // The banners are worked out from these settings, so they are read again now and not at the
      // next poll: a threshold that was just raised should not leave its banner up for 15 seconds.
      void qc.invalidateQueries({ queryKey: promptKeys.all });
      // What was sent is what is saved now, as the server stored it ("045" is saved as 45), so it
      // stops being an edit, unless it has been typed over since: that is still the person's.
      setEdits((now) => without(now, (key, text) => sent[key] === text));
      setSaved(true);
    } catch (err) {
      setError(reason(err, 'Could not save'));
      // What the server refused was judged against the settings as it has them, which may not be
      // what this card has been showing (another window changed one). They are read again, so the
      // fields that were not edited show what is really saved.
      void qc.invalidateQueries({ queryKey: keys.settings });
    } finally {
      sending.current = false;
      setSaving(false);
    }
  }

  return (
    <Card
      title="Prompts & nudges"
      subtitle="Questions FocusDesk asks instead of letting the clock run on unattended"
    >
      <p className="mb-4 rounded-lg border border-hairline bg-raised px-3 py-2 text-xs text-ink-2">
        Away detection and notifications need the desktop app: a browser tab cannot tell when you
        have stepped away. Everything here also shows as a banner under the clock, in a browser or
        in the app.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberRow
          id={`${base}-away`}
          label="Away after (minutes)"
          hint="Desktop app only. If the screen was locked, the computer asleep or untouched for at least this long while a focus block was running, you are asked whether to keep that time or drop it. Shorter absences are ignored. 0 turns it off."
          value={value('away_minutes')}
          max={MAX_MINUTES.away_minutes}
          error={problems.away_minutes}
          onChange={(text) => set('away_minutes', text)}
        />
        <NumberRow
          id={`${base}-long`}
          label="Long block reminder (minutes)"
          hint="A running block asks whether you are still on it once it has worked this long, and again at each multiple. 0 turns it off."
          value={value('long_block_minutes')}
          max={MAX_MINUTES.long_block_minutes}
          error={problems.long_block_minutes}
          onChange={(text) => set('long_block_minutes', text)}
        />

        <div className="flex items-start gap-2.5 sm:col-span-2">
          <input
            id={`${base}-meetings`}
            type="checkbox"
            className="size-4 shrink-0 accent-accent"
            checked={value('meeting_prompts') === 'true'}
            aria-describedby={`${base}-meetings-hint`}
            onChange={(e) => set('meeting_prompts', e.target.checked ? 'true' : 'false')}
          />
          <div>
            <label
              htmlFor={`${base}-meetings`}
              className="block text-xs font-medium leading-4 text-ink-2"
            >
              Meeting prompts
            </label>
            <p id={`${base}-meetings-hint`} className="mt-1 text-[11px] text-muted">
              When a meeting on your calendar starts, offer to pause the running block; when it
              ends, offer to log it and pick the block back up. Needs a calendar feed, below.
            </p>
          </div>
        </div>

        <div className="sm:col-span-2" role="group" aria-labelledby={`${base}-days`}>
          <span id={`${base}-days`} className="mb-1 block text-xs font-medium text-ink-2">
            Work days
          </span>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map(([n, short, long]) => (
              <Button
                key={n}
                size="sm"
                variant={days.has(n) ? 'primary' : 'default'}
                aria-pressed={days.has(n)}
                aria-label={long}
                onClick={() => toggleDay(n)}
              >
                {short}
              </Button>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2" role="group" aria-labelledby={`${base}-hours`}>
          <span id={`${base}-hours`} className="mb-1 block text-xs font-medium text-ink-2">
            Work hours
          </span>
          <div className="grid max-w-sm grid-cols-2 gap-3">
            <label className="block text-[11px] text-muted">
              Start
              <input
                id={`${base}-start`}
                type="time"
                className={`${inputClass} mt-0.5 text-ink aria-invalid:border-critical`}
                value={value('work_start')}
                aria-invalid={problems.hours ? true : undefined}
                aria-describedby={`${base}-hours-hint${problems.hours ? ` ${base}-hours-error` : ''}`}
                onChange={(e) => set('work_start', e.target.value)}
              />
            </label>
            <label className="block text-[11px] text-muted">
              End
              <input
                type="time"
                className={`${inputClass} mt-0.5 text-ink aria-invalid:border-critical`}
                value={value('work_end')}
                aria-invalid={problems.hours ? true : undefined}
                aria-describedby={`${base}-hours-hint${problems.hours ? ` ${base}-hours-error` : ''}`}
                onChange={(e) => set('work_end', e.target.value)}
              />
            </label>
          </div>
          <p id={`${base}-hours-hint`} className="mt-1 text-[11px] text-muted">
            The nudge below keeps to these days and hours. The wrap-up reminder keeps to the work
            days too, and the review of last week comes when work starts on the first of them.
          </p>
          {problems.hours && (
            <p id={`${base}-hours-error`} className={`mt-1 text-[11px] ${errorText}`}>
              {problems.hours}
            </p>
          )}
        </div>

        <NumberRow
          id={`${base}-nudge`}
          label="Nudge after (minutes)"
          hint="In work hours, when nothing has been on the clock for this long, FocusDesk nudges you: a banner, and a notification from the menu-bar app. 0 turns it off."
          value={value('nudge_minutes')}
          max={MAX_MINUTES.nudge_minutes}
          error={problems.nudge_minutes}
          onChange={(text) => set('nudge_minutes', text)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          // Not disabled when there is something wrong: pressing it is how that is announced. Nor
          // when there is nothing to save, or while saving: a button that is disabled cannot keep
          // focus, which falls to the page, so the press is ignored in `save` instead.
          aria-disabled={saving || changed.length === 0 || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save prompts & nudges'}
        </Button>
        {saved && (
          <span role="status" className="text-xs text-good">
            Saved
          </span>
        )}
        {refused && invalid && (
          <span role="alert" className={`text-xs ${errorText}`}>
            {Object.keys(problems).length === 1
              ? `Not saved yet. ${Object.values(problems)[0]}`
              : `Not saved yet: ${Object.keys(problems).length} fields need fixing.`}
          </span>
        )}
        {error && (
          <span role="alert" className={`text-xs ${errorText}`}>
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}

function NumberRow({
  id,
  label,
  hint,
  value,
  max,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  max: number;
  error: string | undefined;
  onChange: (text: string) => void;
}) {
  // 0 is not a length of time here but the way to switch the thing off. The hint says so in words;
  // this says it beside the number, where the 0 is, and is read out with the field.
  const off = !error && value.trim() !== '' && Number(value) === 0;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={max}
          step={1}
          className={`${inputClass} min-w-0 aria-invalid:border-critical`}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${off ? ` ${id}-off` : ''}${error ? ` ${id}-error` : ''}`}
          onChange={(e) => onChange(e.target.value)}
        />
        {off && (
          <span
            id={`${id}-off`}
            className="shrink-0 rounded-md border border-hairline bg-raised px-2 py-1 text-xs
              font-medium text-ink-2"
          >
            Off
          </span>
        )}
      </div>
      <p id={`${id}-hint`} className="mt-1 text-[11px] text-muted">
        {hint}
      </p>
      {error && (
        <p id={`${id}-error`} className={`mt-1 text-[11px] ${errorText}`}>
          {error}
        </p>
      )}
    </div>
  );
}
