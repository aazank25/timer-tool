import { useState } from 'react';
import { reason, type Project } from '../api';
import { BarsByName, Meter } from '../components/charts';
import { Button, Card, Empty, Field, inputClass, Modal, Swatch } from '../components/ui';
import { useProjectActions, useProjects, useRangeStats } from '../hooks';
import { addDays, duration, todayKey } from '../lib/format';
import { nextColor, seriesColor, SLOTS } from '../lib/palette';

export function ProjectsPage({ dark }: { dark: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const { data: projects = [] } = useProjects(showArchived);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const today = todayKey();
  const { data: week } = useRangeStats(addDays(today, -6), today);

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  // A weekly target has to be measured against this week, not all time.
  const weekSeconds = new Map(
    (week?.byProject ?? []).map((p) => [p.projectId, p.seconds] as const),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">Projects</h1>
          <p className="text-xs text-muted">
            The overarching things you're working on. Every block rolls up to one.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
          <Button variant="primary" onClick={() => setEditing('new')}>
            New project
          </Button>
        </div>
      </div>

      <Card title="This week" subtitle="Last 7 days, by project">
        <BarsByName
          bars={(week?.byProject ?? []).map((p) => ({
            key: String(p.projectId ?? 'none'),
            name: p.name,
            color: seriesColor(p.color, dark),
            seconds: p.seconds,
            detail: `${p.blocks} block${p.blocks === 1 ? '' : 's'}`,
          }))}
          emptyText="No time logged in the last 7 days."
        />
      </Card>

      {active.length ? (
        // One column that can shrink below its widest card: without it the column is as wide as
        // the longest unbroken name, and the page scrolls sideways at a narrow width.
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {active.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              weekSeconds={weekSeconds.get(p.id) ?? 0}
              dark={dark}
              onEdit={() => setEditing(p)}
            />
          ))}
        </div>
      ) : (
        <Empty>No projects yet. Create one and it becomes selectable on the timer.</Empty>
      )}

      {showArchived && archived.length > 0 && (
        <Card title="Archived" subtitle="Hidden from the timer; history is kept">
          <ul className="space-y-1.5 text-xs">
            {archived.map((p) => (
              <ArchivedRow key={p.id} project={p} dark={dark} />
            ))}
          </ul>
        </Card>
      )}

      {editing && (
        <ProjectDialog
          project={editing === 'new' ? null : editing}
          takenColors={projects.map((p) => p.color)}
          dark={dark}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * An archived project, and the way back from it: unarchiving puts it on the timer's pickers
 * and in the list above again, history and all. Each row has its own mutation, so the button
 * that is working and the project that could not be restored are the one that was pressed.
 */
function ArchivedRow({ project, dark }: { project: Project; dark: boolean }) {
  const { update } = useProjectActions();
  return (
    <li>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Swatch color={seriesColor(project.color, dark)} />
          <span className="truncate text-ink-2">{project.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="tabular text-muted">{duration(project.totalSeconds)}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            aria-label={`${update.isPending ? 'Unarchiving' : 'Unarchive'} ${project.name}`}
            onClick={() => update.mutate({ id: project.id, archived: false })}
          >
            {update.isPending ? 'Unarchiving…' : 'Unarchive'}
          </Button>
        </span>
      </div>
      {update.isError && (
        <p role="alert" className="mt-1 text-xs text-critical">
          {`Could not unarchive “${project.name}”: ${reason(update.error, 'try again')}`}
        </p>
      )}
    </li>
  );
}

/**
 * The only addresses a card opens. Any other scheme (smb:, file:, javascript:, an app's own) would
 * be handed to the system to open, and the page cannot tell which of those is safe.
 */
const WEB_LINK = /^https?:\/\//i;

function ProjectCard({
  project,
  weekSeconds,
  dark,
  onEdit,
}: {
  project: Project;
  weekSeconds: number;
  dark: boolean;
  onEdit: () => void;
}) {
  const weeklyTarget = project.weeklyTargetMinutes;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Swatch color={seriesColor(project.color, dark)} />
            <span className="truncate" title={project.name}>
              {project.name}
            </span>
          </h3>
          {project.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted">{project.description}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <div>
          <dt className="text-muted">All time</dt>
          <dd className="tabular mt-0.5 text-ink">{duration(project.totalSeconds)}</dd>
        </div>
        <div>
          <dt className="text-muted">This week</dt>
          <dd className="tabular mt-0.5 text-ink">{duration(weekSeconds)}</dd>
        </div>
        <div>
          <dt className="text-muted">Blocks</dt>
          <dd className="tabular mt-0.5 text-ink">{project.blockCount}</dd>
        </div>
        <div>
          <dt className="text-muted">Last worked</dt>
          <dd className="mt-0.5 text-ink">
            {project.lastWorkedAt
              ? new Date(project.lastWorkedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })
              : '—'}
          </dd>
        </div>
      </dl>

      {weeklyTarget != null && weeklyTarget > 0 && (
        <div className="mt-3">
          <Meter value={weekSeconds} max={weeklyTarget * 60} label="Weekly target" />
        </div>
      )}

      {project.notionUrl &&
        (WEB_LINK.test(project.notionUrl) ? (
          <a
            href={project.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-xs text-accent hover:underline"
          >
            Open in Notion →
          </a>
        ) : (
          // Shown rather than left out, so a link that has gone missing from the card can be
          // found, and changed, in the edit dialog.
          <p className="mt-3 truncate text-xs text-muted" title={project.notionUrl}>
            Not a web link: {project.notionUrl}
          </p>
        ))}
    </Card>
  );
}

function ProjectDialog({
  project,
  takenColors,
  dark,
  onClose,
}: {
  project: Project | null;
  takenColors: string[];
  dark: boolean;
  onClose: () => void;
}) {
  const { create, update, archive } = useProjectActions();
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? nextColor(takenColors));
  const [description, setDescription] = useState(project?.description ?? '');
  const [target, setTarget] = useState(project?.weeklyTargetMinutes ?? 0);
  const [notionUrl, setNotionUrl] = useState(project?.notionUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const body = {
      name: name.trim(),
      color,
      description: description.trim() || null,
      weeklyTargetMinutes: target > 0 ? target : null,
      notionUrl: notionUrl.trim() || null,
    };
    if (!body.name) return;
    try {
      if (project) await update.mutateAsync({ id: project.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return (
    <Modal open onClose={onClose} title={project ? 'Edit project' : 'New project'}>
      <div className="space-y-3">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            data-autofocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </Field>

        <Field
          label="Colour"
          hint="Fixed, validated set — each keeps its own step in light and dark."
          group
        >
          <div className="flex flex-wrap gap-1.5">
            {SLOTS.map((slot) => (
              <button
                key={slot.light}
                type="button"
                onClick={() => setColor(slot.light)}
                aria-label={slot.name}
                aria-pressed={color === slot.light}
                className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px]
                  transition-colors ${
                    color === slot.light
                      ? 'border-accent text-ink'
                      : 'border-hairline text-muted hover:border-axis'
                  }`}
              >
                <Swatch color={dark ? slot.dark : slot.light} />
                {slot.name}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Description (optional)">
          <textarea
            className={`${inputClass} min-h-16 resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Weekly target (hours)" hint="0 for none">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              className={inputClass}
              value={target ? target / 60 : 0}
              onChange={(e) => setTarget(Math.round((Number(e.target.value) || 0) * 60))}
            />
          </Field>
          <Field label="Notion page (optional)">
            <input
              className={inputClass}
              placeholder="https://notion.so/…"
              value={notionUrl}
              onChange={(e) => setNotionUrl(e.target.value)}
            />
          </Field>
        </div>

        {error && <p className="text-xs text-critical">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {project && !project.archived ? (
            <Button
              variant="danger"
              onClick={() => {
                archive.mutate(project.id);
                onClose();
              }}
            >
              Archive
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!name.trim()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
