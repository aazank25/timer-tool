/**
 * What needs your attention, as the desktop app shows it: a notification the first time
 * something is asked, and a section at the top of the menu-bar menu for as long as it is
 * still being asked. The questions themselves, and what answering one does, are the server's
 * (server/src/lib/prompts.ts); this only reads the list, puts it where you will see it, and
 * sends the answer back.
 *
 * Nothing here imports Electron. What it needs of it is handed in (the Notification class,
 * the windows to show) so the rules can be tested without a screen: who is told when, what
 * a click goes to, and what the menu says.
 *
 * What it has told you is remembered only while the app runs, so after a restart whatever is
 * still waiting is told once more. That is the price of keeping nothing on disk for it, and it
 * is a fair one: a question that is still open after a restart is worth hearing again.
 */

/** Someone who has touched the machine this recently is at it; anyone who has not is not. */
export const PRESENT_WITHIN_SECONDS = 120;

/** A menu is a poor place for a sentence: a title longer than this is cut short. */
export const MENU_LABEL_MAX = 60;

/** Notified ids are kept for the life of the app, so that nothing is said twice. This much is plenty. */
const REMEMBERED_IDS = 500;
/** Notifications still on screen are held on to (see `show`); this many is more than there ever are. */
const HELD_NOTIFICATIONS = 50;

/**
 * Text as a menu label: one line, whole if it fits and else cut at the limit with an ellipsis,
 * and safe to hand to a menu.
 *
 * A title is whatever somebody typed, and a menu takes it for more than text. A line break or a
 * run of spaces is shown as it is typed. A lone `&` marks a keyboard shortcut on Windows and
 * Linux and is dropped on a Mac, so "R&D sync" read "RD sync": it is doubled, which every
 * platform reads as the character itself. And the cut is made by character, since cutting by
 * the units JavaScript counts in splits an emoji in two and leaves half of it, which cannot be
 * drawn. The limit counts what is shown, so the doubled `&`s are not part of it.
 */
