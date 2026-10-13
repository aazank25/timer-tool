import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recordKeyPress, sameShortcut, type KeyLayout, type KeyPress } from '../src/lib/shortcut';

/**
 * What the recorder makes of a key press (recordKeyPress) and when two shortcuts are one
 * (sameShortcut). Both are pure and are given everything they need, so they are run here on
 * made-up key presses, as a Mac and as another keyboard, without a browser. The server refuses
 * the same combinations (server/test/shortcuts.test.ts); these are the recorder's side of it.
 */

/** A key press with nothing held, unless it is said. */
const press = (code: string, held: Partial<Omit<KeyPress, 'code'>> = {}): KeyPress => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

/** What each modifier is, as a KeyPress says it. */
const CMD = { metaKey: true };
const CTRL = { ctrlKey: true };
const ALT = { altKey: true };
const SHIFT = { shiftKey: true };

const shortcut = (accelerator: string) => ({ kind: 'shortcut', accelerator });

/** A French keyboard as the browser reports it: the key in Q's place types a, and the digits are accented. */
const AZERTY: KeyLayout = new Map([
  ['KeyQ', 'a'],
  ['KeyA', 'q'],
  ['KeyW', 'z'],
  ['KeyZ', 'w'],
  ['KeyM', ','],
  ['Digit1', '&'],
  ['Digit2', 'é'],
  ['Digit7', 'è'],
  ['Digit9', 'ç'],
  ['Digit0', 'à'],
]);

