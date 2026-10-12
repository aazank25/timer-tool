import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, reason, type SavedTimer, type Session, type Task } from '../api';
import { RatingPicker } from '../components/pickers';
import { Button } from '../components/ui';
import { duration } from '../lib/format';
import { seriesColor } from '../lib/palette';
import { quickSwitchApi, type StartBody } from '../quickSwitchApi';

/**
 * The quick-switch box. In the desktop app it is a small window of its own, raised over whatever
 * app you are in by a shortcut: type a few letters of a task or saved timer, press Enter, and the
 * block on the clock is finished and the new one started. In a plain browser it is just this
 * page, and closing it goes back to the app.
 */

/** One line of the list: something that can be started, and the body that starts it. */
interface Entry {
  key: string;
  kind: 'task' | 'timer' | 'new';
  title: string;
  projectName: string | null;
  projectColor: string | null;
  /** A word or two saying what it is, so the kind never rests on the icon or the colour alone. */
  tag: string;
  start: StartBody;
}

/** The longest list shown. Anything past it is a few more letters away. */
const MAX_ROWS = 50;

const pairKey = (projectId: number | null, title: string) => `${projectId ?? 'none'}:${title}`;

const taskEntry = (t: Task): Entry => ({
  key: `task:${t.id}`,
  kind: 'task',
  title: t.title,
  projectName: t.projectName,
  projectColor: t.projectColor,
  tag: 'Task',
  // The server files the block under the task's project, which is where it belongs.
  start: { title: t.title, taskId: t.id },
});

const timerEntry = (t: SavedTimer): Entry => ({
  key: `timer:${pairKey(t.projectId, t.title)}`,
  kind: 'timer',
  title: t.title,
  projectName: t.projectName,
  projectColor: t.projectColor,
  tag:
    t.mode === 'stopwatch'
      ? 'Timer · stopwatch'
      : t.plannedMinutes
        ? `Timer · ${t.plannedMinutes}m`
        : 'Timer',
  // Started the way it was saved, as the Focus screen does. Only a pomodoro has a length to
  // send: a stopwatch given one is refused. A pomodoro saved with none leaves it out, and the
  // server falls back to the Pomodoro length setting, the figure Focus would have filled in.
  start: {
    projectId: t.projectId,
    title: t.title,
    mode: t.mode,
    ...(t.mode === 'pomodoro' && t.plannedMinutes != null
      ? { plannedMinutes: t.plannedMinutes }
      : {}),
  },
});

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * How well what was typed fits an entry: 0 is best, null is no match. Every word typed has to
 * turn up in the title or the project, and the entry ranks by its weakest word:
 *   0  the title starts with it
 *   1  a word of the title or of the project's name starts with it
 *   2  it turns up somewhere in either
 */
function matchRank(entry: Entry, terms: string[]): number | null {
  const title = entry.title.toLowerCase();
  const project = (entry.projectName ?? '').toLowerCase();
  const words = [...title.split(WORD_BREAK), ...project.split(WORD_BREAK)];
  let weakest = 0;
  for (const term of terms) {
    let rank: number | null = null;
    if (title.startsWith(term)) rank = 0;
    else if (words.some((word) => word.startsWith(term))) rank = 1;
    else if (title.includes(term) || project.includes(term)) rank = 2;
    if (rank === null) return null;
    weakest = Math.max(weakest, rank);
  }
  return weakest;
}

/** The entries that fit, best first and otherwise in the order they came. */
function search(entries: Entry[], query: string): Entry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  const fits: { entry: Entry; order: number; rank: number }[] = [];
  entries.forEach((entry, order) => {
    const rank = matchRank(entry, terms);
    if (rank !== null) fits.push({ entry, order, rank });
  });
  return fits.sort((a, b) => a.rank - b.rank || a.order - b.order).map((fit) => fit.entry);
}

