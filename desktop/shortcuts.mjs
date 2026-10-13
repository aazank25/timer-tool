/**
 * The keys of the desktop app: the three shortcuts it asks the system for (they work in any app,
 * and are settings), and the one it listens for inside its own window (which is not).
 *
 * Nothing here imports Electron. What it needs of it (globalShortcut, what each shortcut does,
 * how a shortcut is spelled on this system) is handed in, the way attention.mjs and away.mjs are
 * handed theirs, so which shortcut is registered when, what becomes of one that cannot be had,
 * when they are let go of for a while, and what counts as ⌘K can all be tested without a screen
 * or a keyboard.
 */

/** The shortcuts FocusDesk registers with the system, in the order they are registered. */
export const HOTKEY_ACTIONS = Object.freeze(['show', 'pause', 'quickSwitch']);

/**
 * The setting each shortcut is read from, what it says in a few words (for the log), and the
 * shortcut it is when the setting is not there: a server that does not have the setting yet, or
 * settings that have not been read. An empty setting is not "not there". It is off.
 */
export const HOTKEYS = Object.freeze({
  show: Object.freeze({
    setting: 'show_hotkey',
    label: 'show',
    fallback: 'CommandOrControl+Shift+F',
  }),
  pause: Object.freeze({
    setting: 'pause_hotkey',
    label: 'pause',
    fallback: 'CommandOrControl+Shift+Space',
  }),
  quickSwitch: Object.freeze({
    setting: 'quick_switch_hotkey',
    label: 'quick switch',
    fallback: 'CommandOrControl+Alt+K',
  }),
});

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Why a shortcut that is set could not be registered, for whoever reads a status and has to
 * decide what to do about it without reading the words:
 *
 *   taken       the keys are held by another app, or by another of FocusDesk's own shortcuts
 *   invalid     the setting is not a shortcut FocusDesk can register, or Electron refused it
 *   unreadable  the settings could not be read, so nothing was tried (main.mjs says this one:
 *               it is not a registration that failed)
 */
export const HOTKEY_FAILURES = Object.freeze(['taken', 'invalid', 'unreadable']);

/**
 * What each shortcut is to be, as the settings say it, with the default for any that the
 * settings do not have. `accelerator` is the text of the setting, or null when it is off (an empty
 * setting, or one of nothing but spaces: that is the server's own rule for "off"). It is not
 * checked here: the server saved it in one spelling, and createHotkeys reads it back through the
 * same rule before it registers anything.
 *
 * @param {Record<string, unknown> | null | undefined} settings The settings as read, or nothing yet.
 * @returns {{ action: 'show' | 'pause' | 'quickSwitch', setting: string, accelerator: string | null }[]}
 */
export function hotkeyPlan(settings) {
  return HOTKEY_ACTIONS.map((action) => {
    const { setting, fallback } = HOTKEYS[action];
    const saved = settings?.[setting];
    const text = typeof saved === 'string' ? saved : fallback;
    return { action, setting, accelerator: /^ *$/.test(text) ? null : text };
  });
}

/**
 * The shortcuts, registered and let go of as the settings change.
 *
 * Every shortcut goes through `toSystem` on its way into globalShortcut (off a Mac, Command is
 * written as Super: see nativeAccelerator in menu-bar.mjs), and comes back out of here in the
 * spelling it was saved in: what is active, and what is said about it, is what Settings shows.
 *
 * What a change does, for each shortcut: the one that is registered is let go of first, so that
 * the same keys under another spelling can be taken again; the new one is registered; and if it
 * cannot be had the old one is put back, and the answer says why, so that a shortcut that works
 * is never lost to one that does not. An empty setting lets go of it for good. Every shortcut
 * that changes is let go of before any new one is taken, so two that swap keys do not find each
 * other in the way.
 *
 * Electron cannot be trusted to say no. It drops a name it does not know and registers what is
 * left, and on a Mac it can answer true for a combination another app owns. The first is stopped
 * by reading each setting through `normalize`, the rule the server saved it by; the second cannot
 * be detected from here.
 *
 * A key that is registered never reaches a page: the system hands it to the app that holds it,
 * and its action runs. So Settings cannot hear a key FocusDesk already holds, and pressing one to
 * record it would run its action instead (and the quick-switch key, pressed in the quick-switch
 * row, would open the box over the recorder). `suspend` lets go of every shortcut for as long as
 * a key is being recorded, and `resume` takes them again.
 *
 * @param {object} deps
 * @param {{ register(accelerator: string, callback: () => void): boolean, unregister(accelerator: string): void, isRegistered(accelerator: string): boolean }} deps.globalShortcut
 * @param {(accelerator: string) => string} [deps.toSystem] A shortcut as this system is handed it.
 * @param {(text: string) => string | null} [deps.normalize] The setting's spelling of it, or null for text that is no shortcut.
 * @param {Record<'show' | 'pause' | 'quickSwitch', () => void>} deps.handlers What each one does.
 * @param {(...args: unknown[]) => void} [deps.log]
 */
