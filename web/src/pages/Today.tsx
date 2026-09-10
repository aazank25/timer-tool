import { useState } from 'react';
import type { CalendarEvent, PlanItem, Session } from '../api';
import { BarsByName, Columns, Hero, StatTile } from '../components/charts';
import { DayBar } from '../components/DayBar';
import { EntryRow } from '../components/EntryRow';
import { DayTimeline } from '../components/DayTimeline';
import { ProjectPicker } from '../components/pickers';
import { Button, Card, Empty, Field, inputBase, inputClass, Modal, Swatch } from '../components/ui';
import {
  useCalendarActions,
  useCalendarEvents,
  useDayStats,
  usePlan,
  usePlanActions,
  useProjects,
  useSessionActions,
  useToday,
} from '../hooks';
import { addDays, dayLabel, duration, hourLabel, timeOfDay, todayKey } from '../lib/format';
import { seriesColor } from '../lib/palette';

export function TodayPage({ dark }: { dark: boolean }) {
  const { data: todayInfo } = useToday();
  const [day, setDay] = useState<string | null>(null);
  const active = day ?? todayInfo?.today ?? todayKey();
  const isToday = active === (todayInfo?.today ?? todayKey());

  const { data: stats } = useDayStats(active);
  const { data: plan = [] } = usePlan(active);
  const { data: events = [] } = useCalendarEvents(active, active);
  const { data: projects = [] } = useProjects();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setDay(addDays(active, -1))} aria-label="Previous day">
            ←
          </Button>
          <span className="min-w-36 text-center text-sm font-medium text-ink">
            {isToday ? 'Today' : dayLabel(active, { weekday: true })}
          </span>
          <Button size="sm" onClick={() => setDay(addDays(active, 1))} aria-label="Next day">
            →
          </Button>
          {!isToday && (
            <Button size="sm" variant="ghost" onClick={() => setDay(null)}>
              Back to today
            </Button>
          )}
        </div>
        <span className="text-xs text-muted">{dayLabel(active, { weekday: true })}</span>
      </div>

      {stats && (
        <>
          <Card>
            <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
              <Hero
                label="Focused time"
                value={duration(stats.focusSeconds, { zero: '0m' })}
                detail={
                  <>
                    {stats.blocks} block{stats.blocks === 1 ? '' : 's'}
                    {stats.abandonedBlocks > 0 && ` · ${stats.abandonedBlocks} discarded`}
                    {stats.breakSeconds > 0 && ` · ${duration(stats.breakSeconds)} on breaks`}
                  </>
                }
              />
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-xs">
                    <span className="text-ink-2">Daily target</span>
                    <span className="tabular text-muted">
                      {duration(stats.focusSeconds)} / {duration(stats.targetMinutes * 60)}
                    </span>
                  </div>
                  <DayBar
                    slices={stats.byProject}
                    dark={dark}
                    height={8}
                    targetSeconds={stats.targetMinutes * 60}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile
                    label="Avg focus"
                    value={stats.avgFocusRating != null ? `${stats.avgFocusRating}/5` : '—'}
                    detail={`${stats.ratedBlocks} rated`}
                  />
                  <StatTile
                    label="Focus score"
                    value={stats.avgFocusScore != null ? stats.avgFocusScore : '—'}
                    detail="0–100"
                  />
                  <StatTile
                    label="Interruptions"
                    value={stats.interruptions}
                    tone={stats.interruptions > 5 ? 'warning' : 'neutral'}
                  />
                  <StatTile
                    label="Longest run"
                    value={duration(stats.longestStreakSeconds, { zero: '—' })}
                    detail="unbroken"
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card title="The shape of the day" subtitle="Meetings above, focus blocks below">
            <DayTimeline sessions={stats.sessions} events={events} dark={dark} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Where the time went" subtitle="By project, biggest first">
              <BarsByName
                bars={stats.byProject.map((p) => ({
                  key: String(p.projectId ?? 'none'),
                  name: p.name,
                  color: seriesColor(p.color, dark),
                  seconds: p.seconds,
                  detail: `${p.blocks} block${p.blocks === 1 ? '' : 's'}`,
                }))}
                emptyText="No focus time logged for this day."
              />
            </Card>
            <Card title="When you focused" subtitle="Worked time by hour of day">
              <Columns
                columns={stats.byHour.map((h) => ({
                  key: String(h.hour),
                  label: hourLabel(h.hour),
                  seconds: h.seconds,
                  tooltip: `${hourLabel(h.hour)} · ${duration(h.seconds)}`,
                }))}
                emptyText="No focus time logged for this day."
                tableLabel="Hour"
                labelEvery={3}
              />
            </Card>
          </div>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <PlanCard day={active} plan={plan} projects={projects} dark={dark} />
        <CalendarCard events={events} projects={projects} dark={dark} />
      </div>

      <SessionLog sessions={stats?.sessions ?? []} projects={projects} dark={dark} />
    </div>
  );
}