/** "Now: Competitor teardown · ROI Dashboard · 12m", and "· paused" when it is. */
function nowLine(live: Session): string {
  // Whole minutes: a block started a moment ago is at 0m, not a count of seconds.
  const worked = live.elapsedSeconds < 60 ? '0m' : duration(live.elapsedSeconds);
  return [`Now: ${live.title}`, live.projectName, worked, live.status === 'paused' && 'paused']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Stamp the theme picked in the main window on this page, and say whether it is dark. It is kept
 * in localStorage, and this window is made once and then only hidden, so a change made since
 * arrives as a storage event, or is found when the window is shown again.
 */
function applyStoredTheme(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('focusdesk.theme');
  } catch {
    // Storage is blocked: follow the system.
  }
  const root = document.documentElement;
  if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);
  else root.removeAttribute('data-theme');
  const system = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return stored === 'dark' || (stored !== 'light' && system);
}

export function PalettePage({ dark: initialDark }: { dark: boolean }) {
  const qc = useQueryClient();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dark, setDark] = useState(initialDark);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  // Set on the second step: what is to be started, and the title of the block being rated.
  const [rating, setRating] = useState<{ entry: Entry; liveTitle: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts the times the box has been shown, so focus can be put back in it each time.
  const [shown, setShown] = useState(0);
  // Where the pointer last was. A list that scrolls under a pointer that has not moved is not the
  // pointer choosing the row it has come to rest on.
  const pointer = useRef({ x: -1, y: -1 });
  // Enter pressed before the lists had arrived: there was nothing to pick from, so it picks
  // as soon as there is, from what was typed by then.
  const [pickWhenLoaded, setPickWhenLoaded] = useState(false);
  // True from the moment a switch is sent until it is answered. A ref, not state: a second Enter
  // can arrive before any render could show it, and it is what stops a switch going out twice.
  const sending = useRef(false);

  // Read again on every show: what is on the clock and in the lists has moved on since.
  const tasks = useQuery({
    queryKey: ['palette', 'tasks'],
    queryFn: () => api.listTasks({ view: 'open' }),
    staleTime: 0,
  });
  const timers = useQuery({
    queryKey: ['palette', 'timers'],
    queryFn: () => api.listTimers(60),
    staleTime: 0,
  });
  const active = useQuery({
    queryKey: ['palette', 'active'],
    queryFn: api.activeSession,
    staleTime: 0,
  });
  const live = active.data?.session ?? null;
  const loading = tasks.isPending || timers.isPending || active.isPending;

  const entries = useMemo(() => {
    const openTasks = tasks.data ?? [];
    const taskPairs = new Set(openTasks.map((t) => pairKey(t.projectId, t.title)));
    // A timer the history made for something already listed as a task would start the same work
    // without the link to the task, so the task stands in for it. One you pinned stays.
    const savedTimers = (timers.data ?? []).filter(
      (t) => t.pinned || !taskPairs.has(pairKey(t.projectId, t.title)),
    );
    return [...openTasks.map(taskEntry), ...savedTimers.map(timerEntry)];
  }, [tasks.data, timers.data]);

  const typed = query.trim();
  const rows = useMemo(() => {
    const found = search(entries, query).slice(0, MAX_ROWS);
    if (!typed) return found;
    // What was typed, started as it stands: no task, no project.
    const fresh: Entry = {
      key: 'new',
      kind: 'new',
      title: typed,
      projectName: null,
      projectColor: null,
      tag: 'New block',
      start: { title: typed, projectId: null },
    };
    return [...found, fresh];
  }, [entries, query, typed]);
  const at = rows.length ? Math.min(cursor, rows.length - 1) : -1;

  /** Back to a clean first step, and the lists read again, ready for the next time it is shown. */
  const reset = useCallback(() => {
    setQuery('');
    setCursor(0);
    setRating(null);
    setError(null);
    setPickWhenLoaded(false);
    sending.current = false;
    setShown((n) => n + 1);
    setDark(applyStoredTheme());
    void qc.invalidateQueries({ queryKey: ['palette'] });
  }, [qc]);

  // The desktop app announces each show, and the window is hidden rather than closed, so the
  // box has to start itself over then. It also does when it goes out of sight, so that the next
  // time it appears there is not a frame of what was typed before.
  useEffect(() => {
    const stop = window.focusdesk?.onPaletteShow?.(reset);
    return typeof stop === 'function' ? stop : undefined;
  }, [reset]);
  useEffect(() => {
    if (!window.focusdesk) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') reset();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [reset]);
  useEffect(() => {
    const onStorage = () => setDark(applyStoredTheme());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Typing goes to the box whenever it is on the first step, however it got there.
  useEffect(() => {
    if (!rating) inputRef.current?.focus();
  }, [rating, shown]);
  useEffect(() => {
    if (at >= 0) document.getElementById(`${listId}-option-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [at, rows, listId]);

  function close() {
    if (typeof window.focusdesk?.closePalette === 'function') {
      window.focusdesk.closePalette();
      reset();
    } else {
      window.location.assign('/');
    }
  }

  async function send(entry: Entry, rate: number | null) {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await quickSwitchApi.switchBlock({ start: entry.start, rating: rate });
      close();
    } catch (err) {
      // Everything stays as it was, so another pick is a keystroke away.
      setError(reason(err, 'Could not switch blocks'));
      sending.current = false;
    }
  }

  function choose(entry: Entry) {
    // Until the block on the clock is known there is no telling whether to ask about it.
    if (loading || sending.current) return;
    setError(null);
    if (live) setRating({ entry, liveTitle: live.title });
    else void send(entry, null);
  }

  function move(step: number) {
    if (rows.length) setCursor((at + step + rows.length) % rows.length);
  }

  const onKey = (e: KeyboardEvent) => {
    // An input method is still choosing the text, and its keys are not ours.
    if (e.isComposing || e.keyCode === 229 || sending.current) return;
    if (rating) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRating(null);
        setError(null);
      } else if (e.key === 'Enter' && e.repeat) {
        // Held down, Enter would click Skip over and over. Once is a choice.
        e.preventDefault();
      } else if (/^[1-5]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) void send(rating.entry, Number(e.key));
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        // On a button, Enter is that button's own: a rating reached with Tab, or Skip.
        e.preventDefault();
        void send(rating.entry, null);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (loading) {
        setPickWhenLoaded(true);
        return;
      }
      const entry = rows[at];
      if (entry) choose(entry);
    }
  };
  // Listened for on the window and not on the box: a click on the list, or on nothing, takes the
  // focus off the box, and the keys must still do what they say.
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!pickWhenLoaded || loading) return;
    setPickWhenLoaded(false);
    const entry = rows[at];
    if (entry) choose(entry);
  });

  const problems = [
    tasks.isError ? `tasks (${reason(tasks.error, 'failed')})` : null,
    timers.isError ? `saved timers (${reason(timers.error, 'failed')})` : null,
    active.isError ? `the block on the clock (${reason(active.error, 'failed')})` : null,
  ].filter((p): p is string => p !== null);

  return (
    <div className="mx-auto flex h-dvh max-w-[640px] flex-col overflow-hidden border border-hairline bg-plane text-ink">
      {rating ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col justify-center gap-5 px-6">
            <div>
              <h1 className="text-lg font-semibold text-ink">How did “{rating.liveTitle}” go?</h1>
              <p className="mt-1 truncate text-xs text-muted">
                Then starting {rating.entry.title}
                {rating.entry.projectName && ` · ${rating.entry.projectName}`}
              </p>
            </div>
            <RatingPicker value={null} onChange={(n) => void send(rating.entry, n)} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted">Press 1–5 to rate it, or skip it unrated.</p>
              {/* Not disabled while sending: that would take the focus off it. */}
              <Button autoFocus onClick={() => void send(rating.entry, null)}>
                Skip
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-xs text-critical">
                {error}
              </p>
            )}
          </div>
          <Hints>
            <Hint keys={['1–5']}>rate</Hint>
            <Hint keys={['↵']}>skip</Hint>
            <Hint keys={['esc']}>back</Hint>
          </Hints>
        </>
      ) : (
        <>
          <div className="space-y-2 border-b border-hairline px-4 pb-3 pt-4">
            <div
              className="flex items-center gap-2.5 rounded-lg border border-hairline bg-raised px-3
                focus-within:border-accent"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-4 shrink-0 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              <input
                ref={inputRef}
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={at >= 0 ? `${listId}-option-${at}` : undefined}
                aria-autocomplete="list"
                aria-label="Switch to a task or saved timer"
                placeholder="Switch to a task or saved timer…"
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                  setError(null);
                  setPickWhenLoaded(false);
                }}
                className="h-11 min-w-0 flex-1 bg-transparent text-base text-ink
                  placeholder:text-muted focus:outline-none"
              />
            </div>
            <p className="min-h-4 truncate text-xs text-ink-2">
              {live ? nowLine(live) : active.isPending ? ' ' : 'Nothing running'}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.length > 0 ? (
              <ul id={listId} role="listbox" aria-label="Tasks and saved timers" className="space-y-0.5">
                {rows.map((entry, index) => {
                  const selected = index === at;
                  const color = seriesColor(entry.projectColor, dark);
                  return (
                    <li
                      key={entry.key}
                      id={`${listId}-option-${index}`}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={(e) => {
                        const { clientX: x, clientY: y } = e;
                        if (x === pointer.current.x && y === pointer.current.y) return;
                        pointer.current = { x, y };
                        setCursor(index);
                      }}
                      onClick={() => choose(entry)}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border-l-2 py-2
                        pl-2.5 pr-3 ${selected ? 'border-accent bg-raised' : 'border-transparent'}`}
                    >
                      <span
                        aria-hidden="true"
                        className="grid size-7 shrink-0 place-items-center rounded-full"
                        style={{ background: `${color}1f` }}
                      >
                        <KindIcon kind={entry.kind} color={color} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {entry.kind === 'new' ? (
                          <>
                            <span className="text-ink">Start “{entry.title}”</span>
                            <span className="text-muted"> · no project</span>
                          </>
                        ) : (
                          <>
                            <span className="text-ink">{entry.title}</span>
                            {entry.projectName && (
                              <span className="text-muted"> · {entry.projectName}</span>
                            )}
                          </>
                        )}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">{entry.tag}</span>
                      {/* What Enter will pick, said in a glyph as well as in the highlight. */}
                      <span
                        aria-hidden="true"
                        className={`w-3 shrink-0 text-center text-[11px] text-muted ${
                          selected ? '' : 'invisible'
                        }`}
                      >
                        ↵
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-3 py-8 text-center text-xs text-muted">
                {loading
                  ? 'Loading…'
                  : 'No open tasks or saved timers yet. Type a title to start a new block.'}
              </p>
            )}
          </div>

          {(error || problems.length > 0) && (
            <div role="alert" className="space-y-0.5 border-t border-hairline px-4 py-2 text-xs">
              {error && <p className="text-critical">{error}</p>}
              {problems.length > 0 && (
                <p className="text-muted">Could not load {problems.join(', ')}.</p>
              )}
            </div>
          )}
          <Hints>
            <Hint keys={['↑', '↓']}>move</Hint>
            <Hint keys={['↵']}>{live ? 'switch' : 'start'}</Hint>
            <Hint keys={['esc']}>close</Hint>
          </Hints>
        </>
      )}
    </div>
  );
}

function KindIcon({ kind, color }: { kind: Entry['kind']; color: string }) {
  if (kind === 'task') {
    return (
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke={color} strokeWidth="2.4">
        <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'new') {
    return (
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke={color} strokeWidth="2.4">
        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill={color}>
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

function Hints({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-t border-hairline px-4 py-2 text-[11px] text-muted">
      {children}
    </div>
  );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded border border-hairline bg-raised px-1 font-sans text-[10px] text-ink-2"
        >
          {key}
        </kbd>
      ))}
      {children}
    </span>
  );
}
