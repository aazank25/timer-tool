import { isMac } from './platform';

/** How a Mac draws each modifier and key whose name is not what is on the keycap. */
const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Super: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Enter: '↩',
  Escape: '⎋',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Plus: '+',
};

/** The same keys as another keyboard names them. */
const OTHER_NAMES: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  // Electron registers Command off a Mac as the Windows key, as it does Super.
  Command: 'Win',
  Control: 'Ctrl',
  Super: 'Win',
  Escape: 'Esc',
};

/**
 * An Electron accelerator as it is written on the keys: CommandOrControl+Alt+K is ⌘⌥K. That is
 * how FocusDesk writes shortcuts everywhere (it is a Mac app first), so it is how they are shown
 * here; on another keyboard, which has no ⌘, the keys are named after it, as in ⌘⌥K (Ctrl+Alt+K).
 * Display only: what is stored and registered is the accelerator.
 */
export function formatShortcut(accelerator: string): string {
  const parts = accelerator.split('+');
  const glyphs = parts.map((part) => MAC_SYMBOLS[part] ?? part).join('');
  if (isMac()) return glyphs;
  return `${glyphs} (${parts.map((part) => OTHER_NAMES[part] ?? part).join('+')})`;
}

/* -------------------------------------------------------------- recording */

/** The parts of a key press that the recorder reads. A KeyboardEvent has every one of them. */
export interface KeyPress {
  /**
   * The physical key, as KeyboardEvent.code names it: 'KeyK', 'Digit5', 'F5', 'Space', 'ArrowUp'.
   * Never KeyboardEvent.key, which is what the key types and not which key it is: on a Mac,
   * Option+K types '˚'.
   */
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * What a keyboard layout makes of each key: the browser's KeyboardLayoutMap, from
 * navigator.keyboard.getLayoutMap() (Chromium has it; Firefox and Safari do not), which a Map of
 * the same shape stands in for. It is asked by KeyboardEvent.code and answers with what the key
 * types with nothing held: 'a' for KeyQ on a French keyboard, 'é' for Digit2.
 */
export interface KeyLayout {
  get(code: string): string | undefined;
}

/**
 * What one key press means to the recorder. Every kind that says no carries `hint`, a sentence
 * for the person that says why and what to try, so the words are in one place and the card only
 * shows them.
 */
export type Recorded =
  /** Only modifiers are down so far. Keep listening. */
  | { kind: 'waiting' }
  /** Escape on its own: stop, and change nothing. */
  | { kind: 'cancel' }
  /**
   * A key no shortcut can be made of, such as a punctuation key, the = key, or a key that types
   * a letter with an accent on this layout. Keep listening.
   */
  | { kind: 'unusable'; hint: string }
  /**
   * A key that would take ordinary typing from every app: pressed with no modifier, or with
   * Shift or Alt (Option) alone. The server refuses it, so it is said at once. Keep listening.
   */
  | { kind: 'too-loose'; hint: string }
  /**
   * A combination that is already something in every app or in the system (⌘C, Alt+F4, ...): see
   * reservedKind. The server refuses it, so it is said at once. Keep listening.
   */
  | { kind: 'reserved'; hint: string }
  /** The shortcut, in the spelling the server stores it in. */
  | { kind: 'shortcut'; accelerator: string };

/**
 * The key of each KeyboardEvent.code that a shortcut can be made of, under the name the server
 * knows it by (normalizeAccelerator, server/src/lib/accelerator.ts). Letters, digits and the
 * function keys are matched by their pattern, below. Everything else, the punctuation keys, the
 * numeric keypad, the lock keys and the media keys among them, is left out because the server
 * refuses it.
 *
 * The key that types = is left out on purpose. Electron has one name for it, Plus, and that
 * means Shift and = together, so a shortcut recorded from = would register a key press that was
 * not the one made. The server still takes 'Plus' when it is typed (see EQUAL_HINT).
 */
const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** The keys that are only a modifier. Pressing one is not yet a shortcut. */
const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'AltGraph',
  'MetaLeft',
  'MetaRight',
  // What Firefox used to call the Windows key and the Command key.
  'OSLeft',
  'OSRight',
  'Fn',
]);

/** A–Z, 0–9 and F1–F24 under the name the server takes, any other key by KEY_NAMES, else null. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return digit;
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(code)?.[1];
  if (fn) return `F${fn}`;
  return KEY_NAMES[code] ?? null;
}

/** The keys whose place on the keyboard is not always what they type: the letters and the digits. */
const POSITIONAL = /^(?:Key[A-Z]|Digit[0-9])$/;