describe('a key press as a shortcut', () => {
  it('is the modifiers in one order, then the key: Command, Control, Alt, Shift on a Mac', () => {
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CMD, ...ALT }), true), shortcut('Command+Alt+K'));
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CMD, ...SHIFT }), true), shortcut('Command+Shift+K'));
    assert.deepEqual(
      recordKeyPress(press('KeyK', { ...SHIFT, ...ALT, ...CTRL, ...CMD }), true),
      shortcut('Command+Control+Alt+Shift+K'),
    );
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CTRL, ...ALT }), true), shortcut('Control+Alt+K'));
  });

  it('is Control, Super, Alt, Shift off a Mac, where the Windows key is Super and not Command', () => {
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CTRL, ...ALT }), false), shortcut('Control+Alt+K'));
    assert.deepEqual(recordKeyPress(press('KeyJ', { ...CMD, ...ALT }), false), shortcut('Super+Alt+J'));
    assert.deepEqual(
      recordKeyPress(press('KeyK', { ...SHIFT, ...ALT, ...CMD, ...CTRL }), false),
      shortcut('Control+Super+Alt+Shift+K'),
    );
  });

  it('is named by the key and not by what it types: Option+K on a Mac types ˚ and is K', () => {
    // A KeyboardEvent has the character in `key`; the recorder is not given it, only the code.
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CMD, ...ALT }), true), shortcut('Command+Alt+K'));
  });

  it('is any letter, any digit and any function key from F1 to F24, and not F25', () => {
    for (const mac of [true, false]) {
      const held = mac ? CMD : CTRL;
      const name = mac ? 'Command' : 'Control';
      for (const letter of 'BDEGIJKLUY') {
        assert.deepEqual(
          recordKeyPress(press(`Key${letter}`, { ...held, ...ALT }), mac),
          shortcut(`${name}+Alt+${letter}`),
        );
      }
      for (const digit of '0123456789') {
        assert.deepEqual(
          recordKeyPress(press(`Digit${digit}`, { ...held, ...SHIFT }), mac),
          shortcut(`${name}+Shift+${digit}`),
        );
      }
      for (let n = 1; n <= 24; n++) {
        assert.deepEqual(recordKeyPress(press(`F${n}`, held), mac), shortcut(`${name}+F${n}`), `F${n}`);
      }
      assert.equal(recordKeyPress(press('F25', held), mac).kind, 'unusable');
      assert.equal(recordKeyPress(press('F0', held), mac).kind, 'unusable');
    }
  });

  it('is a function key with Shift or Alt alone, which type nothing, but not with nothing at all', () => {
    for (const mac of [true, false]) {
      assert.deepEqual(recordKeyPress(press('F5', SHIFT), mac), shortcut('Shift+F5'));
      assert.deepEqual(recordKeyPress(press('F12', ALT), mac), shortcut('Alt+F12'));
      assert.deepEqual(recordKeyPress(press('F12', { ...ALT, ...SHIFT }), mac), shortcut('Alt+Shift+F12'));
      // A key with nothing held is every app's, whether it types or not.
      assert.equal(recordKeyPress(press('F5'), mac).kind, 'too-loose');
    }
  });

  it('is Space, Tab, Enter, Backspace, Delete, Insert, the arrows, Home, End, PageUp and PageDown, by their names', () => {
    const named: [code: string, name: string][] = [
      ['Space', 'Space'],
      ['Tab', 'Tab'],
      ['Enter', 'Enter'],
      ['Backspace', 'Backspace'],
      ['Delete', 'Delete'],
      ['Insert', 'Insert'],
      ['ArrowUp', 'Up'],
      ['ArrowDown', 'Down'],
      ['ArrowLeft', 'Left'],
      ['ArrowRight', 'Right'],
      ['Home', 'Home'],
      ['End', 'End'],
      ['PageUp', 'PageUp'],
      ['PageDown', 'PageDown'],
    ];
    for (const [code, name] of named) {
      // With Shift as well, so that none of them is a combination the system already has.
      assert.deepEqual(recordKeyPress(press(code, { ...CMD, ...SHIFT }), true), shortcut(`Command+Shift+${name}`), code);
      assert.deepEqual(recordKeyPress(press(code, { ...CTRL, ...SHIFT }), false), shortcut(`Control+Shift+${name}`), code);
    }
  });

  it('is the same on a Mac and elsewhere for the keys that have no modifier of their own to name', () => {
    for (const mac of [true, false]) {
      assert.deepEqual(recordKeyPress(press('KeyK', { ...ALT, ...SHIFT, ...CTRL }), mac).kind, 'shortcut');
    }
  });

  it('is the three shortcuts that ship, as they are recorded', () => {
    // On a Mac the Command key; elsewhere Control. Each is a valid shortcut, and not a reserved one.
    assert.deepEqual(recordKeyPress(press('KeyF', { ...CMD, ...SHIFT }), true), shortcut('Command+Shift+F'));
    assert.deepEqual(recordKeyPress(press('Space', { ...CMD, ...SHIFT }), true), shortcut('Command+Shift+Space'));
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CMD, ...ALT }), true), shortcut('Command+Alt+K'));
    assert.deepEqual(recordKeyPress(press('KeyF', { ...CTRL, ...SHIFT }), false), shortcut('Control+Shift+F'));
    assert.deepEqual(recordKeyPress(press('Space', { ...CTRL, ...SHIFT }), false), shortcut('Control+Shift+Space'));
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CTRL, ...ALT }), false), shortcut('Control+Alt+K'));
  });
});

describe('a modifier on its own', () => {
  it('waits for the key, whichever modifier it is, on either keyboard', () => {
    const modifiers = [
      'ShiftLeft',
      'ShiftRight',
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'AltGraph',
      'MetaLeft',
      'MetaRight',
      'OSLeft',
      'OSRight',
      'Fn',
    ];
    for (const mac of [true, false]) {
      for (const code of modifiers) {
        assert.deepEqual(recordKeyPress(press(code, { ...CMD, ...SHIFT }), mac), { kind: 'waiting' }, code);
      }
    }
  });
});

describe('Escape', () => {
  it('on its own cancels, and changes nothing', () => {
    for (const mac of [true, false]) {
      assert.deepEqual(recordKeyPress(press('Escape'), mac), { kind: 'cancel' });
      // Whatever the layout says: it is not a key that varies with one.
      assert.deepEqual(recordKeyPress(press('Escape'), mac, AZERTY), { kind: 'cancel' });
    }
  });

  it('is not a cancel with a modifier held: that is a key press like another, and is too loose with Shift alone', () => {
    for (const mac of [true, false]) {
      assert.equal(recordKeyPress(press('Escape', SHIFT), mac).kind, 'too-loose');
      assert.equal(recordKeyPress(press('Escape', ALT), mac).kind, 'too-loose');
    }
  });
});

