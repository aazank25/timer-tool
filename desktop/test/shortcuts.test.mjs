import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nativeAccelerator } from '../menu-bar.mjs';
import {
  createHotkeys,
  describeHotkeys,
  HOTKEY_ACTIONS,
  HOTKEY_FAILURES,
  HOTKEY_TROUBLE_LABEL,
  HOTKEYS,
  hotkeyMenuItems,
  hotkeyPlan,
  hotkeysFailing,
  opensQuickSwitch,
} from '../shortcuts.mjs';

/* ---------------------------------------------------------------------------- the plan */

describe('the shortcuts the settings ask for', () => {
  it('are the three, in the order they are registered, each with the setting it is read from', () => {
    assert.deepEqual(HOTKEY_ACTIONS, ['show', 'pause', 'quickSwitch']);
    assert.deepEqual(
      hotkeyPlan({}).map(({ action, setting }) => [action, setting]),
      [
        ['show', 'show_hotkey'],
        ['pause', 'pause_hotkey'],
        ['quickSwitch', 'quick_switch_hotkey'],
      ],
    );
  });

  it('are the defaults where a setting is not there: an older server, or settings not read yet', () => {
    const defaults = [
      { action: 'show', setting: 'show_hotkey', accelerator: 'CommandOrControl+Shift+F' },
      { action: 'pause', setting: 'pause_hotkey', accelerator: 'CommandOrControl+Shift+Space' },
      { action: 'quickSwitch', setting: 'quick_switch_hotkey', accelerator: 'CommandOrControl+Alt+K' },
    ];
    assert.deepEqual(hotkeyPlan(null), defaults);
    assert.deepEqual(hotkeyPlan(undefined), defaults);
    assert.deepEqual(hotkeyPlan({}), defaults);
    // Whatever else the settings have is not about shortcuts.
    assert.deepEqual(hotkeyPlan({ focus_minutes: '45', notifications: 'false' }), defaults);
    assert.equal(HOTKEYS.show.fallback, 'CommandOrControl+Shift+F');
    assert.equal(HOTKEYS.pause.fallback, 'CommandOrControl+Shift+Space');
    assert.equal(HOTKEYS.quickSwitch.fallback, 'CommandOrControl+Alt+K');
  });

  it('are what the settings say, each from its own', () => {
    const plan = hotkeyPlan({
      show_hotkey: 'CommandOrControl+Alt+J',
      pause_hotkey: 'Control+Shift+P',
      quick_switch_hotkey: 'Shift+F5',
    });
    assert.deepEqual(
      plan.map((p) => p.accelerator),
      ['CommandOrControl+Alt+J', 'Control+Shift+P', 'Shift+F5'],
    );
  });

  it('are off where the setting is empty, which is not the same as not being there', () => {
    const plan = hotkeyPlan({ show_hotkey: '', pause_hotkey: 'Control+Shift+P' });
    assert.deepEqual(
      plan.map((p) => p.accelerator),
      [null, 'Control+Shift+P', 'CommandOrControl+Alt+K'],
    );
    assert.deepEqual(
      hotkeyPlan({ show_hotkey: '', pause_hotkey: '', quick_switch_hotkey: '' }).map(
        (p) => p.accelerator,
      ),
      [null, null, null],
    );
  });

  it('are off for nothing but spaces too, as the server reads it, and are not trimmed otherwise', () => {
    assert.equal(hotkeyPlan({ show_hotkey: '   ' })[0].accelerator, null);
    // Not a space: that is not what anyone means by "off", and the rule that reads it will say no.
    assert.equal(hotkeyPlan({ show_hotkey: ' ' })[0].accelerator, ' ');
  });

  it('are the default for a setting that is not text, which the server never stores', () => {
    const plan = hotkeyPlan({ show_hotkey: null, pause_hotkey: 5, quick_switch_hotkey: {} });
    assert.deepEqual(
      plan.map((p) => p.accelerator),
      ['CommandOrControl+Shift+F', 'CommandOrControl+Shift+Space', 'CommandOrControl+Alt+K'],
    );
  });

  it('are not changed by being asked for, and the defaults cannot be changed from outside', () => {
    const settings = { show_hotkey: 'Control+Alt+J' };
    hotkeyPlan(settings);
    assert.deepEqual(settings, { show_hotkey: 'Control+Alt+J' });
    assert.throws(() => {
      HOTKEYS.show.fallback = 'x';
    }, TypeError);
  });
});

/* ------------------------------------------------------------------- registering them */

/**
 * Electron's globalShortcut, as far as it matters: a combination is taken once, whoever takes it
 * (this app, or one of `others`), and is the same combination however it is spelled, as Electron
 * reads it (Shift+CommandOrControl+F is CommandOrControl+Shift+F).
 */
