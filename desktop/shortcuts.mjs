/**
 * The keys of the desktop app: the three shortcuts it asks the system for (they work in any app,
 * and are settings), and the one it listens for inside its own window (which is not).
 *
 * Nothing here imports Electron. What it needs of it (globalShortcut, what each shortcut does,
 * how a shortcut is spelled on this system) is handed in, the way attention.mjs and away.mjs are
 * handed theirs, so which shortcut is registered when, what becomes of one that cannot be had,
 * and what counts as ⌘K can all be tested without a screen or a keyboard.
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
  /** What is registered for each action right now, as it was saved; null for none. */
  const active = { show: null, pause: null, quickSwitch: null };

  /** Null when `accelerator` is now registered for `action`, otherwise why it is not. */
  function take(action, accelerator) {
    try {
      const system = toSystem(accelerator);
      if (globalShortcut.register(system, handlers[action])) return null;
      // Refused, yet registered by this app: the combination is one of FocusDesk's own.
      return globalShortcut.isRegistered(system)
        ? `${accelerator} is already used by another FocusDesk shortcut.`
        : `${accelerator} could not be registered. Another app may be using it.`;
    } catch (err) {
      return `${accelerator} could not be registered: ${messageOf(err)}`;
    }
  }

  /** Let go of what `action` holds. It never throws: letting go of nothing is not an error. */
  function release(action) {
    const accelerator = active[action];
    active[action] = null;
    if (accelerator === null) return;
    try {
      globalShortcut.unregister(toSystem(accelerator));
    } catch (err) {
      log('[shortcuts] could not let go of', accelerator, err);
    }
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
   * Answers, for each: { ok, accelerator, error? }. `accelerator` is what is registered
   * afterwards, null for none, and `error` is why what the setting asked for could not be had.
   *
   * @param {Record<string, unknown> | null | undefined} settings
   */
  function apply(settings) {
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
        answers[action] = { ok: false, accelerator: active[action], error: want.refused };
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
      answers[action] = { ok: false, accelerator: active[action], error: failure };
    }

    return Object.fromEntries(HOTKEY_ACTIONS.map((action) => [action, answers[action]]));
  }

  return {
    apply,
    /** What is registered for each action: the shortcut as it was saved, or null. */
    active: () => ({ ...active }),
  };
}

/**
 * One line for the log: what each shortcut is, or why it is not.
 *
 * @param {Record<string, { ok: boolean, accelerator: string | null, error?: string }>} statuses What apply answered.
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