describe('a key that would take typing from every app', () => {
  it('is said to be too loose with no modifier, or with Shift or Alt alone, and says what to hold', () => {
    for (const mac of [true, false]) {
      for (const held of [{}, SHIFT, ALT, { ...SHIFT, ...ALT }]) {
        for (const code of ['KeyK', 'Digit5', 'Space', 'ArrowUp', 'Enter', 'Tab']) {
          const heard = recordKeyPress(press(code, held), mac);
          // Alt+Tab is more than too loose: it is what switches windows, and is said to be.
          const expected = code === 'Tab' && held === ALT ? 'reserved' : 'too-loose';
          assert.equal(heard.kind, expected, `${code} ${JSON.stringify(held)} mac=${mac}`);
        }
      }
    }
    const mac = recordKeyPress(press('KeyK'), true);
    const other = recordKeyPress(press('KeyK'), false);
    assert.ok(mac.kind === 'too-loose' && /Hold ⌘ or ⌃ as well/.test(mac.hint), JSON.stringify(mac));
    assert.ok(other.kind === 'too-loose' && /Hold Ctrl as well/.test(other.hint), JSON.stringify(other));
    assert.ok(other.kind === 'too-loose' && /F1–F24 can go with Shift or Alt alone/.test(other.hint));
  });

  it('is fine with the Windows key off a Mac, which is a command key to the server', () => {
    assert.deepEqual(recordKeyPress(press('KeyK', CMD), false), shortcut('Super+K'));
  });
});

describe('a key that is no part of a shortcut', () => {
  it('is unusable, with a hint, and so is every punctuation, keypad, lock and media key', () => {
    const codes = [
      'Minus',
      'Comma',
      'Period',
      'Slash',
      'Backslash',
      'Semicolon',
      'Quote',
      'Backquote',
      'BracketLeft',
      'BracketRight',
      'NumpadAdd',
      'Numpad5',
      'NumpadEnter',
      'CapsLock',
      'NumLock',
      'ScrollLock',
      'PrintScreen',
      'Pause',
      'ContextMenu',
      'AudioVolumeUp',
      'MediaPlayPause',
      'IntlBackslash',
      'Unidentified',
      '',
    ];
    for (const mac of [true, false]) {
      for (const code of codes) {
        const heard = recordKeyPress(press(code, { ...CMD, ...CTRL, ...SHIFT }), mac);
        assert.equal(heard.kind, 'unusable', `${JSON.stringify(code)} mac=${mac}`);
        assert.ok(heard.kind === 'unusable' && /cannot be part of a shortcut/.test(heard.hint));
      }
    }
  });
});

describe('the key that types =', () => {
  it('is unusable, whatever is held with it, since Electron would register Shift and = for it', () => {
    for (const mac of [true, false]) {
      for (const held of [{}, CMD, CTRL, { ...CMD, ...SHIFT }, { ...CTRL, ...ALT }, SHIFT]) {
        const heard = recordKeyPress(press('Equal', held), mac);
        assert.equal(heard.kind, 'unusable', `${JSON.stringify(held)} mac=${mac}`);
        assert.ok(heard.kind === 'unusable' && /= key cannot be part of a shortcut/.test(heard.hint));
        assert.ok(heard.kind === 'unusable' && /Shift and =/.test(heard.hint));
      }
    }
  });

  it('is unusable with a layout too, and a layout that says the key types something else changes nothing', () => {
    const layout: KeyLayout = new Map([['Equal', '=']]);
    assert.equal(recordKeyPress(press('Equal', CTRL), false, layout).kind, 'unusable');
    assert.equal(recordKeyPress(press('Equal', CMD), true, layout).kind, 'unusable');
  });

  it('is not the numeric keypad plus, which is unusable for its own reason', () => {
    const heard = recordKeyPress(press('NumpadAdd', CTRL), false);
    assert.ok(heard.kind === 'unusable' && /^That key cannot be part of a shortcut/.test(heard.hint));
  });
});

