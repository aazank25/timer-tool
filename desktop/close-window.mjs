/**
 * What the main window's close button does. Closing the window does not have to stop the app:
 * in the menu bar (the system tray, on Windows and Linux) it keeps the clock, away detection and
 * the reminders going. Some people want that and some want the button to quit, so until it is
 * told, the app asks; "Don't ask again" makes the answer the setting (`close_behavior`), which
 * Settings can change back. Nothing here touches Electron, so the rules can be tested without a
 * window, and the words take the platform (process.platform) so each system is spoken to in
 * its own terms.
 */

/** The setting's values: ask until told, keep running in the menu bar, or quit. */
export const CLOSE_BEHAVIORS = ['ask', 'menu-bar', 'quit'];

/**
 * What a press of the close button comes to, given the setting. Anything that is not one of the
 * two answers (the settings not read yet, or a value from somewhere else) asks: a close button
 * never quits by surprise, nor hides the app where it may not be found.
 *
 * @param {string | null | undefined} setting
 * @returns {'menu-bar' | 'quit' | 'ask'}
 */
export function onClose(setting) {
  return setting === 'menu-bar' || setting === 'quit' ? setting : 'ask';
}

/**
 * Where the app goes on running once its window is closed, as that system names it: a Mac has a
 * menu bar, Windows and Linux have a system tray, and neither has the other's.
 *
 * @param {string} platform As process.platform says it: 'darwin', 'win32' or 'linux'.
 */
export function trayName(platform) {
  return platform === 'darwin' ? 'menu bar' : 'system tray';
}

/**
 * The question's buttons, in the order they are shown. The first is the default. Cancel is last
 * on every platform, which is where CANCEL points.
 *
 * @param {string} platform
 */
export function askButtons(platform) {
  return [`Keep running in the ${trayName(platform)}`, 'Quit FocusDesk', 'Cancel'];
}

/** The Mac's buttons: what the question said before it knew of another system (see askButtons). */
export const ASK_BUTTONS = askButtons('darwin');
/** Escape, or closing the question, is Cancel: the window stays as it was. */
export const CANCEL = 2;

/**
 * The question itself.
 *
 * @param {string} platform
 */
export function askMessage(platform) {
  return `Keep FocusDesk running in the ${trayName(platform)}?`;
}

/**
 * What goes under the question: what the app keeps doing while its window is closed, and how to
 * quit it from where it is. A Mac has ⌘Q as well; Windows and Linux have no such key, and
 * claiming one there would send people looking for it.
 *
 * @param {string} platform
 */
export function askDetail(platform) {
  const mac = platform === 'darwin';
  const place = trayName(platform);
  return `In the ${place} it keeps the clock, away detection and the reminders going while the window is closed. Quit it any time from its ${mac ? 'menu-bar' : place} icon${mac ? ', or with ⌘Q' : ''}.`;
}

/**
 * What an answer to the question comes to: what to do now, and what to keep as the setting when
 * "Don't ask again" was ticked. Cancel is not an answer, so it keeps nothing.
 *
 * @param {{ response: number, checkboxChecked?: boolean }} answer As dialog.showMessageBox gives it.
 * @returns {{ action: 'menu-bar' | 'quit' | 'cancel', remember: 'menu-bar' | 'quit' | null }}
 */
export function afterAsking({ response, checkboxChecked = false }) {
  const action = response === 0 ? 'menu-bar' : response === 1 ? 'quit' : 'cancel';
  return { action, remember: checkboxChecked && action !== 'cancel' ? action : null };
}