function fakeShortcuts({ others = [], throwsOn = [] } = {}) {
  const keys = (accelerator) =>
    accelerator
      .toLowerCase()
      .split('+')
      .map((name) => name.trim())
      .sort()
      .join('+');
  const registered = new Map(); // keys -> { accelerator as it was handed in, callback }
  const taken = new Set(others.map(keys));
  const calls = [];
  return {
    calls,
    registered,
    /** The accelerators registered now, as they were handed in. */
    held: () => [...registered.values()].map((entry) => entry.accelerator),
    /** Another app lets go of, or takes, a combination. */
    release: (accelerator) => taken.delete(keys(accelerator)),
    take: (accelerator) => taken.add(keys(accelerator)),
    /** Something other than this app removes a registration. */
    lose: (accelerator) => registered.delete(keys(accelerator)),
    /** Press the keys: what Electron does with a registered combination. */
    press: (accelerator) => registered.get(keys(accelerator))?.callback(),
    register(accelerator, callback) {
      calls.push(['register', accelerator]);
      if (throwsOn.includes(accelerator)) throw new Error(`Invalid accelerator: ${accelerator}`);
      if (taken.has(keys(accelerator)) || registered.has(keys(accelerator))) return false;
      registered.set(keys(accelerator), { accelerator, callback });
      return true;
    },
    unregister(accelerator) {
      calls.push(['unregister', accelerator]);
      registered.delete(keys(accelerator));
    },
    isRegistered(accelerator) {
      calls.push(['isRegistered', accelerator]);
      return registered.has(keys(accelerator));
    },
  };
}

/** What was registered and let go of, and not what was only asked after. */
const changes = (shortcuts) =>
  shortcuts.calls.filter(([call]) => call === 'register' || call === 'unregister');

/** A hotkey manager over a fake globalShortcut, whose handlers say which of them ran. */
function setup({ shortcuts = fakeShortcuts(), normalize, toSystem, log } = {}) {
  const ran = [];
  const logs = [];
  const hotkeys = createHotkeys({
    globalShortcut: shortcuts,
    ...(toSystem ? { toSystem } : {}),
    ...(normalize ? { normalize } : {}),
    handlers: {
      show: () => ran.push('show'),
      pause: () => ran.push('pause'),
      quickSwitch: () => ran.push('quickSwitch'),
    },
    log: log ?? ((...args) => logs.push(args)),
  });
  return { hotkeys, shortcuts, ran, logs };
}

const DEFAULTS = {
  show: 'CommandOrControl+Shift+F',
  pause: 'CommandOrControl+Shift+Space',
  quickSwitch: 'CommandOrControl+Alt+K',
};

/** The answer for a shortcut that is registered. */
const ok = (accelerator) => ({ ok: true, accelerator });