describe('a shortcut that every app or the system already has', () => {
  const EVERYDAY = [...'ACFHMNOPQRSTVWXZ'].concat('Tab');

  const keyCode = (key: string) => (key === 'Tab' ? 'Tab' : `Key${key}`);

  it('is refused with the command key alone and one of A C F H M N O P Q R S T V W X Z or Tab, on a Mac', () => {
    for (const key of EVERYDAY) {
      for (const held of [CMD, CTRL]) {
        const heard = recordKeyPress(press(keyCode(key), held), true);
        assert.equal(heard.kind, 'reserved', `${key} ${JSON.stringify(held)}`);
      }
    }
  });

  it('is refused with Control alone and the same keys, off a Mac, where the Windows key is not one', () => {
    for (const key of EVERYDAY) {
      assert.equal(recordKeyPress(press(keyCode(key), CTRL), false).kind, 'reserved', key);
      assert.equal(recordKeyPress(press(keyCode(key), CMD), false).kind, 'shortcut', `Win+${key}`);
    }
  });

  it('says so in the keys of the keyboard it is on, and what to pick instead', () => {
    const mac = recordKeyPress(press('KeyC', CMD), true);
    assert.deepEqual(mac, {
      kind: 'reserved',
      hint: '⌘C is a shortcut every app uses; pick one with ⌘⇧ or ⌘⌥ instead.',
    });
    const control = recordKeyPress(press('KeyC', CTRL), true);
    assert.deepEqual(control, {
      kind: 'reserved',
      hint: '⌃C is a shortcut every app uses; pick one with ⌃⇧ or ⌃⌥ instead.',
    });
    const other = recordKeyPress(press('KeyC', CTRL), false);
    assert.deepEqual(other, {
      kind: 'reserved',
      hint: 'Ctrl+C is a shortcut every app uses; pick one with Ctrl+Shift or Ctrl+Alt instead.',
    });
    assert.deepEqual(recordKeyPress(press('Tab', CTRL), false), {
      kind: 'reserved',
      hint: 'Ctrl+Tab is a shortcut every app uses; pick one with Ctrl+Shift or Ctrl+Alt instead.',
    });
  });

  it('is refused as redo with Shift and the command key and Z', () => {
    assert.deepEqual(recordKeyPress(press('KeyZ', { ...CMD, ...SHIFT }), true), {
      kind: 'reserved',
      hint: '⌘⇧Z is redo in nearly every app; pick another key.',
    });
    assert.deepEqual(recordKeyPress(press('KeyZ', { ...CTRL, ...SHIFT }), true), {
      kind: 'reserved',
      hint: '⌃⇧Z is redo in nearly every app; pick another key.',
    });
    assert.deepEqual(recordKeyPress(press('KeyZ', { ...CTRL, ...SHIFT }), false), {
      kind: 'reserved',
      hint: 'Ctrl+Shift+Z is redo in nearly every app; pick another key.',
    });
  });

  it('is refused as Alt+F4 and Alt+Tab, which close and switch windows, on every keyboard', () => {
    for (const mac of [true, false]) {
      assert.deepEqual(recordKeyPress(press('F4', ALT), mac), {
        kind: 'reserved',
        hint: 'Alt+F4 closes a window on Windows; pick another shortcut.',
      });
      assert.deepEqual(recordKeyPress(press('Tab', ALT), mac), {
        kind: 'reserved',
        hint: 'Alt+Tab switches between windows on Windows; pick another shortcut.',
      });
    }
  });

  it('is refused as Command+Space, which is Spotlight', () => {
    assert.deepEqual(recordKeyPress(press('Space', CMD), true), {
      kind: 'reserved',
      hint: '⌘Space opens Spotlight on a Mac; pick one with ⌘⇧ or ⌘⌥ instead.',
    });
  });

  it('is only the exact combination: another modifier or another key is another shortcut', () => {
    // The same keys with Shift or Alt as well.
    for (const key of EVERYDAY) {
      for (const extra of [SHIFT, ALT]) {
        const mac = recordKeyPress(press(keyCode(key), { ...CMD, ...extra }), true);
        const other = recordKeyPress(press(keyCode(key), { ...CTRL, ...extra }), false);
        // Shift+Command+Z is redo, which is the other rule.
        if (key === 'Z' && extra === SHIFT) {
          assert.equal(mac.kind, 'reserved');
          assert.equal(other.kind, 'reserved');
        } else {
          assert.equal(mac.kind, 'shortcut', `⌘${key} with ${JSON.stringify(extra)}`);
          assert.equal(other.kind, 'shortcut', `Ctrl+${key} with ${JSON.stringify(extra)}`);
        }
      }
    }
    // Both command keys on a Mac.
    assert.equal(recordKeyPress(press('KeyC', { ...CMD, ...CTRL }), true).kind, 'shortcut');
    // Another key.
    for (const code of ['KeyB', 'KeyK', 'KeyJ', 'KeyY', 'KeyU', 'KeyI', 'KeyE', 'Digit1', 'Enter', 'F5']) {
      assert.equal(recordKeyPress(press(code, CMD), true).kind, 'shortcut', code);
      assert.equal(recordKeyPress(press(code, CTRL), false).kind, 'shortcut', code);
    }
    // Alt with another function key, Shift with F4, and three modifiers with Z.
    assert.equal(recordKeyPress(press('F5', ALT), false).kind, 'shortcut');
    assert.equal(recordKeyPress(press('F4', SHIFT), false).kind, 'shortcut');
    assert.equal(recordKeyPress(press('F4', { ...ALT, ...SHIFT }), false).kind, 'shortcut');
    assert.equal(recordKeyPress(press('KeyZ', { ...CMD, ...ALT, ...SHIFT }), true).kind, 'shortcut');
    assert.equal(recordKeyPress(press('KeyZ', { ...CMD, ...ALT }), true).kind, 'shortcut');
    // Space with Control or with Command and Shift.
    assert.equal(recordKeyPress(press('Space', CTRL), true).kind, 'shortcut');
    assert.equal(recordKeyPress(press('Space', CTRL), false).kind, 'shortcut');
    assert.equal(recordKeyPress(press('Space', { ...CMD, ...SHIFT }), true).kind, 'shortcut');
  });

  it('is judged by the key that the layout says it is, which is what Windows registers', () => {
    // On a French keyboard the key in Q's place types a: with Control, that is Select all.
    const heard = recordKeyPress(press('KeyQ', CTRL), false, AZERTY);
    assert.deepEqual(heard, {
      kind: 'reserved',
      hint: 'Ctrl+A is a shortcut every app uses; pick one with Ctrl+Shift or Ctrl+Alt instead.',
    });
    // And the key in A's place types q: Quit.
    assert.equal(recordKeyPress(press('KeyA', CTRL), false, AZERTY).kind, 'reserved');
    // The key in Z's place types w (Close), where by position it would be Z (Undo): both are refused.
    assert.equal(recordKeyPress(press('KeyZ', CTRL), false, AZERTY).kind, 'reserved');
    // A key the layout does not change is judged as it is: Ctrl+J is nothing every app has.
    assert.equal(recordKeyPress(press('KeyJ', CTRL), false, AZERTY).kind, 'shortcut');
  });
});

