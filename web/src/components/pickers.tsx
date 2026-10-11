import { useState } from 'react';
import type { Project, TimerMode } from '../api';
import { nextColor, seriesColor } from '../lib/palette';
import { useProjectActions } from '../hooks';
import { Button, inputBase, inputClass, Swatch } from './ui';

/**
 * Pick the overarching project this block rolls up to, with an inline escape
 * hatch to create one — a new project should never mean leaving the timer.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  dark,
  allowNone = true,
  ariaLabel,
}: {
  projects: Project[];
  value: number | null;
  onChange: (id: number | null) => void;
  dark: boolean;
  allowNone?: boolean;
  /** For a picker with no <Field> around it: the select has no other name. */
  ariaLabel?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const { create } = useProjectActions();
  const selected = projects.find((p) => p.id === value);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const project = await create.mutateAsync({
      name: trimmed,
      color: nextColor(projects.map((p) => p.color)),
    });
    onChange(project.id);
    setName('');
    setCreating(false);
  }

  if (creating) {
    return (
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder="New project name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') {
              // A dialog around this listens for Escape on the document. Left to travel
              // there, the same keypress that cancels the new project would close it too,
              // and take whatever else was typed into it along.
              e.stopPropagation();
              setCreating(false);
            }
          }}
        />
        <Button variant="primary" onClick={() => void submit()} disabled={!name.trim()}>
          Add
        </Button>
        <Button variant="ghost" onClick={() => setCreating(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {selected && <Swatch color={seriesColor(selected.color, dark)} />}
      <select
        className={inputClass}
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') {
            setCreating(true);
            return;
          }
          onChange(e.target.value ? Number(e.target.value) : null);
        }}
      >
        {allowNone && <option value="">No project</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__new">+ New project…</option>
      </select>
    </div>
  );
}

const RATING_LABELS: Record<number, string> = {
  1: 'Scattered',
  2: 'Distracted',
  3: 'Okay',
  4: 'Locked in',
  5: 'Flow',
};

/** Self-reported focus, 1–5. Keyboard 1–5 works while the dialog is open. */
export function RatingPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={value === n}
            className={`flex h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg border
              text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-accent ${
                value === n
                  ? 'border-accent bg-accent/10 text-ink'
                  : 'border-hairline bg-raised text-ink-2 hover:border-axis'
              }`}
          >
            <span className="text-base font-semibold tabular">{n}</span>
            <span className="text-[10px] leading-none text-muted">{RATING_LABELS[n]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export const DURATION_PRESETS = [15, 25, 45, 50, 90];

export function DurationPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (minutes: number) => void;
}) {
  const [custom, setCustom] = useState(false);
  if (custom) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={480}
          autoFocus
          className={`${inputBase} w-24`}
          value={value}
          onChange={(e) => onChange(Math.max(1, Math.min(480, Number(e.target.value) || 1)))}
        />
        <span className="text-xs text-muted">minutes</span>
        <Button variant="ghost" size="sm" onClick={() => setCustom(false)}>
          Presets
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {DURATION_PRESETS.map((m) => (
        <Button
          key={m}
          size="sm"
          variant={value === m ? 'primary' : 'default'}
          aria-pressed={value === m}
          onClick={() => onChange(m)}
        >
          {m}m
        </Button>
      ))}
      <Button
        size="sm"
        variant={DURATION_PRESETS.includes(value) ? 'default' : 'primary'}
        aria-pressed={!DURATION_PRESETS.includes(value)}
        onClick={() => setCustom(true)}
      >
        {DURATION_PRESETS.includes(value) ? 'Custom' : `${value}m`}
      </Button>
    </div>
  );
}

const MODES: { value: TimerMode; label: string }[] = [
  { value: 'stopwatch', label: 'Stopwatch' },
  { value: 'pomodoro', label: 'Pomodoro' },
];

/** Count up until you stop, or count down a fixed length. */
export function ModePicker({
  value,
  onChange,
}: {
  value: TimerMode;
  onChange: (mode: TimerMode) => void;
}) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="Timer mode">
      {MODES.map((m) => (
        <Button
          key={m.value}
          size="sm"
          variant={value === m.value ? 'primary' : 'default'}
          aria-pressed={value === m.value}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}

export const ESTIMATE_PRESETS = [15, 30, 45, 60, 90];

/** A guess at how long the work will take. Optional, and never a countdown. */
export function EstimatePicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (minutes: number | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  if (custom) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={480}
          autoFocus
          className={`${inputBase} w-24`}
          value={value ?? ''}
          onChange={(e) =>
            onChange(
              e.target.value ? Math.max(1, Math.min(480, Number(e.target.value) || 1)) : null,
            )
          }
        />
        <span className="text-xs text-muted">minutes</span>
        <Button variant="ghost" size="sm" onClick={() => setCustom(false)}>
          Presets
        </Button>
      </div>
    );
  }
  const preset = value != null && ESTIMATE_PRESETS.includes(value);
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        size="sm"
        variant={value == null ? 'primary' : 'default'}
        aria-pressed={value == null}
        onClick={() => onChange(null)}
      >
        None
      </Button>
      {ESTIMATE_PRESETS.map((m) => (
        <Button
          key={m}
          size="sm"
          variant={value === m ? 'primary' : 'default'}
          aria-pressed={value === m}
          onClick={() => onChange(m)}
        >
          {m}m
        </Button>
      ))}
      <Button
        size="sm"
        variant={value == null || preset ? 'default' : 'primary'}
        aria-pressed={value != null && !preset}
        onClick={() => setCustom(true)}
      >
        {value == null || preset ? 'Custom' : `${value}m`}
      </Button>
    </div>
  );
}
