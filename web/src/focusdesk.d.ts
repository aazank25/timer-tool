/**
 * What the desktop app's preload script (desktop/preload.cjs) puts on `window`. A plain
 * browser has none of it, so every use is optional-chained.
 *
 * An interface of its own, so what the desktop adds later can be declared beside the code that
 * uses it, with another `interface FocusdeskBridge { … }` that merges into this one.
 */

/** Where one of the three shortcuts stands after the app has tried to register it. */
interface HotkeyStatus {
  /** False when the shortcut is set but could not be registered; `error` says why. */
  ok: boolean;
  /** The shortcut that is registered, in the spelling the setting stores. Null when it is off. */
  accelerator: string | null;
  error?: string;
}

interface FocusdeskBridge {
  /** Hide the quick-switch window. */
  closePalette(): void;
  /** Runs each time the quick-switch window is shown. Returns the call that stops listening. */
  onPaletteShow(callback: () => void): () => void;
  /**
   * Read the three shortcut settings again and register them: show the window, pause or resume,
   * and quick switch. Says how each one stands, so a shortcut that another app holds is not a
   * silent failure.
   */
  reloadHotkeys(): Promise<{
    show: HotkeyStatus;
    pause: HotkeyStatus;
    quickSwitch: HotkeyStatus;
  }>;
  /**
   * Show a sample notification from the operating system, whatever the notification settings
   * say, so that what the system does with FocusDesk's notifications can be seen. `error` is why
   * it could not be shown.
   */
  testNotification(): Promise<{ ok: boolean; error?: string }>;
}

interface Window {
  focusdesk?: FocusdeskBridge;
}