describe('the letters and digits on a keyboard layout', () => {
  it('are what the keys type, off a Mac: on a French keyboard the key in Q\'s place is A', () => {
    assert.deepEqual(recordKeyPress(press('KeyQ', { ...CTRL, ...SHIFT }), false, AZERTY), shortcut('Control+Shift+A'));
    assert.deepEqual(recordKeyPress(press('KeyA', { ...CTRL, ...SHIFT }), false, AZERTY), shortcut('Control+Shift+Q'));
    assert.deepEqual(recordKeyPress(press('KeyW', { ...CTRL, ...ALT }), false, AZERTY), shortcut('Control+Alt+Z'));
    assert.deepEqual(recordKeyPress(press('KeyZ', { ...CTRL, ...ALT }), false, AZERTY), shortcut('Control+Alt+W'));
    // A key that types the same on both is the same.
    assert.deepEqual(recordKeyPress(press('KeyK', { ...CTRL, ...ALT }), false, AZERTY), shortcut('Control+Alt+K'));
  });

  it('are the keys by position without a layout: it is not known, so the code is what there is', () => {
    for (const layout of [undefined, null]) {
      assert.deepEqual(recordKeyPress(press('KeyQ', { ...CTRL, ...SHIFT }), false, layout), shortcut('Control+Shift+Q'));
      assert.deepEqual(recordKeyPress(press('KeyQ', { ...CTRL, ...SHIFT }), false), shortcut('Control+Shift+Q'));
    }
  });

  it('are the keys by position on a Mac, which registers by position, whatever layout it is given', () => {
    assert.deepEqual(recordKeyPress(press('KeyQ', { ...CMD, ...SHIFT }), true, AZERTY), shortcut('Command+Shift+Q'));
    assert.deepEqual(recordKeyPress(press('KeyA', { ...CMD, ...SHIFT }), true, AZERTY), shortcut('Command+Shift+A'));
    // Even a key that types an accent there: by position it is a digit.
    assert.deepEqual(recordKeyPress(press('Digit2', { ...CMD, ...SHIFT }), true, AZERTY), shortcut('Command+Shift+2'));
  });

  it('are read from the layout in capitals, and by what the key types, which may be a capital already', () => {
    const layout: KeyLayout = new Map([
      ['KeyQ', 'a'],
      ['KeyW', 'Z'],
      ['Digit3', '3'],
    ]);
    assert.deepEqual(recordKeyPress(press('KeyQ', { ...CTRL, ...ALT }), false, layout), shortcut('Control+Alt+A'));
    assert.deepEqual(recordKeyPress(press('KeyW', { ...CTRL, ...ALT }), false, layout), shortcut('Control+Alt+Z'));
    assert.deepEqual(recordKeyPress(press('Digit3', { ...CTRL, ...ALT }), false, layout), shortcut('Control+Alt+3'));
  });

  it('are no key at all when they type anything but A to Z or 0 to 9 there: é, ç, &, and a comma', () => {
    for (const code of ['Digit1', 'Digit2', 'Digit7', 'Digit9', 'Digit0', 'KeyM']) {
      const heard = recordKeyPress(press(code, { ...CTRL, ...SHIFT }), false, AZERTY);
      assert.equal(heard.kind, 'unusable', code);
    }
    const accent = recordKeyPress(press('Digit2', { ...CTRL, ...SHIFT }), false, AZERTY);
    assert.deepEqual(accent, {
      kind: 'unusable',
      hint: 'That key types “é” on your keyboard layout, and a shortcut can only use a plain letter or a number. Try a letter, a number, an F key, Space or an arrow.',
    });
    const cedilla = recordKeyPress(press('Digit9', CTRL), false, AZERTY);
    assert.ok(cedilla.kind === 'unusable' && cedilla.hint.includes('“ç”'));
  });

  it('are no key at all when the layout types a letter that is not plain ASCII: ı, ß, ñ, or nothing', () => {
    const layout: KeyLayout = new Map([
      ['KeyI', 'ı'],
      ['KeyS', 'ß'],
      ['KeyN', 'ñ'],
      ['KeyB', ''],
      ['KeyD', ' '],
    ]);
    for (const code of ['KeyI', 'KeyS', 'KeyN', 'KeyB', 'KeyD']) {
      assert.equal(recordKeyPress(press(code, { ...CTRL, ...ALT }), false, layout).kind, 'unusable', code);
    }
    const none = recordKeyPress(press('KeyB', CTRL), false, layout);
    assert.ok(none.kind === 'unusable' && /types nothing on your keyboard layout/.test(none.hint));
  });

  it('are the keys by position for a key the layout does not mention', () => {
    const layout: KeyLayout = new Map([['KeyQ', 'a']]);
    assert.deepEqual(recordKeyPress(press('KeyJ', { ...CTRL, ...ALT }), false, layout), shortcut('Control+Alt+J'));
    assert.deepEqual(recordKeyPress(press('Digit4', { ...CTRL, ...ALT }), false, layout), shortcut('Control+Alt+4'));
  });

  it('leave every other key as it is: a layout says nothing about F keys, Space, the arrows or Escape', () => {
    // A layout that answers for every key, with what none of them types as a letter.
    const everything: KeyLayout = { get: () => 'é' };
    assert.deepEqual(recordKeyPress(press('F5', CTRL), false, everything), shortcut('Control+F5'));
    assert.deepEqual(recordKeyPress(press('Space', { ...CTRL, ...SHIFT }), false, everything), shortcut('Control+Shift+Space'));
    assert.deepEqual(recordKeyPress(press('ArrowUp', { ...CTRL, ...SHIFT }), false, everything), shortcut('Control+Shift+Up'));
    assert.deepEqual(recordKeyPress(press('Escape'), false, everything), { kind: 'cancel' });
    assert.equal(recordKeyPress(press('Minus', CTRL), false, everything).kind, 'unusable');
    assert.equal(recordKeyPress(press('ShiftLeft', SHIFT), false, everything).kind, 'waiting');
  });

  it('are asked of the layout by KeyboardEvent.code, and of nothing else', () => {
    const asked: string[] = [];
    const layout: KeyLayout = {
      get: (code) => {
        asked.push(code);
        return undefined;
      },
    };
    recordKeyPress(press('KeyQ', CTRL), false, layout);
    recordKeyPress(press('Digit2', CTRL), false, layout);
    recordKeyPress(press('F5', CTRL), false, layout);
    recordKeyPress(press('Space', CTRL), false, layout);
    recordKeyPress(press('KeyQ', CMD), true, layout);
    assert.deepEqual(asked, ['KeyQ', 'Digit2']);
  });
});