describe('registering the shortcuts', () => {
  it('takes all three, from the defaults, when the settings have not been read yet', () => {
    const { hotkeys, shortcuts } = setup();

    const answer = hotkeys.apply(null);

    assert.deepEqual(answer, {
      show: ok(DEFAULTS.show),
      pause: ok(DEFAULTS.pause),
      quickSwitch: ok(DEFAULTS.quickSwitch),
    });
    assert.deepEqual(hotkeys.active(), DEFAULTS);
    assert.deepEqual(shortcuts.held().sort(), Object.values(DEFAULTS).sort());
  });

  it('takes each from its own setting, and none of the defaults those settings replace', () => {
    const { hotkeys, shortcuts } = setup();

    const answer = hotkeys.apply({
      show_hotkey: 'CommandOrControl+Alt+J',
      pause_hotkey: 'Control+Shift+P',
      quick_switch_hotkey: 'Shift+F5',
    });

    assert.deepEqual(answer, {
      show: ok('CommandOrControl+Alt+J'),
      pause: ok('Control+Shift+P'),
      quickSwitch: ok('Shift+F5'),
    });
    assert.deepEqual(shortcuts.held().sort(), [
      'CommandOrControl+Alt+J',
      'Control+Shift+P',
      'Shift+F5',
    ]);
  });

  it('takes the default of a setting that is missing, and none for one that is empty', () => {
    const { hotkeys, shortcuts } = setup();

    const answer = hotkeys.apply({ show_hotkey: '', quick_switch_hotkey: 'Shift+F5' });

    assert.deepEqual(answer, {
      show: ok(null),
      pause: ok(DEFAULTS.pause),
      quickSwitch: ok('Shift+F5'),
    });
    assert.deepEqual(hotkeys.active(), { show: null, pause: DEFAULTS.pause, quickSwitch: 'Shift+F5' });
    assert.equal(shortcuts.isRegistered(DEFAULTS.show), false);
  });

  it('runs what each shortcut is for when its keys are pressed, and nothing else', () => {
    const { hotkeys, shortcuts, ran } = setup();
    hotkeys.apply({ show_hotkey: 'Control+Alt+J' });

    shortcuts.press('Control+Alt+J');
    shortcuts.press(DEFAULTS.pause);
    shortcuts.press(DEFAULTS.quickSwitch);

    assert.deepEqual(ran, ['show', 'pause', 'quickSwitch']);
  });

  it('is told, on a change, only about the shortcut that changed: the others are not touched', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});
    shortcuts.calls.length = 0;

    const answer = hotkeys.apply({ show_hotkey: 'CommandOrControl+Alt+J' });

    assert.deepEqual(answer.show, ok('CommandOrControl+Alt+J'));
    assert.deepEqual(changes(shortcuts), [
      ['unregister', DEFAULTS.show],
      ['register', 'CommandOrControl+Alt+J'],
    ]);
    assert.equal(shortcuts.isRegistered(DEFAULTS.show), false, 'the old one is let go of');
    assert.deepEqual(hotkeys.active(), { ...DEFAULTS, show: 'CommandOrControl+Alt+J' });
  });

  it('does nothing at all when the settings are what is registered already', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({ pause_hotkey: '' });
    shortcuts.calls.length = 0;

    const answer = hotkeys.apply({ pause_hotkey: '' });

    // It looks at what is held, and takes or lets go of none of it.
    assert.deepEqual(changes(shortcuts), []);
    assert.deepEqual(answer.pause, ok(null));
    assert.deepEqual(answer.show, ok(DEFAULTS.show));
  });

  it('takes one again that has gone missing, which is what a reload is for', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});
    shortcuts.lose(DEFAULTS.quickSwitch);

    const answer = hotkeys.apply({});

    assert.deepEqual(answer.quickSwitch, ok(DEFAULTS.quickSwitch));
    assert.equal(shortcuts.isRegistered(DEFAULTS.quickSwitch), true);
  });

  it('lets go of a shortcut that is turned off, for good, and takes it again when it is turned on', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});

    assert.deepEqual(hotkeys.apply({ pause_hotkey: '' }).pause, ok(null));
    assert.equal(shortcuts.isRegistered(DEFAULTS.pause), false);
    assert.equal(hotkeys.active().pause, null);

    assert.deepEqual(hotkeys.apply({ pause_hotkey: 'Control+Alt+P' }).pause, ok('Control+Alt+P'));
    assert.equal(shortcuts.isRegistered('Control+Alt+P'), true);
    assert.equal(shortcuts.isRegistered(DEFAULTS.pause), false);
  });

  it('lets go of the old one first, so the same keys under another spelling can be taken', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: 'Shift+CommandOrControl+F' });

    assert.deepEqual(answer.show, ok('Shift+CommandOrControl+F'));
    assert.deepEqual(shortcuts.held().sort(), [
      DEFAULTS.pause,
      DEFAULTS.quickSwitch,
      'Shift+CommandOrControl+F',
    ].sort());
  });

  it('keeps the one that worked, and says why, when the new one is taken by another app', () => {
    const shortcuts = fakeShortcuts({ others: ['Control+Alt+J'] });
    const { hotkeys } = setup({ shortcuts });
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: 'Control+Alt+J' });

    assert.deepEqual(answer.show, {
      ok: false,
      accelerator: DEFAULTS.show,
      code: 'taken',
      error: 'Control+Alt+J could not be registered. Another app may be using it.',
    });
    assert.equal(shortcuts.isRegistered(DEFAULTS.show), true, 'put back');
    assert.equal(hotkeys.active().show, DEFAULTS.show);
    // Nobody else is worse off for it.
    assert.deepEqual(answer.pause, ok(DEFAULTS.pause));
    assert.deepEqual(answer.quickSwitch, ok(DEFAULTS.quickSwitch));
  });

  it('has none, and says so, when the new one cannot be had and the old one cannot be put back', () => {
    const shortcuts = fakeShortcuts();
    const { hotkeys } = setup({ shortcuts });
    hotkeys.apply({});
    // Once let go of, another app takes the old one before it can be put back.
    const unregister = shortcuts.unregister;
    shortcuts.unregister = (accelerator) => {
      unregister(accelerator);
      if (accelerator === DEFAULTS.show) shortcuts.take(accelerator);
    };
    shortcuts.take('Control+Alt+J');

    const answer = hotkeys.apply({ show_hotkey: 'Control+Alt+J' });

    assert.equal(answer.show.ok, false);
    assert.equal(answer.show.accelerator, null);
    assert.match(answer.show.error, /Control\+Alt\+J could not be registered/);
    assert.equal(hotkeys.active().show, null);
  });

  it('refuses a shortcut that another of its own holds, and says it is one of its own', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});

    // Not something the server would save. The app does not trust that: it is told per shortcut.
    const answer = hotkeys.apply({ quick_switch_hotkey: DEFAULTS.pause });

    assert.deepEqual(answer.quickSwitch, {
      ok: false,
      accelerator: DEFAULTS.quickSwitch,
      code: 'taken',
      error: `${DEFAULTS.pause} is already used by another FocusDesk shortcut.`,
    });
    assert.deepEqual(answer.pause, ok(DEFAULTS.pause));
    assert.equal(shortcuts.isRegistered(DEFAULTS.quickSwitch), true);
  });

  it('refuses the same keys wanted twice at the start, the second of them, and still takes the rest', () => {
    const { hotkeys } = setup();

    const answer = hotkeys.apply({ pause_hotkey: DEFAULTS.show });

    assert.deepEqual(answer.show, ok(DEFAULTS.show));
    assert.equal(answer.pause.ok, false);
    assert.equal(answer.pause.accelerator, null);
    assert.match(answer.pause.error, /already used by another FocusDesk shortcut/);
    assert.deepEqual(answer.quickSwitch, ok(DEFAULTS.quickSwitch));
  });

  it('swaps the keys of two shortcuts in one go, which one at a time would be refused', () => {
    const { hotkeys, shortcuts, ran } = setup();
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: DEFAULTS.pause, pause_hotkey: DEFAULTS.show });

    assert.deepEqual(answer.show, ok(DEFAULTS.pause));
    assert.deepEqual(answer.pause, ok(DEFAULTS.show));
    shortcuts.press(DEFAULTS.pause);
    shortcuts.press(DEFAULTS.show);
    assert.deepEqual(ran, ['show', 'pause']);
  });

  it('lets one take the keys another is giving up, whichever comes first', () => {
    const { hotkeys } = setup();
    hotkeys.apply({});

    // show wants what quick switch has, and quick switch is moving on, and is registered after it.
    const answer = hotkeys.apply({
      show_hotkey: DEFAULTS.quickSwitch,
      quick_switch_hotkey: 'Control+Alt+Q',
    });

    assert.deepEqual(answer.show, ok(DEFAULTS.quickSwitch));
    assert.deepEqual(answer.quickSwitch, ok('Control+Alt+Q'));
  });

  it('does not put back an old shortcut over keys that another has just been given', () => {
    const shortcuts = fakeShortcuts({ others: ['Control+Alt+J'] });
    const { hotkeys } = setup({ shortcuts });
    hotkeys.apply({});

    // show cannot have its new keys, and wants to go back to the old, which pause has been given.
    const answer = hotkeys.apply({
      show_hotkey: 'Control+Alt+J',
      pause_hotkey: DEFAULTS.show,
    });

    assert.equal(answer.show.ok, false);
    assert.equal(answer.show.accelerator, null);
    assert.deepEqual(answer.pause, ok(DEFAULTS.show));
    assert.equal(hotkeys.active().show, null);
    assert.equal(hotkeys.active().pause, DEFAULTS.show);
  });

  it('leaves the one that works where it is when a setting is not a shortcut, and says so', () => {
    const { hotkeys, shortcuts } = setup({
      normalize: (text) => (text.includes('Foo') ? null : text),
    });
    hotkeys.apply({});
    shortcuts.calls.length = 0;

    const answer = hotkeys.apply({ show_hotkey: 'Foo+A' });

    assert.deepEqual(answer.show, {
      ok: false,
      accelerator: DEFAULTS.show,
      code: 'invalid',
      error: '"Foo+A" is not a shortcut FocusDesk can register.',
    });
    assert.equal(shortcuts.isRegistered(DEFAULTS.show), true);
    assert.deepEqual(changes(shortcuts), [], 'nothing is let go of or taken for it');
  });

  it('has none for a setting that is not a shortcut when there was none before, and takes the others', () => {
    const { hotkeys } = setup({ normalize: (text) => (text === 'nope' ? null : text) });

    const answer = hotkeys.apply({ pause_hotkey: 'nope' });

    assert.deepEqual(answer.pause, {
      ok: false,
      accelerator: null,
      code: 'invalid',
      error: '"nope" is not a shortcut FocusDesk can register.',
    });
    assert.deepEqual(answer.show, ok(DEFAULTS.show));
    assert.deepEqual(answer.quickSwitch, ok(DEFAULTS.quickSwitch));
  });

  it('reads each setting through the rule the server saved it by, and registers what that says', () => {
    const { hotkeys, shortcuts } = setup({ normalize: (text) => text.replace(/^cmd\+/i, 'Command+') });

    const answer = hotkeys.apply({ quick_switch_hotkey: 'cmd+Shift+K' });

    assert.deepEqual(answer.quickSwitch, ok('Command+Shift+K'));
    assert.equal(shortcuts.isRegistered('Command+Shift+K'), true);
    assert.equal(hotkeys.active().quickSwitch, 'Command+Shift+K');
  });

  it('is not stopped by a rule that throws: that shortcut is refused, the others are taken', () => {
    const { hotkeys, logs } = setup({
      normalize: (text) => {
        if (text === DEFAULTS.pause) throw new Error('boom');
        return text;
      },
    });

    const answer = hotkeys.apply({});

    assert.equal(answer.pause.ok, false);
    assert.match(answer.pause.error, /not a shortcut FocusDesk can register/);
    assert.deepEqual(answer.show, ok(DEFAULTS.show));
    assert.deepEqual(answer.quickSwitch, ok(DEFAULTS.quickSwitch));
    assert.equal(logs.length, 1);
  });

  it('says what went wrong when Electron throws for one, and takes the others, and puts the old one back', () => {
    const shortcuts = fakeShortcuts({ throwsOn: ['Foo+A'] });
    const { hotkeys } = setup({ shortcuts });
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: 'Foo+A', pause_hotkey: 'Control+Alt+P' });

    assert.deepEqual(answer.show, {
      ok: false,
      accelerator: DEFAULTS.show,
      code: 'invalid',
      error: 'Foo+A could not be registered: Invalid accelerator: Foo+A',
    });
    assert.deepEqual(answer.pause, ok('Control+Alt+P'));
  });

  it('gives its answers in one order, whichever order they were reached in', () => {
    const { hotkeys } = setup();
    assert.deepEqual(Object.keys(hotkeys.apply({ show_hotkey: 'nonsense' })), HOTKEY_ACTIONS);
    assert.deepEqual(Object.keys(hotkeys.active()), HOTKEY_ACTIONS);
  });

  it('hands out what is active as a copy, which changes nothing', () => {
    const { hotkeys } = setup();
    hotkeys.apply({});

    const copy = hotkeys.active();
    copy.show = 'Control+Alt+Z';

    assert.equal(hotkeys.active().show, DEFAULTS.show);
  });

  it('hands every shortcut to the system as it is spelled there, and says it as it was saved', () => {
    // Off a Mac there is no Command key: it is handed over as Super (see nativeAccelerator).
    const { hotkeys, shortcuts } = setup({
      toSystem: (accelerator) => nativeAccelerator(accelerator, 'linux'),
    });

    const answer = hotkeys.apply({ show_hotkey: 'Command+Alt+J', pause_hotkey: 'Cmd+Shift+Space' });

    assert.deepEqual(answer.show, ok('Command+Alt+J'));
    assert.deepEqual(answer.pause, ok('Cmd+Shift+Space'));
    assert.deepEqual(hotkeys.active(), {
      show: 'Command+Alt+J',
      pause: 'Cmd+Shift+Space',
      quickSwitch: DEFAULTS.quickSwitch,
    });
    assert.deepEqual(shortcuts.held().sort(), [
      'CommandOrControl+Alt+K',
      'Super+Alt+J',
      'Super+Shift+Space',
    ]);

    // And lets go of it the same way.
    shortcuts.calls.length = 0;
    hotkeys.apply({ show_hotkey: '', pause_hotkey: 'Cmd+Shift+Space' });
    assert.deepEqual(changes(shortcuts), [['unregister', 'Super+Alt+J']]);
    assert.equal(shortcuts.isRegistered('Super+Alt+J'), false);
  });
});

