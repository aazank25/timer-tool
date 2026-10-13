/** Whether this is a Mac, as the browser (or the desktop app's window) reports it. */
export const isMac = () => /Mac/i.test(navigator.userAgent);

/**
 * Where the desktop app goes on running while its window is closed: the menu bar on a Mac, the
 * system tray on Windows (and Linux).
 */
export const trayName = () => (isMac() ? 'menu bar' : 'system tray');
