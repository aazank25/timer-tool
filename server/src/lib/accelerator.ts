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
 * A shortcut that is already something is refused too, since registering it would take it from
 * every app (or fail without a word, where the system keeps it): see reservedKind. The command
 * key and one of the keys every app answers to (Copy, Paste, Save, Quit and the like) is one, so
 * are redo, Alt+F4, Alt+Tab and Spotlight. Adding Shift or Alt makes it another shortcut.
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

/** Why a shortcut is refused as one the system or every app already has: see reservedKind. */
export type ReservedKind = 'everyday' | 'redo' | 'windows' | 'spotlight';

/** The command key held by itself, in any of the names the settings take for it. */
const COMMAND_NAMES = new Set(['Command', 'Control', 'CommandOrControl']);

/**
 * The keys that every app answers to when the command key is held with them and nothing else:
 * Select all, Copy, Find, Hide, Minimize, New, Open, Print, Quit, Reload, Save, a new Tab, Paste,
 * Close, Cut and Undo, and Tab, which switches between apps or tabs. Written as the key names
 * normalizeAccelerator gives them (capital letters, Tab).
 */
const EVERYDAY_KEYS = new Set('ACFHMNOPQRSTVWXZ'.split('').concat('Tab'));

/**
 * What a shortcut already is, when it is one the system or every app has: null for any other.
 * `names` are its modifiers and `key` its key, both as normalizeAccelerator spells them.
 *
 * Only the exact combination is refused. Held with another modifier it is a different shortcut:
 * ⌘⇧F and ⌘⇧Space, which ship, are not Find or Spotlight.
 *
 *   everyday   the command key alone with A C F H M N O P Q R S T V W X Z or Tab
 *   redo       Shift and the command key with Z
 *   windows    Alt alone with F4 (close the window) or Tab (switch between windows)
 *   spotlight  Command or CommandOrControl alone with Space. CommandOrControl is Command on a
 *              Mac, and the same text has to mean the same on every machine. Control+Space is
 *              not Spotlight.
 *
 * "The command key" is Command, Control or CommandOrControl, and `mac` adds Super to them, which
 * is the Command key on a Mac (and the Windows key elsewhere, which is none of these).
 */
export function reservedKind(
  names: readonly string[],
  key: string,
  mac: boolean = process.platform === 'darwin',
): ReservedKind | null {
  const isCommand = (name: string) => COMMAND_NAMES.has(name) || (mac && name === 'Super');
  if (names.length === 1) {
    const [only] = names;
    if (only === undefined) return null;
    if (isCommand(only)) {
      if (EVERYDAY_KEYS.has(key)) return 'everyday';
      if (key === 'Space' && only !== 'Control') return 'spotlight';
    } else if ((only === 'Alt' || only === 'Option') && (key === 'F4' || key === 'Tab')) {
      return 'windows';
    }
    return null;
  }
  // Two modifiers, one of them Shift and the other the command key: redo.
  if (names.length === 2 && key === 'Z' && names.includes('Shift') && names.some(isCommand)) {
    return 'redo';
  }
  return null;
}

/** The sentence that says why `accelerator` (as normalizeAccelerator spells it) is refused as `kind`. */
function reservedMessage(accelerator: string, kind: ReservedKind): string {
  const [first = ''] = accelerator.split('+');
  switch (kind) {
    case 'everyday':
      return `${accelerator} is a shortcut every app uses; pick one with ${first}+Shift or ${first}+Alt instead`;
    case 'redo':
      return `${accelerator} is redo in nearly every app; pick another key`;
    case 'windows':
      return accelerator.endsWith('+F4')
        ? `${accelerator} closes a window on Windows; pick another shortcut`
        : `${accelerator} switches between windows on Windows; pick another shortcut`;
    case 'spotlight':
      return `${accelerator} opens Spotlight on a Mac; pick one with ${first}+Shift or ${first}+Alt instead`;
  }
}

/** What readAccelerator made of a shortcut: the shortcut as saved, or why it is not one. */
export type AcceleratorReading =
  | { ok: true; accelerator: string }
  /** Not a shortcut Electron will read as written, or one that would take a key from every app. */
  | { ok: false; reason: 'invalid' }
  /** A shortcut, but one the system or every app already has. `message` says which, for a person. */
  | { ok: false; reason: 'reserved'; message: string };

const INVALID: AcceleratorReading = { ok: false, reason: 'invalid' };

/**
 * normalizeAccelerator, with the reason when it says no: the shortcut as saved, or whether it is
 * not a shortcut at all or is one that is already something (with the sentence that says what),
 * so that a refusal can tell the two apart. `mac` is for reservedKind.
 */