describe('what is said about the shortcuts in the log', () => {
  it('is one line: each shortcut, and what it is or why it is not', () => {
    const line = describeHotkeys({
      show: ok(DEFAULTS.show),
      pause: ok(null),
      quickSwitch: { ok: false, accelerator: null, error: 'Control+Alt+J could not be registered.' },
    });
    assert.equal(
      line,
      `show: ${DEFAULTS.show} · pause: off · quick switch: Control+Alt+J could not be registered.`,
    );
  });
});

/* ------------------------------------------------------------- the kind of failure */

describe('the kind of failure a status that is not ok carries', () => {
  it('is "taken" when another app has the keys', () => {
    const shortcuts = fakeShortcuts({ others: ['Control+Alt+J'] });
    const { hotkeys } = setup({ shortcuts });
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: 'Control+Alt+J' });

    assert.equal(answer.show.ok, false);
    assert.equal(answer.show.code, 'taken');
  });

  it('is "taken" when another of the app\'s own shortcuts has the keys', () => {
    const { hotkeys } = setup();
    hotkeys.apply({});

    const answer = hotkeys.apply({ quick_switch_hotkey: DEFAULTS.pause });

    assert.equal(answer.quickSwitch.code, 'taken');
    assert.match(answer.quickSwitch.error, /another FocusDesk shortcut/);
  });

  it('is "taken" for a shortcut with none registered before, as at the start, and says there is none', () => {
    const { hotkeys } = setup({ shortcuts: fakeShortcuts({ others: [DEFAULTS.quickSwitch] }) });

    const answer = hotkeys.apply(null);

    assert.deepEqual(answer.quickSwitch, {
      ok: false,
      accelerator: null,
      code: 'taken',
      error: `${DEFAULTS.quickSwitch} could not be registered. Another app may be using it.`,
    });
    assert.deepEqual(answer.show, ok(DEFAULTS.show));
  });

  it('is "invalid" when the setting is not a shortcut the app can register, and when Electron throws for it', () => {
    const shortcuts = fakeShortcuts({ throwsOn: ['Foo+A'] });
    const { hotkeys } = setup({
      shortcuts,
      normalize: (text) => (text === 'not a shortcut' ? null : text),
    });
    hotkeys.apply({});

    const answer = hotkeys.apply({ show_hotkey: 'not a shortcut', pause_hotkey: 'Foo+A' });

    assert.equal(answer.show.code, 'invalid');
    assert.equal(answer.pause.code, 'invalid');
    assert.equal(answer.quickSwitch.code, undefined);
  });

  it('is not there at all for a shortcut that is registered, or off', () => {
    const { hotkeys } = setup();

    const answer = hotkeys.apply({ pause_hotkey: '' });

    assert.equal('code' in answer.show, false);
    assert.equal('code' in answer.pause, false);
    assert.equal('code' in answer.quickSwitch, false);
  });

  it('is one of the kinds there are: the three, of which the app says "unreadable" itself', () => {
    assert.deepEqual([...HOTKEY_FAILURES], ['taken', 'invalid', 'unreadable']);
    assert.throws(() => {
      HOTKEY_FAILURES.push('another');
    }, TypeError);
    const shortcuts = fakeShortcuts({ others: ['Control+Alt+J'], throwsOn: ['Foo+A'] });
    const { hotkeys } = setup({ shortcuts, normalize: (text) => (text === 'x' ? null : text) });
    hotkeys.apply({});
    const answer = hotkeys.apply({
      show_hotkey: 'Control+Alt+J',
      pause_hotkey: 'Foo+A',
      quick_switch_hotkey: 'x',
    });
    for (const action of HOTKEY_ACTIONS) {
      // Registering fails as taken or invalid; unreadable is a failure to read, which is not here.
      assert.ok(['taken', 'invalid'].includes(answer[action].code), action);
      assert.ok(HOTKEY_FAILURES.includes(answer[action].code), action);
    }
  });
});

