/**
 * What the menu-bar item says: the clock, the dot that says something is waiting, and the
 * tooltip. Nothing here touches Electron (the block on the clock and how many questions are
 * waiting are handed in, and the words are handed back), so what a person reads can be tested
 * without a menu bar to look at.
 *
 * The item is the menu bar on a Mac and the system tray on Windows and Linux, which are not the
 * same place. Only a Mac can put text beside the icon, so only there is there a title; elsewhere
 * the tooltip is all there is of the clock, and it is worded to carry the clock first and to fit
 * what Windows will show. What else differs by platform about the item (which icon it wears, what
 * its menu calls things) and about the keys the app asks the system for is here too, as
 * functions of the platform's name (process.platform: 'darwin', 'win32', 'linux'), so each can be
 * tested without that platform's machine.
 */

/** The dot before the clock while something is waiting for an answer: seen without being read. */
export const WAITING_MARK = '•';

/** Seconds as a clock: 04:05, and 1:02:03 from an hour on. Never negative, and never "NaN". */
export function formatClock(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * How long the block on the clock has run, as of `now` (epoch milliseconds). The server owns the
 * clock and is asked every few seconds, so between two asks a running block is taken to have
 * gone on at the rate of the clock; a paused one stands still, and a clock that has been set
 * back does not take time off it.
 *
 * @param {{ session: { status: string } | null, elapsedAtPoll: number, polledAt: number }} live
 *   The block as last read, the seconds it had run then, and when that was.
 * @param {number} now
 */
export function elapsedSeconds({ session, elapsedAtPoll, polledAt }, now) {
  if (!session) return 0;
  if (session.status !== 'running') return elapsedAtPoll;
  return elapsedAtPoll + Math.max(0, (now - polledAt) / 1000);
}

/**
 * The most a tray tooltip can say on Windows: the icon's tip holds 128 characters, the last being
 * the end of the text, so what is past 127 is cut off, and a title can be 300 characters long.
 * Counted in UTF-16 units, as the length of a JavaScript string is. A Mac has no such limit and its
 * tooltip is left as it always was; everywhere else it is kept to this.
 */
export const TOOLTIP_MAX = 127;

/** Text on one line: a title is whatever somebody typed, and runs of white space (line breaks too) become one space. */
const oneLine = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * `text` as it is when it is no longer than `max` characters, and otherwise its start with an
 * ellipsis, the whole within `max`. Counted in UTF-16 units, which is what Windows counts, and cut
 * between characters, so an emoji is dropped whole and never left as half of one.
 */
function clip(text, max) {
  if (text.length <= max) return text;
  if (max < 1) return '';
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > max - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * How many characters each of `lengths` may keep when `room` is all there is to share: a text
 * shorter than an equal share is kept whole, and the longer ones divide what that leaves.
 */
function shares(lengths, room) {
  const caps = [];
  let left = Math.max(0, room);
  [...lengths.keys()]
    .sort((a, b) => lengths[a] - lengths[b])
    .forEach((index, done, order) => {
      caps[index] = Math.min(lengths[index], Math.floor(left / (order.length - done)));
      left -= caps[index];
    });
  return caps;
}

/**
 * The tooltip where it is all there is of the clock (Windows and Linux): the clock first, so it is
 * the last thing that anything could cut, then the block's title; and under that the project and,
 * for a stopwatch, that it is one. When all of that would be more than Windows shows, the title
 * and the project are cut short, the longer first and as little as will do.
 */
function trayTooltip({ clock, title, project, stopwatch, needs }) {
  const build = (t, p) =>
    `${t ? `${clock} · ${t}` : clock}\n${stopwatch ? `${p} · stopwatch` : p}${needs}`;
  const t = oneLine(title);
  const p = oneLine(project) || 'No project';
  let text = build(t, p);
  if (text.length > TOOLTIP_MAX) {
    // Everything that is not the title or the project, measured with one character for each.
    const fixed = build('x', 'x').length - 2;
    const [titleMax, projectMax] = shares([t.length, p.length], TOOLTIP_MAX - fixed);
    text = build(clip(t, titleMax), clip(p, projectMax));
  }
  // Whatever else it came to (a count of waiting questions of any size): no longer than that,
  // and still starting with the clock.
  return clip(text, TOOLTIP_MAX);
}

/**
 * The words of the menu-bar item: its title (what is beside the icon) and its tooltip.
 *
 * A stopwatch has no planned time, so there is nothing to count down to and nothing to run over:
 * it counts up, unsigned. A Pomodoro counts down, and past its end it counts up with a plus. A
 * paused block says so with ||. The dot comes before the clock, and without a clock it stands
 * alone; the tooltip says in words how many questions are waiting.
 *
 * The title is the same everywhere (only a Mac shows it). The tooltip is the Mac's as it always
 * was, and on any other platform has the clock at its front and fits in TOOLTIP_MAX characters.
 *
 * @param {object} what
 * @param {{ title: string, projectName?: string | null, plannedSeconds?: number | null, status: string } | null} what.session
 * @param {number} what.elapsed Seconds the block has run (see elapsedSeconds).
 * @param {number} what.waiting How many questions are waiting for an answer.
 * @param {string} [what.platform] process.platform. A Mac's wording when it is not given.
 * @returns {{ title: string, toolTip: string }}
 */
export function menuBarText({ session, elapsed, waiting, platform = 'darwin' }) {
  const mac = platform === 'darwin';
  const mark = waiting > 0 ? WAITING_MARK : '';
  const needs =
    waiting > 0
      ? `\n${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} your attention`
      : '';

  if (!session) {
    const nothing = `FocusDesk - nothing running${needs}`;
    return { title: mark, toolTip: mac ? nothing : clip(nothing, TOOLTIP_MAX) };
  }

  const stopwatch = session.plannedSeconds == null;
  let label;
  if (stopwatch) {
    label = formatClock(elapsed);
  } else {
    const remaining = session.plannedSeconds - elapsed;
    label = remaining >= 0 ? formatClock(remaining) : `+${formatClock(-remaining)}`;
  }
  const project = session.projectName ?? 'No project';
  const title =
    session.status === 'paused' ? `${mark ? `${mark} ` : ''}|| ${label}` : `${mark} ${label}`;
  if (!mac) {
    const clock = session.status === 'paused' ? `|| ${label}` : label;
    return {
      title,
      toolTip: trayTooltip({ clock, title: session.title, project, stopwatch, needs }),
    };
  }
  return {
    title,
    toolTip:
      (stopwatch
        ? `${session.title}\n${project} · stopwatch ${label}`
        : `${session.title}\n${project} - ${label}`) + needs,
  };
}

/**
 * The files of the tray icon to try, best first, in assets/ (scripts/make-icons.mjs makes them).
 * A Mac takes a template image, black and see-through and nothing else, which it recolours for a
 * light menu bar or a dark one. Neither a Windows taskbar nor a Linux panel recolours anything,
 * and a black icon is all but invisible on a dark one, so those get the app's own look: a light
 * clock on its blue square, which shows against either. On Windows an .ico is read best, since it
 * holds a size for each screen scaling and the system takes the one that suits; the .png is for
 * when that file cannot be read, and for Linux.
 *
 * @param {string} platform
 * @returns {string[]}
 */
export function trayIconFiles(platform) {
  if (platform === 'darwin') return ['trayTemplate.png'];
  if (platform === 'win32') return ['tray.ico', 'tray.png'];
  return ['tray.png'];
}

/**
 * The words and keys of the tray menu that are not the same on every platform. "Reveal" is the
 * Finder's word and a Mac's; Windows and Linux open a folder. ⌘Q is a Mac's too: Windows has no
 * key for quitting an app (Alt+F4 closes its window, which here only hides it), and the
 * application menu that gave Linux its Ctrl+Q is not made there (see main.mjs), so naming a key
 * beside "Quit" would be naming one that does nothing.
 *
 * @param {string} platform
 * @returns {{ dataFolder: string, quitAccelerator: string | undefined }}
 */
export function trayMenuWording(platform) {
  const mac = platform === 'darwin';
  return {
    dataFolder: mac ? 'Reveal data folder' : 'Open data folder',
    quitAccelerator: mac ? 'CommandOrControl+Q' : undefined,
  };
}

/* ------------------------------------------------------------- shortcuts */

/** What the Command key is called, besides Super and Meta, which are not a Mac's names for it. */
const COMMAND_NAMES = new Set(['command', 'cmd']);

/**
 * A shortcut as it is to be registered with Electron on this platform. The setting keeps it in the
 * spelling the server stores it in (normalizeAccelerator, server/src/lib/accelerator.ts), and
 * there Command is a Mac's key. Off a Mac there is no Command key: Electron's documentation says
 * it has no effect on Windows and Linux, and names the Windows key Super. So Command (or Cmd) is
 * handed over as Super, in the documentation's own word for the key, and a saved "Command+Shift+K"
 * is never left to be read as the keys that are left (Shift+K, which would take every capital K
 * from every app). Electron 38 happens to read the two names as the same key already (Windows
 * registers it as MOD_WIN, X11 as Super), so today this changes the spelling and not the keys; it
 * is the documented way, and holds if that changes. A Mac's shortcut is handed over as it is.
 * Takes a shortcut as normalizeAccelerator returns it.
 *
 * @param {string} accelerator
 * @param {string} platform
 */
export function nativeAccelerator(accelerator, platform) {
  if (platform === 'darwin') return accelerator;
  return accelerator
    .split('+')
    .map((name) => (COMMAND_NAMES.has(name.trim().toLowerCase()) ? 'Super' : name))
    .join('+');
}