describe('when two shortcuts are one', () => {
  it('is when they press the same keys on this system, however each is spelled', () => {
    // The Command key recorded on a Mac is the CommandOrControl that ships.
    assert.equal(sameShortcut('Command+Alt+K', 'CommandOrControl+Alt+K', true), true);
    assert.equal(sameShortcut('Control+Alt+K', 'CommandOrControl+Alt+K', false), true);
    // Not the other way round: CommandOrControl is not the Control key on a Mac, nor the Command key elsewhere.
    assert.equal(sameShortcut('Control+Alt+K', 'CommandOrControl+Alt+K', true), false);
    assert.equal(sameShortcut('Command+Alt+K', 'CommandOrControl+Alt+K', false), false);
  });

  it('is the same in any order of the modifiers, and Option is Alt', () => {
    for (const mac of [true, false]) {
      assert.equal(sameShortcut('Shift+CommandOrControl+F', 'CommandOrControl+Shift+F', mac), true);
      assert.equal(sameShortcut('Alt+Shift+Control+K', 'Control+Shift+Alt+K', mac), true);
      assert.equal(sameShortcut('Option+Control+K', 'Control+Alt+K', mac), true);
    }
  });

  it('is the Windows key off a Mac whether it is called Super or Command, and the Command key on a Mac for both', () => {
    assert.equal(sameShortcut('Super+Alt+J', 'Command+Alt+J', false), true);
    assert.equal(sameShortcut('Super+Alt+J', 'Command+Alt+J', true), true);
    assert.equal(sameShortcut('Super+Alt+J', 'Control+Alt+J', false), false);
  });

  it('is not when the key, or one of the modifiers, is different', () => {
    for (const mac of [true, false]) {
      assert.equal(sameShortcut('CommandOrControl+Shift+F', 'CommandOrControl+Shift+K', mac), false);
      assert.equal(sameShortcut('CommandOrControl+Shift+F', 'CommandOrControl+Alt+F', mac), false);
      assert.equal(sameShortcut('CommandOrControl+Shift+F', 'CommandOrControl+F', mac), false);
      assert.equal(sameShortcut('CommandOrControl+Shift+F', 'Shift+F5', mac), false);
    }
  });

  it('reads the keyboard of the page when it is not told, and answers for a shortcut with itself', () => {
    // The default is the browser's own answer (isMac), which is not a Mac here: only that it can be asked.
    assert.equal(sameShortcut('Control+Alt+K', 'Control+Alt+K'), true);
    assert.equal(sameShortcut('Control+Alt+K', 'Control+Alt+J'), false);
  });
});