/* ------------------------------------------------------------ letting go while recording */

describe('the shortcuts being let go of while a key is recorded', () => {
  it('are all let go of, so that pressing any of them does nothing', () => {
    const { hotkeys, shortcuts, ran } = setup();
    hotkeys.apply({});

    hotkeys.suspend();

    assert.equal(hotkeys.suspended(), true);
    assert.deepEqual(shortcuts.held(), []);
    for (const accelerator of Object.values(DEFAULTS)) {
      assert.equal(shortcuts.isRegistered(accelerator), false, accelerator);
      shortcuts.press(accelerator);
    }
    assert.deepEqual(ran, []);
  });

  it('are not forgotten: what each was is still what it says, and is taken again by resume', () => {
    const { hotkeys, shortcuts, ran } = setup();
    hotkeys.apply({ show_hotkey: 'Control+Alt+J', quick_switch_hotkey: '' });
    hotkeys.suspend();

    assert.deepEqual(hotkeys.active(), {
      show: 'Control+Alt+J',
      pause: DEFAULTS.pause,
      quickSwitch: null,
    });

    hotkeys.resume();

    assert.equal(hotkeys.suspended(), false);
    assert.deepEqual(shortcuts.held().sort(), ['Control+Alt+J', DEFAULTS.pause].sort());
    shortcuts.press('Control+Alt+J');
    shortcuts.press(DEFAULTS.pause);
    assert.deepEqual(ran, ['show', 'pause']);
    assert.deepEqual(hotkeys.active(), {
      show: 'Control+Alt+J',
      pause: DEFAULTS.pause,
      quickSwitch: null,
    });
  });

  it('are let go of with the system, and taken again, in the spelling it was handed them in', () => {
    // Off a Mac there is no Command key: it is handed over as Super (see nativeAccelerator).
    const { hotkeys, shortcuts } = setup({
      toSystem: (accelerator) => nativeAccelerator(accelerator, 'linux'),
    });
    hotkeys.apply({ show_hotkey: 'Command+Alt+J' });
    shortcuts.calls.length = 0;

    hotkeys.suspend();
    assert.deepEqual(changes(shortcuts).sort(), [
      ['unregister', 'CommandOrControl+Alt+K'],
      ['unregister', 'CommandOrControl+Shift+Space'],
      ['unregister', 'Super+Alt+J'],
    ]);

    shortcuts.calls.length = 0;
    hotkeys.resume();
    assert.deepEqual(changes(shortcuts).sort(), [
      ['register', 'CommandOrControl+Alt+K'],
      ['register', 'CommandOrControl+Shift+Space'],
      ['register', 'Super+Alt+J'],
    ]);
  });

  it('let go of only what is held: a shortcut that is off is not touched, and nothing held is nothing to do', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({ pause_hotkey: '' });
    shortcuts.calls.length = 0;

    hotkeys.suspend();
    assert.deepEqual(changes(shortcuts), [
      ['unregister', DEFAULTS.show],
      ['unregister', DEFAULTS.quickSwitch],
    ]);

    // Nothing at all registered, as before the first apply.
    const fresh = setup();
    fresh.hotkeys.suspend();
    assert.deepEqual(fresh.shortcuts.calls, []);
    assert.equal(fresh.hotkeys.suspended(), true);
  });

  it('are the same let go of twice as once, and the same taken again twice as once', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});

    hotkeys.suspend();
    hotkeys.suspend();
    assert.deepEqual(shortcuts.held(), []);

    hotkeys.resume();
    shortcuts.calls.length = 0;
    hotkeys.resume();
    // Not suspended any more: there is nothing to take, and nothing is asked of the system.
    assert.deepEqual(shortcuts.calls, []);
    assert.deepEqual(shortcuts.held().sort(), Object.values(DEFAULTS).sort());
    assert.equal(hotkeys.suspended(), false);
  });

  it('are left alone by a resume that was never preceded by a suspend', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});
    shortcuts.calls.length = 0;

    hotkeys.resume();

    assert.deepEqual(shortcuts.calls, []);
    assert.equal(hotkeys.suspended(), false);
  });

  it('are not all taken again when another app has one of them by then: that one is none, and the rest are back', () => {
    const { hotkeys, shortcuts, ran, logs } = setup();
    hotkeys.apply({});
    hotkeys.suspend();
    shortcuts.take(DEFAULTS.pause);

    hotkeys.resume();

    assert.deepEqual(hotkeys.active(), { ...DEFAULTS, pause: null });
    assert.deepEqual(shortcuts.held().sort(), [DEFAULTS.show, DEFAULTS.quickSwitch].sort());
    shortcuts.press(DEFAULTS.show);
    shortcuts.press(DEFAULTS.quickSwitch);
    assert.deepEqual(ran, ['show', 'quickSwitch']);
    assert.equal(logs.length, 1);

    // And the next apply says so, as a status, and takes it again when the other app lets go.
    const answer = hotkeys.apply({});
    assert.deepEqual(answer.pause, {
      ok: false,
      accelerator: null,
      code: 'taken',
      error: `${DEFAULTS.pause} could not be registered. Another app may be using it.`,
    });
    assert.deepEqual(answer.show, ok(DEFAULTS.show));
    shortcuts.release(DEFAULTS.pause);
    assert.deepEqual(hotkeys.apply({}).pause, ok(DEFAULTS.pause));
  });

  it('are ended by apply, which registers what the settings say now, as it is, and not what they were', () => {
    const { hotkeys, shortcuts, ran } = setup();
    hotkeys.apply({});
    hotkeys.suspend();

    const answer = hotkeys.apply({ show_hotkey: 'Control+Alt+J', quick_switch_hotkey: '' });

    assert.equal(hotkeys.suspended(), false);
    assert.deepEqual(answer, {
      show: ok('Control+Alt+J'),
      pause: ok(DEFAULTS.pause),
      quickSwitch: ok(null),
    });
    assert.deepEqual(shortcuts.held().sort(), ['Control+Alt+J', DEFAULTS.pause].sort());
    shortcuts.press('Control+Alt+J');
    shortcuts.press(DEFAULTS.pause);
    shortcuts.press(DEFAULTS.quickSwitch);
    assert.deepEqual(ran, ['show', 'pause']);
  });

  it('are taken again by an apply whose setting cannot be read: the one that works is not left let go of', () => {
    const { hotkeys, shortcuts } = setup({
      normalize: (text) => (text === 'nonsense' ? null : text),
    });
    hotkeys.apply({});
    hotkeys.suspend();

    const answer = hotkeys.apply({ show_hotkey: 'nonsense' });

    assert.equal(answer.show.ok, false);
    assert.equal(answer.show.accelerator, DEFAULTS.show);
    assert.equal(shortcuts.isRegistered(DEFAULTS.show), true);
    assert.deepEqual(shortcuts.held().sort(), Object.values(DEFAULTS).sort());
  });

  it('are let go of one by one, and a system that fails for one of them does not leave the rest held', () => {
    const shortcuts = fakeShortcuts();
    const { hotkeys, logs } = setup({ shortcuts });
    hotkeys.apply({});
    const unregister = shortcuts.unregister;
    shortcuts.unregister = (accelerator) => {
      if (accelerator === DEFAULTS.show) throw new Error('not now');
      unregister(accelerator);
    };

    hotkeys.suspend();

    assert.equal(logs.length, 1);
    assert.deepEqual(shortcuts.held(), [DEFAULTS.show]);
    assert.equal(hotkeys.suspended(), true);
  });

  it('can be let go of again after being taken again, as each recording is', () => {
    const { hotkeys, shortcuts } = setup();
    hotkeys.apply({});
    for (let recording = 0; recording < 3; recording++) {
      hotkeys.suspend();
      assert.deepEqual(shortcuts.held(), [], `recording ${recording}`);
      hotkeys.resume();
      assert.deepEqual(shortcuts.held().sort(), Object.values(DEFAULTS).sort(), `recording ${recording}`);
    }
  });
});

