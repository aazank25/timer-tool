/**
 * Electron reads a shortcut string leniently: a name it does not know is dropped
 * without a word, so 'Foo+A' registers plain A, and a typo in a modifier registers a
 * shortcut other than the one typed. It cannot say that another app owns a
 * combination either. The first is ours to stop, so a shortcut is only ever stored
 * once it has been read here: the names Electron documents and nothing else, exactly
 * one key, no key named twice, and a modifier that makes it a command.
 *
 * That last rule is what makes the shortcut safe to hold in every app. Shift+A would take
 * every capital A from every app, and on a Mac Option+A is å, so Shift and Alt (Option) do
 * not make a shortcut by themselves: one of Command, Control, CommandOrControl or Super has
 * to be held as well. The function keys type nothing, so F1 to F24 may take any modifier.
 *
 * The desktop app imports this same function through the server bundle, so what a
 * setting accepts and what the app will register can never drift apart.
 */

interface Modifier {
  /** The spelling it is stored under. */
  name: string;
  /**
   * The physical keys it can mean. Two names for one key are a repeat, so Cmd beside
   * Command is refused, and so is CommandOrControl beside either of them: it is the
   * Command key on a Mac and Control everywhere else, so the same text would name one
   * key twice on one platform and two on the other.
   */
  keys: string[];
  /**
   * Whether holding it makes a key press a command and never a character. Shift and Alt do
   * not: Shift+A types a capital A, and on a Mac Option+A types å.
   */
  command: boolean;
}

const COMMAND: Modifier = { name: 'Command', keys: ['command'], command: true };
const CONTROL: Modifier = { name: 'Control', keys: ['control'], command: true };
const COMMAND_OR_CONTROL: Modifier = {
  name: 'CommandOrControl',
  keys: ['command', 'control'],
  command: true,
};
const ALT: Modifier = { name: 'Alt', keys: ['alt'], command: false };
// The Mac's name for the Alt key. Kept as typed, so a Mac user reads back what they wrote.
const OPTION: Modifier = { name: 'Option', keys: ['alt'], command: false };
const SHIFT: Modifier = { name: 'Shift', keys: ['shift'], command: false };
// The Windows key, and the Command key on a Mac.
const SUPER: Modifier = { name: 'Super', keys: ['command', 'super'], command: true };

const MODIFIERS = new Map<string, Modifier>([
  ['command', COMMAND],
  ['cmd', COMMAND],
  ['control', CONTROL],
  ['ctrl', CONTROL],
  ['commandorcontrol', COMMAND_OR_CONTROL],
  ['cmdorctrl', COMMAND_OR_CONTROL],
  ['alt', ALT],
  ['option', OPTION],
  ['shift', SHIFT],
  ['super', SUPER],
  ['meta', SUPER],
]);

/** The keys with a name rather than a character, by the lower-case spelling that reaches them. */
const NAMED_KEYS = new Map<string, string>([
  ['space', 'Space'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['insert', 'Insert'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  // The separator is a plus, so the plus key has to be spelled out.
  ['plus', 'Plus'],
]);

const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/i;

/** A–Z, 0–9 and F1–F24 are the keys Electron takes by their own character. */
function keyName(token: string): string | null {
  if (/^[a-z0-9]$/.test(token) || FUNCTION_KEY.test(token)) return token.toUpperCase();
  return NAMED_KEYS.get(token) ?? null;
}

/**
 * The shortcut spelled one way — each name in its documented long form, in the order it was
 * typed — or null when it is not one Electron will read as written. Case does not matter and
 * neither does space around a plus, which is why 'cmd + shift + k' and 'Command+Shift+K'
 * come back the same.
 */
export function normalizeAccelerator(input: string): string | null {
  // Printable ASCII and nothing else. toLowerCase() turns the Kelvin sign (U+212A) into a plain
  // k, and trim() takes a no-break or an em space off the ends, so text that only looks like a
  // shortcut would otherwise read as one.
  if (!/^[\x20-\x7e]*$/.test(input)) return null;

  const names: string[] = [];
  const taken = new Set<string>();
  let key: string | null = null;
  let command = false;

  for (const raw of input.split('+')) {
    const token = raw.trim().toLowerCase();
    const modifier = MODIFIERS.get(token);
    if (modifier) {
      if (modifier.keys.some((k) => taken.has(k))) return null;
      for (const k of modifier.keys) taken.add(k);
      names.push(modifier.name);
      if (modifier.command) command = true;
      continue;
    }
    const named = keyName(token);
    // Two keys cannot be pressed as one shortcut, and anything else is a name Electron would drop.
    if (named === null || key !== null) return null;
    key = named;
  }

  // A key on its own would take that key from every app, and a modifier on its own is no shortcut.
  if (key === null || names.length === 0) return null;
  // Shift or Alt alone would take a character from every app. The function keys type nothing.
  if (!command && !FUNCTION_KEY.test(key)) return null;
  return [...names, key].join('+');
}

/**
 * The shortcuts FocusDesk registers for itself (desktop/main.mjs), each with what it does,
 * worded to follow "to". A combination can only be registered once, so quick switch cannot
 * have either of these.
 */
export const APP_SHORTCUTS: Readonly<Record<string, string>> = {
  'CommandOrControl+Shift+F': 'show its window',
  'CommandOrControl+Shift+Space': 'pause or resume the block on the clock',
};

/**
 * The keys a normalised shortcut presses, in one order, each modifier named as the key it is
 * on this platform. CommandOrControl is Command on a Mac and Control elsewhere, and Command is
 * the same key as Super (the Windows key) off a Mac.
 */
function pressedKeys(accelerator: string, mac: boolean): string {
  const held = accelerator.split('+');
  const key = held.pop();
  const names = held.map((name) => {
    switch (name) {
      case 'CommandOrControl':
        return mac ? 'command' : 'control';
      case 'Command':
      case 'Super':
        return mac ? 'command' : 'super';
      case 'Control':
        return 'control';
      case 'Alt':
      case 'Option':
        return 'alt';
      default:
        return 'shift';
    }
  });
  return [...names.sort(), key].join('+');
}

/**
 * What FocusDesk itself already uses this shortcut for, or null when it is free. Judged by the
 * keys pressed and not by the text, because Electron does the same when it refuses a second
 * registration: Shift+CommandOrControl+F is CommandOrControl+Shift+F, and Control+Shift+F is
 * too wherever CommandOrControl means Control. Takes a shortcut as normalizeAccelerator returns it.
 */
export function usedByApp(accelerator: string, platform: string = process.platform): string | null {
  const mac = platform === 'darwin';
  const wanted = pressedKeys(accelerator, mac);
  for (const [own, purpose] of Object.entries(APP_SHORTCUTS)) {
    if (pressedKeys(own, mac) === wanted) return purpose;
  }
  return null;
}
