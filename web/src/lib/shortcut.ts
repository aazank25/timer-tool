const isMac = () => /Mac/i.test(navigator.userAgent);

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
  Command: 'Cmd',
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
