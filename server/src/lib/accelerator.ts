/**
 * Electron reads a shortcut string leniently: a name it does not know is dropped
 * without a word, so 'Foo+A' registers plain A, and a typo in a modifier registers a
 * shortcut other than the one typed. It cannot say that another app owns a
 * combination either. The first is ours to stop, so a shortcut is only ever stored
 * once it has been read here: the names Electron documents and nothing else, at
 * least one modifier, exactly one key, and no key named twice.
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
}

const COMMAND: Modifier = { name: 'Command', keys: ['command'] };
const CONTROL: Modifier = { name: 'Control', keys: ['control'] };
const COMMAND_OR_CONTROL: Modifier = { name: 'CommandOrControl', keys: ['command', 'control'] };
const ALT: Modifier = { name: 'Alt', keys: ['alt'] };
// The Mac's name for the Alt key. Kept as typed, so a Mac user reads back what they wrote.
const OPTION: Modifier = { name: 'Option', keys: ['alt'] };
const SHIFT: Modifier = { name: 'Shift', keys: ['shift'] };
// The Windows key, and the Command key on a Mac.
const SUPER: Modifier = { name: 'Super', keys: ['command', 'super'] };

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

/** A–Z, 0–9 and F1–F24 are the keys Electron takes by their own character. */
function keyName(token: string): string | null {
  if (/^[a-z0-9]$/.test(token) || /^f([1-9]|1\d|2[0-4])$/.test(token)) return token.toUpperCase();
  return NAMED_KEYS.get(token) ?? null;
}

/**
 * The shortcut spelled one way — each name in its documented long form, in the order it was
 * typed — or null when it is not one Electron will read as written. Case does not matter and
 * neither does space around a plus, which is why 'cmd + shift + k' and 'Command+Shift+K'
 * come back the same.
 */
export function normalizeAccelerator(input: string): string | null {
  const names: string[] = [];
  const taken = new Set<string>();
  let key: string | null = null;

  for (const raw of input.split('+')) {
    const token = raw.trim().toLowerCase();
    const modifier = MODIFIERS.get(token);
    if (modifier) {
      if (modifier.keys.some((k) => taken.has(k))) return null;
      for (const k of modifier.keys) taken.add(k);
      names.push(modifier.name);
      continue;
    }
    const named = keyName(token);
    // Two keys cannot be pressed as one shortcut, and anything else is a name Electron would drop.
    if (named === null || key !== null) return null;
    key = named;
  }

  // A key on its own would take that key from every app, and a modifier on its own is no shortcut.
  if (key === null || names.length === 0) return null;
  return [...names, key].join('+');
}
