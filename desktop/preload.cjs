// A preload script has to be CommonJS, which is why this is .cjs in a package whose files are
// modules. It is the whole of what a page in this app can ask of the desktop shell: nothing
// else of Electron, and nothing of Node, is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusdesk', {
  /** Hide the quick-switch window. */
  closePalette: () => ipcRenderer.send('palette:close'),

  /** Run `callback` each time the quick-switch window is shown. Returns what stops it. */
  onPaletteShow: (callback) => {
    // The page is given no event: it carries the sender, which is not the page's to have.
    const listener = () => callback();
    ipcRenderer.on('palette:show', listener);
    return () => ipcRenderer.removeListener('palette:show', listener);
  },

  /**
   * Read the quick-switch shortcut from the settings again and register it. Resolves to
   * { ok, accelerator, error? }: the shortcut registered afterwards, or null when there is
   * none, and when a new one could not be registered, why. The one that was working still is.
   */
  reloadHotkey: () => ipcRenderer.invoke('hotkey:reload'),
});
