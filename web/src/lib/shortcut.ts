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

/** What one key press means to the recorder. */
export type Recorded =
  /** Only modifiers are down so far. Keep listening. */
  | { kind: 'waiting' }
  /** Escape on its own: stop, and change nothing. */
  | { kind: 'cancel' }
  /** A key no shortcut can be made of, such as a punctuation key. Keep listening. */
  | { kind: 'unusable' }
  /**
   * A key that would take ordinary typing from every app: pressed with no modifier, or with
   * Shift or Alt (Option) alone. The server refuses it, so it is said at once. Keep listening.
   */
  | { kind: 'too-loose' }
  /** The shortcut, in the spelling the server stores it in. */
  | { kind: 'shortcut'; accelerator: string };

/**
 * The key of each KeyboardEvent.code that a shortcut can be made of, under the name the server
 * knows it by (normalizeAccelerator, server/src/lib/accelerator.ts). Letters, digits and the
 * function keys are matched by their pattern, below. Everything else, the punctuation keys, the
 * numeric keypad, the lock keys and the media keys among them, is left out because the server
 * refuses it.
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
  // The key that types = and, with Shift, +. Electron's name for it is Plus.
  Equal: 'Plus',
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

/**
 * A key press as a shortcut. On a Mac the Command key is Command and the Control key is
 * Control; elsewhere Control is Control and the Windows key is Super. Alt is Alt and Shift is
 * Shift everywhere. The modifiers come in that order, then the key.
 *
 * Pure, so that it can be tried on made-up events: `mac` is passed in, not read from the browser.
 */
export function recordKeyPress(press: KeyPress, mac: boolean): Recorded {
  if (MODIFIER_CODES.has(press.code)) return { kind: 'waiting' };
  const held = press.metaKey || press.ctrlKey || press.altKey || press.shiftKey;
  if (press.code === 'Escape' && !held) return { kind: 'cancel' };

  const key = keyName(press.code);
  if (key === null) return { kind: 'unusable' };

  // A function key types nothing, so it may take any modifier. Every other key needs Command,
  // Control or Super, or the shortcut would take that key away from every app.
  const command = press.metaKey || press.ctrlKey;
  if (!held || (!command && !/^F\d+$/.test(key))) return { kind: 'too-loose' };

  const modifiers: (string | false)[] = mac
    ? [press.metaKey && 'Command', press.ctrlKey && 'Control']
    : [press.ctrlKey && 'Control', press.metaKey && 'Super'];
  modifiers.push(press.altKey && 'Alt', press.shiftKey && 'Shift');
  const names = modifiers.filter((name): name is string => name !== false);
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