/* -------------------------------------------------------------------------- the tray item */

describe('the tray menu item for a shortcut that is not working', () => {
  const calls = [];
  const open = () => calls.push('open');

  it('is none while all of them are registered or off, and before anything has been registered', () => {
    assert.deepEqual(hotkeyMenuItems(null, open), []);
    assert.deepEqual(hotkeyMenuItems(undefined, open), []);
    assert.deepEqual(hotkeyMenuItems({}, open), []);
    assert.deepEqual(
      hotkeyMenuItems({ show: ok(DEFAULTS.show), pause: ok(null), quickSwitch: ok('Shift+F5') }, open),
      [],
    );
    assert.equal(hotkeysFailing(null), false);
    assert.equal(hotkeysFailing({ show: ok(DEFAULTS.show), pause: ok(null), quickSwitch: ok(null) }), false);
  });

  it('is one item, that says a shortcut is not working and where to look, when any one is not ok', () => {
    const taken = { ok: false, accelerator: null, code: 'taken', error: 'Control+Alt+J could not be registered.' };
    for (const statuses of [
      { show: taken, pause: ok(DEFAULTS.pause), quickSwitch: ok(DEFAULTS.quickSwitch) },
      { show: ok(DEFAULTS.show), pause: taken, quickSwitch: ok(DEFAULTS.quickSwitch) },
      { show: ok(DEFAULTS.show), pause: ok(DEFAULTS.pause), quickSwitch: taken },
      { show: taken, pause: taken, quickSwitch: taken },
    ]) {
      const items = hotkeyMenuItems(statuses, open);
      assert.equal(items.length, 1, JSON.stringify(statuses));
      assert.equal(items[0].label, "A shortcut isn't working — open Settings");
      assert.equal(typeof items[0].click, 'function');
      assert.equal(hotkeysFailing(statuses), true);
    }
    assert.equal(HOTKEY_TROUBLE_LABEL, "A shortcut isn't working — open Settings");
  });

  it('is there for a shortcut that is not ok whatever the kind of failure, and whether or not one still works', () => {
    for (const status of [
      { ok: false, accelerator: null, code: 'taken', error: 'x' },
      { ok: false, accelerator: DEFAULTS.show, code: 'taken', error: 'x' },
      { ok: false, accelerator: null, code: 'invalid', error: 'x' },
      { ok: false, accelerator: DEFAULTS.show, code: 'unreadable', error: 'x' },
      // An older answer with no kind.
      { ok: false, accelerator: null, error: 'x' },
    ]) {
      assert.equal(hotkeyMenuItems({ show: status }, open).length, 1, JSON.stringify(status));
    }
  });

  it('does what it is handed when it is chosen, and passes it nothing of what the menu gives it', () => {
    calls.length = 0;
    const [item] = hotkeyMenuItems({ show: { ok: false, accelerator: null } }, (...args) => calls.push(args));

    item.click({ label: 'a menu item' }, { a: 'window' }, { event: true });

    assert.deepEqual(calls, [[]]);
  });

  it('follows what the shortcuts answer: it is there while another app has a key, and gone when it lets go', () => {
    // What createHotkeys answers is what the tray reads.
    const shortcuts = fakeShortcuts({ others: [DEFAULTS.pause] });
    const { hotkeys } = setup({ shortcuts });

    assert.equal(hotkeyMenuItems(hotkeys.apply({}), open).length, 1);

    shortcuts.release(DEFAULTS.pause);
    assert.deepEqual(hotkeyMenuItems(hotkeys.apply({}), open), []);
  });
});

