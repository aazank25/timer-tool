import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterAsking,
  ASK_BUTTONS,
  CANCEL,
  CLOSE_BEHAVIORS,
  onClose,
} from '../close-window.mjs';

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
});