const TRY_INSTEAD = 'Try a letter, a number, an F key, Space or an arrow.';

/** Said of a key that is no part of any shortcut: a punctuation key, the numeric keypad, a lock key. */
const UNUSABLE_HINT = `That key cannot be part of a shortcut. ${TRY_INSTEAD}`;

/**
 * Said of the key that types =. Electron's one name for it is Plus, which means Shift and =
 * together, so the shortcut that was saved would be a key press that was not made.
 */
const EQUAL_HINT = `The = key cannot be part of a shortcut: the app would register Shift and = for it, which is not what you pressed. ${TRY_INSTEAD}`;

/** Said of a key that types something other than a letter or a digit on the layout in use: é, ç, &. */
function layoutHint(typed: string): string {
  const types = typed.trim() === '' ? 'nothing' : `“${typed}”`;
  return `That key types ${types} on your keyboard layout, and a shortcut can only use a plain letter or a number. ${TRY_INSTEAD}`;
}

/**
 * The name the server takes for the key that was pressed, or the hint that says why it has none.
 *
 * Off a Mac a shortcut is registered by what the key types on the layout in use (Windows
 * takes the character, X11 the symbol) and not by where the key is: on a French keyboard the key
 * in the Q position types a, and recorded by its position it would be saved as Q, and a press of
 * A would register Q. So where the layout is known the letters and digits are read from it, and a
 * key that types anything else on it (é, ç) is no key for a shortcut. A Mac registers by position,
 * so `layout` is not looked at there, and without one (a browser that cannot say) every key is
 * read by its position.
 */
function keyOf(
  code: string,
  mac: boolean,
  layout: KeyLayout | null | undefined,
): { key: string } | { hint: string } {
  if (code === 'Equal') return { hint: EQUAL_HINT };
  if (!mac && layout && POSITIONAL.test(code)) {
    const typed = layout.get(code);
    if (typed !== undefined) {
      // Plain ASCII before the capital, because 'ı'.toUpperCase() is an I and 'ß' is two letters.
      return /^[A-Za-z0-9]$/.test(typed)
        ? { key: typed.toUpperCase() }
        : { hint: layoutHint(typed) };
    }
  }
  const key = keyName(code);
  return key === null ? { hint: UNUSABLE_HINT } : { key };
}

/** What a combination already is, if it is one the system or every app has: see reservedKind in the server. */
type Reserved = 'everyday' | 'redo' | 'windows' | 'spotlight';

/** The letters, and Tab, that every app answers to when the command key is held with them alone. */
const EVERYDAY_KEYS = new Set('ACFHMNOPQRSTVWXZ'.split('').concat('Tab'));

/**
 * Whether the keys that were pressed are a shortcut that every app or the system already has:
 * the command key alone with A C F H M N O P Q R S T V W X Z or Tab; redo (Shift and the command
 * key with Z); Alt+F4 and Alt+Tab; and Command+Space, which is Spotlight. The server refuses the
 * same set (reservedKind in server/src/lib/accelerator.ts), which is written out again here
 * because this runs before anything is sent. `names` are the modifiers as recordKeyPress names
 * them; the Windows key (Super) is not a command key, so it is none of these.
 */
function reservedKind(names: readonly string[], key: string): Reserved | null {
  const isCommand = (name: string) => name === 'Command' || name === 'Control';
  if (names.length === 1) {
    const [only] = names;
    if (only !== undefined && isCommand(only)) {
      if (EVERYDAY_KEYS.has(key)) return 'everyday';
      if (key === 'Space' && only === 'Command') return 'spotlight';
    } else if (only === 'Alt' && (key === 'F4' || key === 'Tab')) {
      return 'windows';
    }
    return null;
  }
  if (names.length === 2 && key === 'Z' && names.includes('Shift') && names.some(isCommand)) {
    return 'redo';
  }
  return null;
}

/** How each modifier is drawn on a Mac's keys. */
const MODIFIER_GLYPHS: Record<string, string> = {
  Command: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
};

/** The same keys on another keyboard, where there is no ⌘ and the Windows key is Super. */
const MODIFIER_WORDS: Record<string, string> = {
  Control: 'Ctrl',
  Super: 'Win',
  Alt: 'Alt',
  Shift: 'Shift',
};

/** `names` as written on the keys: ⌘⇧ on a Mac, Ctrl+Shift elsewhere. */
function modifiersAs(names: readonly string[], mac: boolean): string {
  return mac
    ? names.map((name) => MODIFIER_GLYPHS[name] ?? name).join('')
    : names.map((name) => MODIFIER_WORDS[name] ?? name).join('+');
}