/* ------------------------------------------------------------------- plan */

function PlanCard({
  day,
  plan,
  projects,
  dark,
}: {
  day: string;
  plan: PlanItem[];
  projects: { id: number; name: string; color: string }[];
  dark: boolean;
}) {
  const { create, update, remove } = usePlanActions();
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [minutes, setMinutes] = useState(45);

  const plannedTotal = plan.reduce((a, p) => a + p.plannedMinutes, 0);

  function add() {
    if (!title.trim()) return;
    create.mutate({ day, title: title.trim(), projectId, plannedMinutes: minutes });
    setTitle('');
  }

  return (
    <Card
      title="Plan"
      subtitle={
        plan.length
          ? `${plan.length} block${plan.length === 1 ? '' : 's'} · ${duration(plannedTotal * 60)} planned`
          : 'Block out the day before it blocks you out'
      }
    >
      <div className="space-y-3">
        {plan.length ? (
          <ul className="space-y-1.5">
            {plan.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-lg border border-hairline
                  bg-raised px-2.5 py-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(e) => update.mutate({ id: item.id, done: e.target.checked })}
                  aria-label={`Mark "${item.title}" done`}
                />
                <Swatch color={seriesColor(item.projectColor, dark)} />
                <span className={`min-w-0 flex-1 truncate ${item.done ? 'text-muted line-through' : 'text-ink'}`}>
                  {item.title}
                </span>
                <span className="tabular shrink-0 text-muted">
                  {item.actualSeconds > 0
                    ? `${duration(item.actualSeconds)} / ${item.plannedMinutes}m`
                    : `${item.plannedMinutes}m`}
                </span>
                <button
                  type="button"
                  onClick={() => remove.mutate(item.id)}
                  className="shrink-0 text-muted hover:text-critical"
                  aria-label={`Remove "${item.title}"`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing planned for this day.</Empty>
        )}

        <div className="space-y-2 border-t border-hairline pt-3">
          <input
            className={inputClass}
            placeholder="Add a block — what will you do?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-40 flex-1">
              <ProjectPicker
                projects={projects as never}
                value={projectId}
                onChange={setProjectId}
                dark={dark}
              />
            </div>
            <input
              type="number"
              min={1}
              max={480}
              className={`${inputBase} w-20`}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 45))}
              aria-label="Planned minutes"
            />
            <Button variant="primary" onClick={add} disabled={!title.trim()}>
              Add
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- calendar */

