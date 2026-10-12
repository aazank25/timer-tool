/**
 * What the desktop app's preload script (desktop/preload.cjs) puts on `window`. A plain
 * browser has none of it, so every use is optional-chained.
 *
 * An interface of its own, so what the desktop adds later can be declared beside the code that
 * uses it, with another `interface FocusdeskBridge { … }` that merges into this one.
 */
interface FocusdeskBridge {
  /** Hide the quick-switch window. */
  closePalette(): void;
  /** Runs each time the quick-switch window is shown. Returns the call that stops listening. */
  onPaletteShow(callback: () => void): () => void;
  /**
   * Read the shortcut setting again and register it. `accelerator` is the one registered
   * afterwards, null when there is none; when `ok` is false the one that was there before
   * still is, and `error` says why the new one could not be.
   */
  reloadHotkey(): Promise<{ ok: boolean; accelerator: string | null; error?: string }>;
}

interface Window {
  focusdesk?: FocusdeskBridge;
}
