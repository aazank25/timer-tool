/**
 * What needs your attention, as the desktop app shows it: a notification the first time
 * something is asked, and a section at the top of the menu-bar menu (the tray menu, on Windows
 * and Linux) for as long as it is still being asked. The questions themselves, and what
 * answering one does, are the server's (server/src/lib/prompts.ts); this only reads the list,
 * puts it where you will see it, and sends the answer back.
 *
 * Nothing here imports Electron. What it needs of it is handed in (the Notification class,
 * the windows to show) so the rules can be tested without a screen: who is told when, what
 * a click goes to, and what the menu says.
 *
 * What it has told you is remembered only while the app runs, so after a restart whatever is
 * still waiting is told once more. That is the price of keeping nothing on disk for it, and it
 * is a fair one: a question that is still open after a restart is worth hearing again.
 */

/**
 * The name Windows files this app's notifications under (its App User Model ID). Windows shows a
 * notification only for an app it can name, and it names an installed one by this id: the
 * installer gives its Start Menu shortcut `build.appId` from package.json, so the two have to be
 * the same text, and a test holds them to it. main.mjs sets it before any Notification is made.
 * No other system reads it.
 */
export const APP_USER_MODEL_ID = 'com.focusdesk.app';

/** Someone who has touched the machine this recently is at it; anyone who has not is not. */
export const PRESENT_WITHIN_SECONDS = 120;

/** A menu is a poor place for a sentence: a title longer than this is cut short. */
export const MENU_LABEL_MAX = 60;

/** Notified ids are kept for the life of the app, so that nothing is said twice. This much is plenty. */
const REMEMBERED_IDS = 500;
/** Notifications still on screen are held on to (see `show`); this many is more than there ever are. */
const HELD_NOTIFICATIONS = 50;

/**
 * The setting that turns the notifications of a kind of prompt off, by the kind. Both kinds of
 * meeting prompt are one setting. A kind that is not here has no setting of its own, and is
 * governed by the master switch alone. A Map, so that a kind named like something every object
 * has ("constructor") is not mistaken for one.
 */
export const NOTIFICATION_SETTINGS = new Map([
  ['away', 'notify_away'],
  ['long-block', 'notify_long_block'],
  ['meeting-start', 'notify_meetings'],
  ['meeting-end', 'notify_meetings'],
  ['wrapup', 'notify_wrapup'],
  ['week-review', 'notify_week_review'],
  ['idle', 'notify_idle'],
]);

/**
 * Whether a prompt of this kind may be told to you as an operating-system notification. The
 * master setting `notifications` turns every one off, and each kind has a setting of its own
 * (see NOTIFICATION_SETTINGS). All of them are on until they say otherwise: only the text
 * 'false' turns one off, and a setting that is not there, because the server is older than the
 * setting or the settings have not been read yet, is on. This is about the notification and
 * nothing else: the banners in the window and the menu's Needs attention list show the prompt
 * either way.
 *
 * @param {string} kind The prompt's kind.
 * @param {Record<string, unknown> | null | undefined} settings The settings as read, or nothing yet.
 */
export function notificationAllowed(kind, settings) {
  if (settings?.notifications === 'false') return false;
  const setting = NOTIFICATION_SETTINGS.get(kind);
  return setting === undefined || settings?.[setting] !== 'false';
}

/** The notification that "Test notification" shows. */
export const TEST_NOTIFICATION = Object.freeze({
  title: 'FocusDesk',
  body: 'Notifications are on. This is what they look like.',
});

/** How long a test notification waits to hear that it was shown, or that it could not be. */
const TEST_NOTIFICATION_WAIT_MS = 1_000;

/** The test notifications that are on screen, held on to for the same reason as the others (see `show`). */
const heldTests = new Set();

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
 * @param {(kind: string) => boolean} [deps.notifyAllowed] Whether a prompt of this kind may be
 *   notified about (see notificationAllowed); always true if not given. It is asked of each
 *   prompt that has not been told about yet, whenever the list is read. A prompt whose kind is
 *   off at that moment is counted as told, and is never notified about afterwards, even if the
 *   kind is turned on while it is still waiting, so that turning one on is not followed by a
 *   burst of notifications about things that are old. Only the notification is held back: the
 *   list and the menu are the same.
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
  notifyAllowed = () => true,
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

  /** Whether this prompt's kind may be notified about. A gate that cannot answer is open: being told is the default. */
  function allowed(prompt) {
    try {
      return notifyAllowed(prompt.kind) !== false;
    } catch (err) {
      log('[attention] could not tell if a notification is wanted', err);
      return true;
    }
  }

  /**
   * Tell about what has not been told yet, if there is somebody there to be told. A prompt whose
   * kind is turned off is not told, and is counted as told, whether or not there is anybody
   * there and whether or not the system can show a notification: it is what it was when it
   * arrived that decides, and not what the setting is by the time you are back or have changed
   * your mind.
   */
  function notifyNew() {
    let supported = false;
    try {
      supported = Notification.isSupported();
    } catch {
      // Not knowing is not being able to.
    }
    const tellable = supported && present();
    const listed = new Set(prompts.map((p) => p.id));
    for (const prompt of prompts) {
      if (notified.has(prompt.id)) continue;
      if (!allowed(prompt)) {
        remember(prompt.id, listed);
        continue;
      }
      if (!tellable) continue;
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

/**
 * A sample notification, shown now: what Settings' "Test notification" asks for, so that you can
 * see what they look like, and whether this system shows them at all. It is not a prompt and it is
 * not asked of any setting: the switches in Settings and whether you are at the machine do not
 * come into it, since being shown it is the point.
 *
 * Answers { ok: true } once the system says it has shown it, or when it has not said otherwise
 * within a moment (a platform that never says is not one that failed), and { ok: false, error }
 * when this system cannot show notifications, throws on trying, or says it failed. It never
 * rejects. It holds on to the notification until it is clicked or closed, as `show` does.
 *
 * @param {object} deps
 * @param {{ isSupported(): boolean, new (options: { title: string, body: string }): any }} deps.Notification
 * @param {number} [deps.waitMs] How long to wait to hear that it was shown or failed.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export function showTestNotification({ Notification, waitMs = TEST_NOTIFICATION_WAIT_MS }) {
  let supported = false;
  try {
    supported = Notification.isSupported();
  } catch {
    // Not knowing is not being able to.
  }
  if (!supported) {
    return Promise.resolve({ ok: false, error: 'This system cannot show notifications.' });
  }
  return new Promise((resolve) => {
    let notification;
    let timer = null;
    const done = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const release = () => {
      heldTests.delete(notification);
    };
    try {
      notification = new Notification({ title: TEST_NOTIFICATION.title, body: TEST_NOTIFICATION.body });
      heldTests.add(notification);
      if (heldTests.size > HELD_NOTIFICATIONS) heldTests.delete(heldTests.values().next().value);
      notification.on('show', () => done({ ok: true }));
      notification.on('click', release);
      notification.on('close', release);
      notification.on('failed', (_event, error) => {
        release();
        done({ ok: false, error: error ? String(error) : 'The system did not show it.' });
      });
      timer = setTimeout(() => done({ ok: true }), waitMs);
      notification.show();
    } catch (err) {
      release();
      done({ ok: false, error: messageOf(err) });
    }
  });
}