export function createHotkeys({
  globalShortcut,
  toSystem = (accelerator) => accelerator,
  normalize = (text) => text,
  handlers,
  log = () => {},
}) {
  /**
   * What is registered for each action right now, as it was saved; null for none. While the
   * shortcuts are suspended it is what they will be again, and none of it is registered.
   */
  const active = { show: null, pause: null, quickSwitch: null };

  /** Whether every shortcut is let go of for a while (see suspend). */
  let suspended = false;

  /** Null when `accelerator` is now registered for `action`, otherwise { code, error }: what kind of failure, and why. */
  function take(action, accelerator) {
    try {
      const system = toSystem(accelerator);
      if (globalShortcut.register(system, handlers[action])) return null;
      // Refused, yet registered by this app: the combination is one of FocusDesk's own.
      return globalShortcut.isRegistered(system)
        ? { code: 'taken', error: `${accelerator} is already used by another FocusDesk shortcut.` }
        : { code: 'taken', error: `${accelerator} could not be registered. Another app may be using it.` };
    } catch (err) {
      return { code: 'invalid', error: `${accelerator} could not be registered: ${messageOf(err)}` };
    }
  }

  /** Let go of `accelerator` with the system. It never throws: letting go of nothing is not an error. */
  function letGo(accelerator) {
    try {
      globalShortcut.unregister(toSystem(accelerator));
    } catch (err) {
      log('[shortcuts] could not let go of', accelerator, err);
    }
  }

  /** Let go of what `action` holds, and forget it. */
  function release(action) {
    const accelerator = active[action];
    active[action] = null;
    if (accelerator !== null) letGo(accelerator);
  }

  /** What the setting is to be, read through the server's own rule; `refused` says why it cannot be. */
  function wanted({ action, accelerator }) {
    if (accelerator === null) return { action, accelerator: null };
    let normalized = null;
    try {
      normalized = normalize(accelerator);
    } catch (err) {
      log('[shortcuts] could not read', accelerator, err);
    }
    return normalized === null || normalized === undefined
      ? { action, refused: `"${accelerator}" is not a shortcut FocusDesk can register.` }
      : { action, accelerator: normalized };
  }

  /** Whether `accelerator` is still registered, for the one that is meant to be. */
  function stillHeld(accelerator) {
    try {
      return globalShortcut.isRegistered(toSystem(accelerator));
    } catch {
      return false;
    }
  }

  /**
   * Make the registered shortcuts what `settings` say (nothing yet reads as every default).
   * Answers, for each: { ok, accelerator, code?, error? }. `accelerator` is what is registered
   * afterwards, null for none, and when what the setting asked for could not be had, `error` is
   * why and `code` is which kind of why (see HOTKEY_FAILURES).
   *
   * Registering is what ends a suspension, so the shortcuts that were let go of are taken again
   * first, and then changed as the settings say.
   *
   * @param {Record<string, unknown> | null | undefined} settings
   */
  function apply(settings) {
    resume();
    const wants = hotkeyPlan(settings).map(wanted);
    const before = { ...active };

    // Let go of everything that is to be something else, or that is no longer held. A setting
    // that cannot be read leaves the one that works where it is.
    for (const want of wants) {
      if (want.refused !== undefined || active[want.action] === null) continue;
      if (active[want.action] !== want.accelerator || !stillHeld(active[want.action])) {
        release(want.action);
      }
    }

    const answers = {};
    const failed = [];
    for (const want of wants) {
      const { action } = want;
      if (want.refused !== undefined) {
        answers[action] = {
          ok: false,
          accelerator: active[action],
          code: 'invalid',
          error: want.refused,
        };
      } else if (want.accelerator === active[action]) {
        // Off (nothing held, nothing wanted), or already what it should be, and still held.
        answers[action] = { ok: true, accelerator: active[action] };
      } else {
        const failure = take(action, want.accelerator);
        if (failure === null) {
          active[action] = want.accelerator;
          answers[action] = { ok: true, accelerator: want.accelerator };
        } else {
          failed.push({ action, failure });
        }
      }
    }

    // What was working comes back, now that everything that could be had has been taken: it is
    // not put back over a key another shortcut has just been given.
    for (const { action, failure } of failed) {
      const previous = before[action];
      if (previous !== null && take(action, previous) === null) active[action] = previous;
      answers[action] = {
        ok: false,
        accelerator: active[action],
        code: failure.code,
        error: failure.error,
      };
    }

    return Object.fromEntries(HOTKEY_ACTIONS.map((action) => [action, answers[action]]));
  }

  /**
   * Let go of every shortcut for a while, and remember each, so that pressing one does nothing
   * (its action does not run, and the page in front gets the key). It is what Settings asks for
   * while it listens for a key to record. Nothing is forgotten: `active` still says what each is,
   * and `resume` takes them again. Suspending twice is suspending once.
   */
  function suspend() {
    suspended = true;
    for (const action of HOTKEY_ACTIONS) {
      if (active[action] !== null) letGo(active[action]);
    }
  }

  /**
   * Take again every shortcut that `suspend` let go of. One that another app has taken in the
   * meantime is not had any more (it is none, and the next `apply` says why, in its answer);
   * the rest are as they were. Resuming what is not suspended does nothing.
   */
  function resume() {
    if (!suspended) return;
    suspended = false;
    for (const action of HOTKEY_ACTIONS) {
      const accelerator = active[action];
      if (accelerator === null) continue;
      const failure = take(action, accelerator);
      if (failure === null) continue;
      active[action] = null;
      log('[shortcuts] could not take', accelerator, 'again:', failure.error);
    }
  }

  return {
    apply,
    suspend,
    resume,
    /** Whether the shortcuts are let go of for now: see suspend. */
    suspended: () => suspended,
    /** What is registered for each action: the shortcut as it was saved, or null. */
    active: () => ({ ...active }),
  };
}