export function readAccelerator(
  input: string,
  mac: boolean = process.platform === 'darwin',
): AcceleratorReading {
  // Printable ASCII and nothing else. toLowerCase() turns the Kelvin sign (U+212A) into a plain
  // k, and trim() takes a no-break or an em space off the ends, so text that only looks like a
  // shortcut would otherwise read as one.
  if (!/^[\x20-\x7e]*$/.test(input)) return INVALID;

  const names: string[] = [];
  const taken = new Set<string>();
  let key: string | null = null;
  let command = false;

  for (const raw of input.split('+')) {
    const token = raw.trim().toLowerCase();
    const modifier = MODIFIERS.get(token);
    if (modifier) {
      if (modifier.keys.some((k) => taken.has(k))) return INVALID;
      for (const k of modifier.keys) taken.add(k);
      names.push(modifier.name);
      if (modifier.command) command = true;
      continue;
    }
    const named = keyName(token);
    // Two keys cannot be pressed as one shortcut, and anything else is a name Electron would drop.
    if (named === null || key !== null) return INVALID;
    key = named;
  }

  // A key on its own would take that key from every app, and a modifier on its own is no shortcut.
  if (key === null || names.length === 0) return INVALID;
  const accelerator = [...names, key].join('+');
  // Before the rule below, so that Alt+Tab is told what it is and not only that Alt is not enough.
  const kind = reservedKind(names, key, mac);
  if (kind !== null) return { ok: false, reason: 'reserved', message: reservedMessage(accelerator, kind) };
  // Shift or Alt alone would take a character from every app. The function keys type nothing.
  if (!command && !FUNCTION_KEY.test(key)) return INVALID;
  return { ok: true, accelerator };
}

/**
 * The shortcut spelled one way — each name in its documented long form, in the order it was
 * typed — or null when it is not one Electron will read as written, or is one that is already
 * something (see reservedKind). Case does not matter and neither does space around a plus, which
 * is why 'cmd + shift + k' and 'Command+Shift+K' come back the same.
 */
export function normalizeAccelerator(input: string): string | null {
  const read = readAccelerator(input);
  return read.ok ? read.accelerator : null;
}

/**
 * The three shortcuts FocusDesk can register for every app, by the setting that holds each, with
 * what each does, worded to follow "the shortcut to". A combination can only be registered once,
 * so no two of the three may be the same.
 */
export const HOTKEY_ACTIONS = {
  show_hotkey: 'show FocusDesk',
  pause_hotkey: 'pause or resume the block on the clock',
  quick_switch_hotkey: 'open quick switch',
} as const;

export type HotkeySetting = keyof typeof HOTKEY_ACTIONS;

/** The three settings, in the order the settings screen lists them. */
export const HOTKEY_SETTINGS = Object.keys(HOTKEY_ACTIONS) as HotkeySetting[];

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
 * The first two of the three shortcuts that are the same one, as a sentence that says which
 * action already has it, or null when each is its own. `hotkeys` is what all three settings will
 * hold. An empty one is off and never clashes, and a value that is not a shortcut is for
 * normalizeAccelerator to refuse, not for this. `written` is the settings this change sets: the
 * one that gives way is one of those (the later of two, when both are), so the sentence names the
 * action that had the shortcut before.
 *
 * Judged by the keys pressed and not by the text, because Electron does the same when it refuses
 * a second registration: Shift+CommandOrControl+F is CommandOrControl+Shift+F, and Control+Shift+F
 * is too wherever CommandOrControl means Control. The shortcut in the sentence is spelled as
 * normalizeAccelerator spells it.
 */
export function hotkeyClash(
  hotkeys: Readonly<Record<HotkeySetting, string>>,
  written: readonly HotkeySetting[] = HOTKEY_SETTINGS,
  platform: string = process.platform,
): string | null {
  const mac = platform === 'darwin';
  const held = HOTKEY_SETTINGS.flatMap((setting) => {
    const accelerator = normalizeAccelerator(hotkeys[setting]);
    return accelerator === null
      ? []
      : [{ setting, accelerator, pressed: pressedKeys(accelerator, mac) }];
  });
  for (const [i, first] of held.entries()) {
    for (const second of held.slice(i + 1)) {
      if (first.pressed !== second.pressed) continue;
      const firstGivesWay = written.includes(first.setting) && !written.includes(second.setting);
      const [giver, owner] = firstGivesWay ? [first, second] : [second, first];
      return `${giver.accelerator} is already the shortcut to ${HOTKEY_ACTIONS[owner.setting]}`;
    }
  }
  return null;
}