/** What is said of a combination that is already something, in the keys of this system. */
function reservedHint(kind: Reserved, names: readonly string[], key: string, mac: boolean): string {
  const mods = modifiersAs(names, mac);
  const shown = mac ? `${mods}${key}` : `${mods}+${key}`;
  const withExtra = (extra: 'Shift' | 'Alt') =>
    mac ? `${mods}${MODIFIER_GLYPHS[extra]}` : `${mods}+${extra}`;
  const instead = `pick one with ${withExtra('Shift')} or ${withExtra('Alt')} instead.`;
  switch (kind) {
    case 'everyday':
      return `${shown} is a shortcut every app uses; ${instead}`;
    case 'spotlight':
      return `${shown} opens Spotlight on a Mac; ${instead}`;
    case 'redo':
      return `${shown} is redo in nearly every app; pick another key.`;
    case 'windows':
      return key === 'F4'
        ? 'Alt+F4 closes a window on Windows; pick another shortcut.'
        : 'Alt+Tab switches between windows on Windows; pick another shortcut.';
  }
}

/** Said of a key pressed with too few modifiers: it would take that key from every app. */
function looseHint(mac: boolean): string {
  return `Hold ${mac ? '⌘ or ⌃' : 'Ctrl'} as well, or the shortcut would take that key away from every app (F1–F24 can go with Shift or Alt alone).`;
}

/**
 * A key press as a shortcut. On a Mac the Command key is Command and the Control key is
 * Control; elsewhere Control is Control and the Windows key is Super. Alt is Alt and Shift is
 * Shift everywhere. The modifiers come in that order, then the key.
 *
 * A key that cannot be part of a shortcut, or that makes one that is already something (⌘C), or
 * that would take ordinary typing from every app, comes back with a hint and is not recorded.
 * Off a Mac `layout` says what each key types, so that the letters and digits are recorded as
 * what they type and not as where they are (see keyOf).
 *
 * Pure, so that it can be tried on made-up events: `mac` and `layout` are passed in, not read
 * from the browser.
 */
export function recordKeyPress(press: KeyPress, mac: boolean, layout?: KeyLayout | null): Recorded {
  if (MODIFIER_CODES.has(press.code)) return { kind: 'waiting' };
  const held = press.metaKey || press.ctrlKey || press.altKey || press.shiftKey;
  if (press.code === 'Escape' && !held) return { kind: 'cancel' };

  const named = keyOf(press.code, mac, layout);
  if ('hint' in named) return { kind: 'unusable', hint: named.hint };
  const { key } = named;

  const modifiers: (string | false)[] = mac
    ? [press.metaKey && 'Command', press.ctrlKey && 'Control']
    : [press.ctrlKey && 'Control', press.metaKey && 'Super'];
  modifiers.push(press.altKey && 'Alt', press.shiftKey && 'Shift');
  const names = modifiers.filter((name): name is string => name !== false);

  // Before the next rule, so that Alt+Tab is told what it is and not only that Alt is not enough.
  const reserved = reservedKind(names, key);
  if (reserved !== null) {
    return { kind: 'reserved', hint: reservedHint(reserved, names, key, mac) };
  }

  // A function key types nothing, so it may take any modifier. Every other key needs Command,
  // Control or Super, or the shortcut would take that key away from every app.
  const command = press.metaKey || press.ctrlKey;
  if (!held || (!command && !/^F\d+$/.test(key))) {
    return { kind: 'too-loose', hint: looseHint(mac) };
  }

  return { kind: 'shortcut', accelerator: [...names, key].join('+') };
}

/**
 * The keys a shortcut presses on this system, in one order: CommandOrControl is Command on a Mac
 * and Control elsewhere, and Command is the Windows key off a Mac, the same as Super. The server
 * reads them the same way (pressedKeys in server/src/lib/accelerator.ts) when it decides that
 * two shortcuts are one.
 */
function pressedKeys(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+');
  const key = parts.pop();
  const modifiers = parts.map((name) => {
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
  return [...modifiers.sort(), key].join('+');
}

/**
 * Whether two shortcuts are the same keys on this system, however they are spelled: the Command
 * key recorded on a Mac is the CommandOrControl that ships. Takes shortcuts as the server stores them.
 */
export function sameShortcut(a: string, b: string, mac: boolean = isMac()): boolean {
  return pressedKeys(a, mac) === pressedKeys(b, mac);
}
