// A preload script has to be CommonJS, which is why this is .cjs in a package whose files are
// modules. It is the whole of what a page in this app can ask of the desktop shell: nothing
// else of Electron, and nothing of Node, is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusdesk', {
  /** Hide the quick-switch window. */
  closePalette: () => ipcRenderer.send('palette:close'),

  /** Run `callback` each time the quick-switch window is shown. Returns what stops it. */
  onPaletteShow: (callback) => {
    // Not a function, so there is nothing to run: it would otherwise throw from inside the
    // listener on every show.
    if (typeof callback !== 'function') return () => {};
    // The page is given no event: it carries the sender, which is not the page's to have.
    const listener = () => callback();
    ipcRenderer.on('palette:show', listener);
    return () => ipcRenderer.removeListener('palette:show', listener);
  },

  /**
   * Read the settings again and register the three shortcuts that work in any app (show the
   * window, pause or resume, quick switch) as they say. Resolves to
   * { show, pause, quickSwitch }, each { ok, accelerator, code?, error? }: the shortcut registered
   * afterwards, or null when there is none (it is off), and when a new one could not be
   * registered, why (`error`) and which kind of why (`code`: 'taken', 'invalid', or 'unreadable'
   * when the settings could not be read and nothing was tried). The one that was working still is.
   */
  reloadHotkeys: () => ipcRenderer.invoke('hotkeys:reload'),

  /**
   * Let go of every shortcut that works in any app (true), or take them again as the settings say
   * (false). A key FocusDesk holds goes to its action and never reaches the page, so a page that
   * listens for a key to record has to ask for them to be let go of first, and give them back
   * when it stops listening. Resolves when it is done.
   *
   * The app takes them back by itself if the window loses the focus, is hidden or closed, or the
   * page is reloaded, moved to another address or crashes, and after a minute at most, so a page
   * that never says so does not leave the person without them. Anything that is not exactly
   * true takes them back: it is a request to let go of them only when it clearly is.
   */
  suspendHotkeys: (on) => ipcRenderer.invoke('hotkeys:suspend', on === true),

  /**
   * Show a sample notification now, whatever the notification settings say and whether or not
   * you are at the machine. Resolves to { ok, error? }: not ok when this system cannot show one.
   */
  testNotification: () => ipcRenderer.invoke('notification:test'),
});