/* ---------------------------------------------------------------------------------- ⌘K */

describe('⌘K in the window', () => {
  const press = (over = {}) => ({
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...over,
  });

  it('is the Command key and K on a Mac', () => {
    assert.equal(opensQuickSwitch(press({ meta: true }), 'darwin'), true);
  });

  it('is not Control and K on a Mac, where that is something else', () => {
    assert.equal(opensQuickSwitch(press({ control: true }), 'darwin'), false);
    assert.equal(opensQuickSwitch(press({ control: true, meta: true }), 'darwin'), false);
  });

  it('is the Control key and K on Windows and on Linux', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(opensQuickSwitch(press({ control: true }), platform), true, platform);
    }
  });

  it('is not the Windows key and K, or both keys, off a Mac', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(opensQuickSwitch(press({ meta: true }), platform), false, platform);
      assert.equal(opensQuickSwitch(press({ control: true, meta: true }), platform), false, platform);
    }
  });

  it('is not K with nothing held, or with the wrong key held alone', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.equal(opensQuickSwitch(press(), platform), false, platform);
      assert.equal(opensQuickSwitch(press({ alt: true }), platform), false, platform);
      assert.equal(opensQuickSwitch(press({ shift: true }), platform), false, platform);
    }
  });

  it('is not the chord with Shift or Alt as well, which are other shortcuts', () => {
    const chords = [
      ['darwin', { meta: true }],
      ['win32', { control: true }],
      ['linux', { control: true }],
    ];
    for (const [platform, held] of chords) {
      assert.equal(opensQuickSwitch(press({ ...held, shift: true }), platform), false, `${platform} shift`);
      assert.equal(opensQuickSwitch(press({ ...held, alt: true }), platform), false, `${platform} alt`);
      assert.equal(
        opensQuickSwitch(press({ ...held, alt: true, shift: true }), platform),
        false,
        `${platform} both`,
      );
    }
  });

  it('is the press and not the release of the key', () => {
    assert.equal(opensQuickSwitch(press({ meta: true, type: 'keyUp' }), 'darwin'), false);
    assert.equal(opensQuickSwitch(press({ control: true, type: 'keyUp' }), 'linux'), false);
    assert.equal(opensQuickSwitch(press({ meta: true, type: 'char' }), 'darwin'), false);
  });

  it('is the press and not the key being held down, which would open the box again and again', () => {
    assert.equal(opensQuickSwitch(press({ meta: true, isAutoRepeat: true }), 'darwin'), false);
    assert.equal(opensQuickSwitch(press({ control: true, isAutoRepeat: true }), 'win32'), false);
  });

  it('is K in either case: Caps Lock does not change what it is', () => {
    assert.equal(opensQuickSwitch(press({ meta: true, key: 'K' }), 'darwin'), true);
    assert.equal(opensQuickSwitch(press({ control: true, key: 'K' }), 'win32'), true);
    assert.equal(opensQuickSwitch(press({ control: true, key: 'k' }), 'linux'), true);
  });

  it('is the key that types K, and not where K is on a keyboard that has it elsewhere', () => {
    // The key in K's place on a Dvorak keyboard types a T. It is ⌘T there, and not ⌘K.
    assert.equal(opensQuickSwitch(press({ meta: true, key: 't', code: 'KeyK' }), 'darwin'), false);
    assert.equal(opensQuickSwitch(press({ meta: true, key: 'k', code: 'KeyV' }), 'darwin'), true);
  });

  it('is not any other key', () => {
    for (const key of ['j', 'l', 'Enter', 'Escape', 'Meta', 'Control', 'Dead', 'kk', '', ' ']) {
      assert.equal(opensQuickSwitch(press({ meta: true, key }), 'darwin'), false, JSON.stringify(key));
      assert.equal(opensQuickSwitch(press({ control: true, key }), 'linux'), false, JSON.stringify(key));
    }
  });

  it('is not anything from an event that is not an input at all', () => {
    for (const input of [null, undefined, {}, { type: 'keyDown' }, { type: 'keyDown', key: 5, meta: true }]) {
      assert.equal(opensQuickSwitch(input, 'darwin'), false, JSON.stringify(input));
    }
  });

  it('reads the platform it is given, and anything that is not a Mac as Control', () => {
    assert.equal(opensQuickSwitch(press({ control: true }), 'freebsd'), true);
    assert.equal(opensQuickSwitch(press({ meta: true }), 'freebsd'), false);
    assert.equal(opensQuickSwitch(press({ meta: true }), undefined), false);
  });
});