function CalendarCard({
  events,
  projects,
  dark,
}: {
  events: CalendarEvent[];
  projects: { id: number; name: string; color: string }[];
  dark: boolean;
}) {
  const actions = useSessionActions();
  const { create } = usePlanActions();
  const { assignProject } = useCalendarActions();
  const [assigning, setAssigning] = useState<CalendarEvent | null>(null);

  if (!events.length) {
    return (
      <Card title="Meetings" subtitle="From your calendar feed">
        <Empty>
          No meetings for this day — or no calendar connected yet. Add a feed under Settings.
        </Empty>
      </Card>
    );
  }

  return (
    <Card title="Meetings" subtitle="Attribute a meeting once and the series follows">
      <ul className="space-y-1.5">
        {events.map((e) => (
          <li
            key={e.id}
            className="rounded-lg border border-hairline bg-raised px-2.5 py-2 text-xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-ink">{e.title}</span>
              <span className="tabular shrink-0 text-muted">
                {e.allDay ? 'All day' : `${timeOfDay(e.startsAt)}–${timeOfDay(e.endsAt)}`}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAssigning(e)}
                className="flex items-center gap-1.5 text-muted hover:text-ink"
              >
                <Swatch color={seriesColor(e.projectColor, dark)} />
                {e.projectName ?? 'Assign project'}
              </button>
              {e.loggedSeconds > 0 ? (
                <span className="tabular text-good">{duration(e.loggedSeconds)} logged</span>
              ) : (
                !e.allDay && (
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() =>
                      actions.logManual.mutate({
                        projectId: e.projectId,
                        title: e.title,
                        startedAt: e.startsAt,
                        minutes: Math.max(
                          5,
                          Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 60000),
                        ),
                      })
                    }
                  >
                    Log as time spent
                  </button>
                )
              )}
              <button
                type="button"
                className="text-muted hover:text-ink"
                onClick={() =>
                  create.mutate({
                    day: e.day,
                    title: e.title,
                    projectId: e.projectId,
                    plannedMinutes: Math.max(
                      15,
                      Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 60000),
                    ),
                    calendarEventId: e.id,
                  })
                }
              >
                Add to plan
              </button>
            </div>
          </li>
        ))}
      </ul>

      <Modal
        open={!!assigning}
        onClose={() => setAssigning(null)}
        title={assigning?.title ?? ''}
        width="max-w-sm"
      >
        <Field
          label="Roll this meeting up to"
          hint="Later instances of the same meeting inherit this on the next sync."
        >
          <ProjectPicker
            projects={projects as never}
            value={assigning?.projectId ?? null}
            dark={dark}
            onChange={(id) => {
              if (assigning) assignProject.mutate({ id: assigning.id, projectId: id });
              setAssigning(null);
            }}
          />
        </Field>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------ session log */

function SessionLog({
  sessions,
  projects,
  dark,
}: {
  sessions: Session[];
  projects: { id: number; name: string; color: string }[];
  dark: boolean;
}) {
  const { update, remove } = useSessionActions();
  const [editing, setEditing] = useState<Session | null>(null);

  if (!sessions.length) {
    return (
      <Card title="Block log">
        <Empty>No blocks logged for this day.</Empty>
      </Card>
    );
  }

  return (
    <Card title="Block log" subtitle="Click any block to fix its title, project, rating or minutes">
      <ul className="-mx-1 space-y-0.5">
        {sessions.map((s) => (
          <li key={s.id}>
            <EntryRow session={s} dark={dark} onClick={() => setEditing(s)} />
          </li>
        ))}
      </ul>

      {editing && (
        <EditSessionDialog
          session={editing}
          projects={projects}
          dark={dark}
          onClose={() => setEditing(null)}
          onSave={(body) => {
            update.mutate({ id: editing.id, ...body });
            setEditing(null);
          }}
          onDelete={() => {
            remove.mutate(editing.id);
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function EditSessionDialog({
  session,
  projects,
  dark,
  onClose,
  onSave,
  onDelete,
}: {
  session: Session;
  projects: { id: number; name: string; color: string }[];
  dark: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [projectId, setProjectId] = useState(session.projectId);
  const [rating, setRating] = useState(session.focusRating);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [minutes, setMinutes] = useState(Math.round(session.elapsedSeconds / 60));

  return (
    <Modal open onClose={onClose} title="Edit block">
      <div className="space-y-3">
        <Field label="What you did">
          <input
            className={inputClass}
            value={title}
            data-autofocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Project">
          <ProjectPicker
            projects={projects as never}
            value={projectId}
            onChange={setProjectId}
            dark={dark}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Focus level" hint="1–5, blank to unrate">
            <select
              className={inputClass}
              value={rating ?? ''}
              onChange={(e) => setRating(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Unrated</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minutes worked">
            <input
              type="number"
              min={0}
              max={1440}
              className={inputClass}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className={`${inputClass} min-h-20 resize-y`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                onSave({
                  title: title.trim() || session.title,
                  projectId,
                  focusRating: rating,
                  notes: notes.trim() || null,
                  ...(minutes * 60 !== session.elapsedSeconds
                    ? { activeSeconds: minutes * 60 }
                    : {}),
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
