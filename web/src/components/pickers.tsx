import { useState } from 'react';
import { ApiError, reason, type Project, type Task, type TimerMode } from '../api';
import { nextColor, seriesColor } from '../lib/palette';
import { useProjectActions } from '../hooks';
import { Button, inputBase, inputClass, Swatch } from './ui';

/**
 * A project as a picker needs it. A block or a task carries only its project's name
 * and colour, so `archived` is optional: it is there on the ones that know it.
 */
export type ProjectChoice = Pick<Project, 'id' | 'name' | 'color'> & { archived?: boolean };

/**
 * The project something sits on, as a picker can use it, or null when it sits on
 * none. A block and a task both carry their project's name and colour, so it can be
 * shown without being looked up, which is the point for an archived one: the list of
 * live projects leaves those out, and a block or a task can still be on one.
 */
export function projectOf(on: {
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
}): ProjectChoice | null {
  if (on.projectId == null) return null;
  return { id: on.projectId, name: on.projectName ?? '', color: on.projectColor ?? '' };
}

/**
 * The live projects, plus each of `picked` that they leave out. A select that holds a
 * value it has no option for shows nothing at all, so a project that is in use has to
 * stay in the list for as long as it is. What the live list leaves out is archived, and
 * the picker says so, but only when `loaded` says that list has arrived: until it has,
 * or after it failed, every project is missing from it and none is known to be archived.
 * Then the option is still added, so the select has one, and carries no label.
 */
export function withPicked(
  live: ProjectChoice[],
  loaded: boolean,
  ...picked: (ProjectChoice | null | undefined)[]
): ProjectChoice[] {
  const extra: ProjectChoice[] = [];
  for (const p of picked) {
    if (p && !live.some((l) => l.id === p.id) && !extra.some((e) => e.id === p.id)) {
      extra.push(loaded ? { ...p, archived: true } : p);
    }
  }
  return extra.length ? [...live, ...extra] : live;
}

/** What a picker keeps of a project it was handed: just enough to show it. */
const snapshot = ({ id, name, color }: ProjectChoice): ProjectChoice => ({ id, name, color });

/** A task as the Focus screen and the block editor list it: with its project, when it has one. */
export const taskLabel = (t: Pick<Task, 'title' | 'projectName'>) =>
  t.projectName ? `${t.title} · ${t.projectName}` : t.title;

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
  projects: ProjectChoice[];
  value: number | null;
  onChange: (id: number | null) => void;
  dark: boolean;
  allowNone?: boolean;
  /** For a picker with no <Field> around it: the select has no other name. */
  ariaLabel?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // Why the last try at creating one was refused, under the box the name was typed in.
  const [error, setError] = useState<string | null>(null);
  // The project this picker last handed to onChange, picked from its options or just
  // created, as the list last had it, and whether the list ever has. It stays an option for
  // as long as it is the value, even when `projects` does not list it: a project just made
  // is missing from the list until it is read again, and one archived elsewhere since has
  // left it. A select whose value has no option shows "No project" while the form still
  // holds the id. One that the list had and has not any more is archived, and says so; one
  // it has not had yet is not known to be.
  const [handed, setHanded] = useState<{ project: ProjectChoice; seen: boolean } | null>(null);
  const { create } = useProjectActions();
  const listed = handed ? projects.find((p) => p.id === handed.project.id) : undefined;
  // While the list has it, what is kept follows the list, so a rename made elsewhere is not
  // lost when the project leaves it. Set while rendering and only when something differs, so
  // it settles at once.
  if (
    handed &&
    listed &&
    (!handed.seen || listed.name !== handed.project.name || listed.color !== handed.project.color)
  ) {
    setHanded({ project: snapshot(listed), seen: true });
  }
  const choices =
    handed && handed.project.id === value && !listed
      ? [...projects, handed.seen ? { ...handed.project, archived: true } : handed.project]
      : projects;
  const selected = choices.find((p) => p.id === value);

  async function submit() {
    const trimmed = name.trim();
    // Not on the button's `disabled`: a button that is disabled cannot keep focus, and the
    // person pressing it from the keyboard would be put out of the box on a refusal.
    if (!trimmed || create.isPending) return;
    setError(null);
    let project: Project;
    try {
      project = await create.mutateAsync({
        name: trimmed,
        color: nextColor(projects.map((p) => p.color)),
      });
    } catch (err) {
      // The name stays as typed, to be changed. Names are unique, archived projects' included,
      // and the list this picker offers leaves those out, so a refusal can come as a surprise:
      // the Projects tab is where archived ones are listed.
      setError(
        err instanceof ApiError && err.status === 409
          ? `${err.message}. An archived project may already have that name: the Projects tab lists them under Show archived.`
          : reason(err, 'Could not create the project'),
      );
      return;
    }
    setHanded({ project: snapshot(project), seen: false });
    onChange(project.id);
    setName('');
    setCreating(false);
  }

  function cancel() {
    setCreating(false);
    setError(null);
  }

  if (creating) {
    return (
      <div>
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder="New project name"
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') {
                // A dialog around this listens for Escape on the document. Left to travel
                // there, the same keypress that cancels the new project would close it too,
                // and take whatever else was typed into it along.
                e.stopPropagation();
                cancel();
              }
            }}
          />
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim()}>
            Add
          </Button>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-critical">
            {error}
          </p>
        )}
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
          const id = e.target.value ? Number(e.target.value) : null;
          const picked = choices.find((p) => p.id === id);
          setHanded(picked ? { project: snapshot(picked), seen: false } : null);
          onChange(id);
        }}
      >
        {allowNone && <option value="">No project</option>}
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.archived ? ' (archived)' : ''}
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