export function trimLabel(text, max = MENU_LABEL_MAX) {
  const label = String(text ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(label);
  const shown =
    characters.length <= max ? label : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
  return shown.replace(/&/g, '&&');
}

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {object} deps
 * @param {() => Promise<object[]>} deps.fetchPrompts GET /api/prompts.
 * @param {(id: string, action: string) => Promise<unknown>} deps.actOnPrompt POST /api/prompts/act.
 * @param {{ isSupported(): boolean, new (options: { title: string, body: string }): any }} deps.Notification
 *   Electron's class. Not every platform can show one.
 * @param {() => number} deps.getIdleSeconds Seconds since the last input.
 * @param {() => boolean} deps.isLocked Whether the screen is locked, or somebody else is using the Mac.
 * @param {(route?: string) => void} deps.openWindow Show the main window, at a route of the app if one is given.
 * @param {() => void} deps.openPalette Show the quick-switch box.
 * @param {(message: string) => void} deps.showError Tell the person something went wrong.
 * @param {() => void} [deps.onChange] Called whenever the list may have changed what is on screen.
 * @param {() => unknown} [deps.afterAction] Called once an answer from the menu has been sent.
 * @param {(...args: unknown[]) => void} [deps.log]
 */
export function createAttention({
  fetchPrompts,
  actOnPrompt,
  Notification,
  getIdleSeconds,
  isLocked,
  openWindow,
  openPalette,
  showError,
  onChange = () => {},
  afterAction = () => {},
  log = () => {},
}) {
  /** What the server last said needs attention, oldest first. */
  let prompts = [];
  /** Every id that has been notified about, so one is never told twice (see `remember`). */
  const notified = new Set();
  /**
   * The notifications that are on screen, each under the id of the prompt it is about. macOS
   * lets go of a notification the moment nothing in the app refers to it, and one that has been
   * let go of never delivers its click, so each is kept here until it is clicked or closed, or
   * its prompt is gone: then it is taken off the screen too, rather than left there asking
   * about something that has been answered.
   */
  const held = new Map();
  /** One read at a time, in the order they were asked for. */
  let queue = Promise.resolve();

  /** Whether you are at the machine: the screen is not locked and you touched it a moment ago. */
  function present() {
    try {
      if (isLocked()) return false;
    } catch (err) {
      log('[attention] could not tell if the screen is locked', err);
    }
    try {
      return !(Number(getIdleSeconds()) >= PRESENT_WITHIN_SECONDS);
    } catch (err) {
      // An idle time that cannot be read is no reason never to be told.
      log('[attention] could not read the idle time', err);
      return true;
    }
  }

  /** Where answering by "open" goes: the box for the nudge to start something, the window for the rest. */
  function open(prompt, route) {
    try {
      if (prompt.kind === 'idle') openPalette();
      else openWindow(route);
    } catch (err) {
      log('[attention] could not open what was asked for', err);
    }
  }

  /** Clicking a notification: the window at the page its main answer opens, else the window, or the box for a nudge. */
  function clicked(prompt) {
    const main = prompt.actions.find((action) => action.primary && action.open);
    open(prompt, main?.open);
  }

  function show(prompt) {
    let notification;
    const release = () => {
      if (held.get(prompt.id) === notification) held.delete(prompt.id);
    };
    try {
      notification = new Notification({ title: prompt.title, body: prompt.body });
      held.set(prompt.id, notification);
      if (held.size > HELD_NOTIFICATIONS) held.delete(held.keys().next().value);
      notification.on('click', () => {
        release();
        clicked(prompt);
      });
      notification.on('close', release);
      notification.on('failed', release);
      notification.show();
    } catch (err) {
      release();
      log('[attention] could not show a notification', err);
    }
  }

  /**
   * Remember that this id has been told about. Ids are kept for the life of the app, up to a
   * limit, and past it the oldest go first, but only those that are no longer listed: an id that
   * is still listed is never forgotten, or a question that waits for days would be told afresh
   * each time enough others had come and gone.
   */
  function remember(id, listed) {
    notified.add(id);
    for (const old of notified) {
      if (notified.size <= REMEMBERED_IDS) break;
      if (!listed.has(old)) notified.delete(old);
    }
  }

  /** Take down the notifications whose prompts are gone: answered in the window, or no longer true. */
  function closeGone() {
    const listed = new Set(prompts.map((p) => p.id));
    for (const [id, notification] of held) {
      if (listed.has(id)) continue;
      held.delete(id);
      try {
        notification.close();
      } catch (err) {
        log('[attention] could not close a notification', err);
      }
    }
  }

  /** Tell about what has not been told yet, if there is somebody there to be told. */
  function notifyNew() {
    let supported = false;
    try {
      supported = Notification.isSupported();
    } catch {
      // Not knowing is not being able to.
    }
    if (!supported || !present()) return;
    const listed = new Set(prompts.map((p) => p.id));
    for (const prompt of prompts) {
      if (notified.has(prompt.id)) continue;
      remember(prompt.id, listed);
      show(prompt);
    }
  }

  async function read() {
    try {
      const list = await fetchPrompts();
      if (!Array.isArray(list)) return;
      prompts = list;
      closeGone();
      notifyNew();
      onChange();
    } catch (err) {
      // Whatever was known stays: a read that failed says nothing about what is pending.
      log('[attention] could not read the prompts', err);
    }
  }

  /** Read the list again, notify about what is new, and update the menu. Never rejects. */
  function refresh() {
    queue = queue.then(read, read);
    return queue;
  }

  /** One item of the menu was chosen: open the page, or send the answer, and read the list again. */
  async function choose(prompt, action) {
    try {
      if (action.open) {
        open(prompt, action.open);
        return;
      }
      await actOnPrompt(prompt.id, action.id);
    } catch (err) {
      // Never a silent nothing. The commonest is a prompt that was answered in the window in the meantime.
      log('[attention] the answer was not taken', err);
      try {
        showError(`${prompt.title}\n\n${messageOf(err)}`);
      } catch (shown) {
        log('[attention] could not show the error', shown);
      }
    }
    try {
      await afterAction();
    } catch (err) {
      log('[attention] could not update after an answer', err);
    }
    await refresh();
  }

  return {
    refresh,

    /** What is pending, oldest first. */
    prompts: () => prompts.map((p) => ({ ...p, actions: p.actions.map((a) => ({ ...a })) })),

    /** The ids that have been notified about. */
    notified: () => [...notified],

    /** How many notifications are being held on to. */
    heldCount: () => held.size,

    /** How many questions are waiting: what the menu-bar mark is for. */
    pending: () => prompts.length,

    /** What the section of the menu is made of, so it is only built again when that changes. */
    signature: () =>
      JSON.stringify(prompts.map((p) => [p.id, p.title, p.actions.map((a) => [a.id, a.label])])),

    /** The section for the top of the menu: a heading and a submenu for each question, or nothing. */
    menuItems() {
      if (prompts.length === 0) return [];
      return [
        { label: 'Needs attention', enabled: false },
        ...prompts.map((prompt) => ({
          label: trimLabel(prompt.title),
          submenu: prompt.actions.map((action) => ({
            label: trimLabel(action.label),
            // The promise is for whoever wants to wait for it; the menu does not.
            click: () => choose(prompt, action),
          })),
        })),
        { type: 'separator' },
      ];
    },
  };
}

/**
 * "Got interrupted" for the block on the clock. A focus block gets a submenu of the reasons
 * and "No reason", as the button in the window does, so naming it is one more click; a
 * break has nothing to ask, as in the window: reasons are only read for focus blocks, so a
 * choice made there would go nowhere, and it is logged with the one click.
 *
 * @param {{ id: number, kind: string }} session
 * @param {{ key: string, label: string }[]} reasons
 * @param {(sessionId: number, reason: string | null) => unknown} interrupt
 */
export function interruptedItem(session, reasons, interrupt) {
  if (session.kind !== 'focus') {
    return { label: 'Got interrupted', click: () => interrupt(session.id, null) };
  }
  return {
    label: 'Got interrupted',
    submenu: [
      ...reasons.map((reason) => ({
        label: reason.label,
        click: () => interrupt(session.id, reason.key),
      })),
      { label: 'No reason', click: () => interrupt(session.id, null) },
    ],
  };
}
