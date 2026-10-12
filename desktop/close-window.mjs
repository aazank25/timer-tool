/**
 * What the main window's close button does. Closing the window does not have to stop the app:
 * in the menu bar it keeps the clock, away detection and the reminders going. Some people want
 * that and some want the button to quit, so until it is told, the app asks; "Don't ask again"
 * makes the answer the setting (`close_behavior`), which Settings can change back. Nothing here
 * touches Electron, so the rules can be tested without a window.
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

/** The question's buttons, in the order they are shown. The first is the default. */
export const ASK_BUTTONS = ['Keep running in the menu bar', 'Quit FocusDesk', 'Cancel'];
/** Escape, or closing the question, is Cancel: the window stays as it was. */
export const CANCEL = 2;

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
