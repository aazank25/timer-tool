import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterAsking,
  ASK_BUTTONS,
  askButtons,
  askDetail,
  askMessage,
  CANCEL,
  CLOSE_BEHAVIORS,
  onClose,
  trayName,
} from '../close-window.mjs';

/** The platforms the desktop app runs on, as process.platform names them. */
const PLATFORMS = ['darwin', 'win32', 'linux'];
const NOT_A_MAC = ['win32', 'linux'];

describe('the close button', () => {
  it('does what the setting says once it has been told', () => {
    assert.equal(onClose('menu-bar'), 'menu-bar');
    assert.equal(onClose('quit'), 'quit');
  });

  it('asks until it has been told, and for anything it does not know', () => {
    for (const setting of ['ask', undefined, null, '', 'Quit', 'hide']) {
      assert.equal(onClose(setting), 'ask', String(setting));
    }
  });

  it('knows the same three values the server accepts', () => {
    assert.deepEqual(CLOSE_BEHAVIORS, ['ask', 'menu-bar', 'quit']);
  });
});

describe('the answer to the question', () => {
  it('keeps the app in the menu bar by default, and quits on the second button', () => {
    assert.equal(ASK_BUTTONS[0], 'Keep running in the menu bar');
    assert.deepEqual(afterAsking({ response: 0 }), { action: 'menu-bar', remember: null });
    assert.deepEqual(afterAsking({ response: 1 }), { action: 'quit', remember: null });
  });

  it('is kept as the setting only when "Don\'t ask again" was ticked', () => {
    assert.deepEqual(afterAsking({ response: 0, checkboxChecked: true }), {
      action: 'menu-bar',
      remember: 'menu-bar',
    });
    assert.deepEqual(afterAsking({ response: 1, checkboxChecked: true }), {
      action: 'quit',
      remember: 'quit',
    });
  });

  it('changes nothing on Cancel or Escape, ticked or not', () => {
    assert.equal(ASK_BUTTONS[CANCEL], 'Cancel');
    assert.deepEqual(afterAsking({ response: CANCEL, checkboxChecked: true }), {
      action: 'cancel',
      remember: null,
    });
    assert.deepEqual(afterAsking({ response: CANCEL }), { action: 'cancel', remember: null });
  });

  it('means the same by each button on every platform, whatever the first is called', () => {
    for (const platform of PLATFORMS) {
      const buttons = askButtons(platform);
      assert.equal(buttons.length, 3, platform);
      // The answers are numbers, the places the buttons are shown in: the first keeps the app
      // running, the second quits, and the last is Cancel, which is also where Escape lands.
      assert.equal(buttons[1], 'Quit FocusDesk', platform);
      assert.equal(buttons[CANCEL], 'Cancel', platform);
      assert.equal(CANCEL, buttons.length - 1, platform);
    }
  });
});

describe('what the question calls the place the app goes on in', () => {
  it('is the menu bar on a Mac, and the system tray on Windows and Linux', () => {
    assert.equal(trayName('darwin'), 'menu bar');
    assert.equal(trayName('win32'), 'system tray');
    assert.equal(trayName('linux'), 'system tray');
  });

  it("is the system tray for a platform it has not heard of: a menu bar is the Mac's alone", () => {
    assert.equal(trayName('freebsd'), 'system tray');
    assert.equal(trayName(undefined), 'system tray');
  });
});

describe('the question, said to a Mac', () => {
  // These are the words it has always had, character for character.
  it('is what it was before there was another platform', () => {
    assert.deepEqual(askButtons('darwin'), [
      'Keep running in the menu bar',
      'Quit FocusDesk',
      'Cancel',
    ]);
    assert.deepEqual(ASK_BUTTONS, askButtons('darwin'));
    assert.equal(askMessage('darwin'), 'Keep FocusDesk running in the menu bar?');
    assert.equal(
      askDetail('darwin'),
      'In the menu bar it keeps the clock, away detection and the reminders going while the window is closed. Quit it any time from its menu-bar icon, or with ⌘Q.',
    );
  });
});

describe('the question, said to Windows and Linux', () => {
  it('calls the place the system tray, in the buttons and the message', () => {
    for (const platform of NOT_A_MAC) {
      assert.equal(askButtons(platform)[0], 'Keep running in the system tray', platform);
      assert.equal(askMessage(platform), 'Keep FocusDesk running in the system tray?', platform);
    }
  });

  it('says how to quit from there without a key that is not there', () => {
    for (const platform of NOT_A_MAC) {
      assert.equal(
        askDetail(platform),
        'In the system tray it keeps the clock, away detection and the reminders going while the window is closed. Quit it any time from its system tray icon.',
        platform,
      );
    }
  });

  it('has no word of a Mac in it', () => {
    for (const platform of NOT_A_MAC) {
      const everything = [...askButtons(platform), askMessage(platform), askDetail(platform)];
      for (const text of everything) {
        assert.doesNotMatch(text, /menu.?bar|dock|⌘|\bcmd\b|command|\bmac\b|finder/i, text);
      }
    }
  });
});