/**
 * Whether any of the three shortcuts is set and could not be registered: something the person
 * should be told outside Settings too, since a shortcut that does nothing says nothing.
 * `statuses` are what `apply` answered (null before it has).
 *
 * @param {Record<string, { ok: boolean } | undefined> | null | undefined} statuses
 */
export function hotkeysFailing(statuses) {
  return !!statuses && HOTKEY_ACTIONS.some((action) => statuses[action]?.ok === false);
}

/** What the tray menu says when a shortcut is not working. */
export const HOTKEY_TROUBLE_LABEL = "A shortcut isn't working — open Settings";

/**
 * The tray menu's items for the shortcuts: one that says a shortcut is not working and opens
 * Settings, where each row says which and why, or none when every shortcut is as it was set.
 * What it does is handed in, so that it can be tried without a window.
 *
 * @param {Record<string, { ok: boolean } | undefined> | null | undefined} statuses What `apply` answered.
 * @param {() => void} open Shows the window on Settings.
 * @returns {{ label: string, click: () => void }[]}
 */
export function hotkeyMenuItems(statuses, open) {
  return hotkeysFailing(statuses) ? [{ label: HOTKEY_TROUBLE_LABEL, click: () => open() }] : [];
}

/**
 * One line for the log: what each shortcut is, or why it is not.
 *
 * @param {Record<string, { ok: boolean, accelerator: string | null, code?: string, error?: string }>} statuses What apply answered.
 */
export function describeHotkeys(statuses) {
  return HOTKEY_ACTIONS.map((action) => {
    const { label } = HOTKEYS[action];
    const status = statuses[action];
    if (!status) return `${label}: unknown`;
    return `${label}: ${status.ok ? (status.accelerator ?? 'off') : status.error}`;
  }).join(' · ');
}

/**
 * Whether a key event inside the main window is ⌘K: K pressed (not released, and not held down
 * into repeats) with the Command key on a Mac and the Control key everywhere else, and no other
 * modifier. Control+K on a Mac is not it, and neither is the Windows key with K elsewhere, or
 * either with Shift or Alt. The key is the letter that was typed, so upper and lower case (Caps
 * Lock) are the same, and it is not the position of the key: on a layout that puts K somewhere
 * else, ⌘K is still the key that types K.
 *
 * Not a shortcut setting and not global: it is only asked of the window that has the keyboard.
 *
 * @param {{ type?: string, key?: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean, isAutoRepeat?: boolean } | null | undefined} input
 *   What Electron's before-input-event hands over.
 * @param {string} platform process.platform: 'darwin', 'win32' or 'linux'.
 */
export function opensQuickSwitch(input, platform) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (typeof input.key !== 'string' || input.key.toLowerCase() !== 'k') return false;
  if (input.alt || input.shift) return false;
  return platform === 'darwin'
    ? !!input.meta && !input.control
    : !!input.control && !input.meta;
}
