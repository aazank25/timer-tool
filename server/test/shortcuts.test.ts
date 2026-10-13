import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { type Api, serve } from './prompt-helpers.js';
import { freshDb } from './setup.js';

const dbMod = () => import('../src/db.js');
const settingsMod = () => import('../src/lib/settings.js');
const acceleratorMod = () => import('../src/lib/accelerator.js');

const HOTKEYS = ['show_hotkey', 'pause_hotkey', 'quick_switch_hotkey'] as const;
type Hotkey = (typeof HOTKEYS)[number];

/** What each shortcut does, as the refusal words it. Written out here, so a change to them is seen. */
const ACTION: Record<Hotkey, string> = {
  show_hotkey: 'show FocusDesk',
  pause_hotkey: 'pause or resume the block on the clock',
  quick_switch_hotkey: 'open quick switch',
};

const SHIPPED: Record<Hotkey, string> = {
  show_hotkey: 'CommandOrControl+Shift+F',
  pause_hotkey: 'CommandOrControl+Shift+Space',
  quick_switch_hotkey: 'CommandOrControl+Alt+K',
};

/** Three shortcuts that are different on every platform, and are none of the shipped ones. */
const MINE: Record<Hotkey, string> = {
  show_hotkey: 'Control+Alt+1',
  pause_hotkey: 'Control+Alt+2',
  quick_switch_hotkey: 'Control+Alt+3',
};

const NOTIFICATIONS = [
  'notifications',
  'notify_away',
  'notify_long_block',
  'notify_meetings',
  'notify_wrapup',
  'notify_week_review',
  'notify_idle',
  'notify_block_done',
] as const;

/** Every setting this feature adds. */
const ADDED = [...HOTKEYS.filter((key) => key !== 'quick_switch_hotkey'), ...NOTIFICATIONS];

/** Each of the three, as the settings store them. */
async function stored(api: Api) {
  const all = (await api.call('GET', '/settings')).body;
  return { show_hotkey: all.show_hotkey, pause_hotkey: all.pause_hotkey, quick_switch_hotkey: all.quick_switch_hotkey };
}

/** Put every setting these tests touch back to what ships: no row, so the default is what is read. */
async function backToShipped() {
  const { db } = await dbMod();
  const keys = [...HOTKEYS, ...NOTIFICATIONS];
  db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`).run(...keys);
}

/** The three shortcuts set to ones of mine, straight into the database: setup, not the thing tested. */
async function haveMine(shortcuts: Record<Hotkey, string> = MINE) {
  const { setSettings } = await settingsMod();
  setSettings(shortcuts);
}

describe('what ships: the shortcut and notification settings', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });
  beforeEach(backToShipped);
  after(() => api.close());

  it('has all three shortcuts on, as the app has always had them', async () => {
    assert.deepEqual(await stored(api), SHIPPED);
    const { DEFAULT_SETTINGS } = await dbMod();
    for (const key of HOTKEYS) assert.equal(DEFAULT_SETTINGS[key], SHIPPED[key], key);
  });

  it('has pop-up notifications on, the master switch and every kind', async () => {
    const all = (await api.call('GET', '/settings')).body;
    for (const key of NOTIFICATIONS) assert.equal(all[key], 'true', key);
    const { DEFAULT_SETTINGS } = await dbMod();
    for (const key of NOTIFICATIONS) assert.equal(DEFAULT_SETTINGS[key], 'true', key);
  });

  it('is there for a database made before these settings: the next start adds them', async () => {
    const { db, initDb } = await dbMod();
    // backToShipped has taken their rows out, as a database from before them would not have them.
    const rows = () =>
      Object.fromEntries(
        (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[])
          .filter((row) => (ADDED as string[]).includes(row.key))
          .map((row) => [row.key, row.value]),
      );
    assert.deepEqual(rows(), {});
    initDb();
    assert.deepEqual(
      rows(),
      Object.fromEntries(
        ADDED.map((key) => [key, key.endsWith('_hotkey') ? SHIPPED[key as Hotkey] : 'true']),
      ),
    );
  });
});

// Show and pause are told the same way quick switch is, setting by setting: the rule that reads
// what is typed is one rule (normalizeAccelerator), and these are the cases that say so.
for (const key of ['show_hotkey', 'pause_hotkey'] as const) {
  describe(`the ${key} setting`, () => {
    let api: Api;

    before(async () => {
      await freshDb();
      api = await serve();
    });
    beforeEach(backToShipped);
    after(() => api.close());

    it('is on by default', async () => {
      assert.equal((await api.call('GET', '/settings')).body[key], SHIPPED[key]);
    });

    it('accepts an empty string, which turns the shortcut off, and it stays off', async () => {
      const res = await api.call('PATCH', '/settings', { [key]: '' });
      assert.equal(res.status, 200);
      assert.equal(res.body[key], '');
      // An empty value is a choice, not a missing one that falls back to the default.
      assert.equal((await api.call('GET', '/settings')).body[key], '');
      const { getSetting } = await settingsMod();
      assert.equal(getSetting(key), '');
    });

    it('treats a blank string as off too', async () => {
      const res = await api.call('PATCH', '/settings', { [key]: '   ' });
      assert.equal(res.status, 200);
      assert.equal(res.body[key], '');
    });

    it('stores a good combination in its canonical spelling', async () => {
      for (const [typed, saved] of [
        ['ctrl+alt+j', 'Control+Alt+J'],
        ['CmdOrCtrl+Alt+J', 'CommandOrControl+Alt+J'],
        ['  cmd + option + 7 ', 'Command+Option+7'],
        // The function keys type nothing, so they may take Shift or Alt alone.
        ['shift+f5', 'Shift+F5'],
        ['alt+F12', 'Alt+F12'],
      ] as const) {
        const res = await api.call('PATCH', '/settings', { [key]: typed });
        assert.equal(res.status, 200, typed);
        assert.equal(res.body[key], saved, typed);
        assert.equal((await api.call('GET', '/settings')).body[key], saved, typed);
      }
    });

    it('refuses what is not a shortcut with a 400 that says what to type, and writes nothing', async () => {
      assert.equal((await api.call('PATCH', '/settings', { [key]: 'Control+Alt+J' })).status, 200);
      for (const junk of [
        'Foo+A',
        'K',
        'Cmd+Shift',
        'A+B',
        'Cmd+Cmd+K',
        'hello world',
        'Cmd+Shift+Ж',
        // Shift or Alt without a command modifier would take ordinary typing from every app.
        'Shift+A',
        'Alt+Space',
        'Option+Shift+K',
        // Not printable ASCII: a no-break space, and the Kelvin sign that lower-cases to k.
        ' Cmd+K',
        'Cmd+Shift+K',
      ]) {
        const res = await api.call('PATCH', '/settings', { [key]: junk });
        assert.equal(res.status, 400, JSON.stringify(junk));
        assert.equal(res.body.error, 'Invalid request');
        assert.match(res.body.details.fieldErrors[key][0], /CommandOrControl\+Alt\+K/);
      }
      assert.equal((await api.call('GET', '/settings')).body[key], 'Control+Alt+J');
    });

    it('refuses a value that is not a string, and the whole patch when this one is bad', async () => {
      for (const bad of [null, 5, true, ['Cmd+K']]) {
        const res = await api.call('PATCH', '/settings', { [key]: bad });
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      const was = (await api.call('GET', '/settings')).body;
      const res = await api.call('PATCH', '/settings', { focus_minutes: 99, [key]: 'nope' });
      assert.equal(res.status, 400);
      const now = (await api.call('GET', '/settings')).body;
      assert.equal(now.focus_minutes, was.focus_minutes);
      assert.equal(now[key], was[key]);
    });
  });
}

describe('no two of the three shortcuts may be the same', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });
  beforeEach(async () => {
    await backToShipped();
    await haveMine();
  });
  after(() => api.close());

  /** Refused with the sentence that names who has it, and nothing in the patch written. */
  async function refused(body: Record<string, unknown>, sentence: string, was = MINE) {
    const res = await api.call('PATCH', '/settings', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, sentence, JSON.stringify(body));
    assert.deepEqual(await stored(api), was, 'nothing was written');
  }

  it('takes three that are different', async () => {
    const res = await api.call('PATCH', '/settings', {
      show_hotkey: 'Control+Alt+7',
      pause_hotkey: 'Control+Alt+8',
      quick_switch_hotkey: 'Control+Alt+9',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.show_hotkey, 'Control+Alt+7');
    assert.equal(res.body.pause_hotkey, 'Control+Alt+8');
    assert.equal(res.body.quick_switch_hotkey, 'Control+Alt+9');
  });

  it('refuses each one taking the shortcut of each other one, and says which action has it', async () => {
    for (const taker of HOTKEYS) {
      for (const owner of HOTKEYS) {
        if (taker === owner) continue;
        await refused(
          { [taker]: MINE[owner] },
          `${MINE[owner]} is already the shortcut to ${ACTION[owner]}`,
        );
      }
    }
  });

  it('says it the way the contract words it', async () => {
    await haveMine({ ...MINE, show_hotkey: 'Command+Shift+F' });
    await refused(
      { pause_hotkey: 'cmd+shift+f' },
      'Command+Shift+F is already the shortcut to show FocusDesk',
      { ...MINE, show_hotkey: 'Command+Shift+F' },
    );
  });

  it('judges the shortcut as normalised, so case, spacing, Cmd for Command and order do not hide it', async () => {
    const spellings: [string, string][] = [
      ['control+alt+1', 'Control+Alt+1'],
      ['CONTROL+ALT+1', 'Control+Alt+1'],
      ['Ctrl+Alt+1', 'Control+Alt+1'],
      [' ctrl + alt + 1 ', 'Control+Alt+1'],
      // The same keys in another order are the same shortcut: Electron would refuse the second.
      ['Alt+Control+1', 'Alt+Control+1'],
      ['alt+ctrl+1', 'Alt+Control+1'],
    ];
    for (const taker of ['pause_hotkey', 'quick_switch_hotkey'] as const) {
      for (const [typed, canonical] of spellings) {
        await refused({ [taker]: typed }, `${canonical} is already the shortcut to show FocusDesk`);
      }
    }

    // Cmd and Command are the one name, whichever way it is typed.
    await haveMine({ ...MINE, quick_switch_hotkey: 'Command+Shift+9' });
    const was = { ...MINE, quick_switch_hotkey: 'Command+Shift+9' };
    for (const [typed, canonical] of [
      ['cmd+shift+9', 'Command+Shift+9'],
      ['COMMAND+SHIFT+9', 'Command+Shift+9'],
      ['Cmd + Shift + 9', 'Command+Shift+9'],
      ['Shift+Cmd+9', 'Shift+Command+9'],
    ]) {
      await refused({ show_hotkey: typed }, `${canonical} is already the shortcut to open quick switch`, was);
      await refused(
        { pause_hotkey: typed },
        `${canonical} is already the shortcut to open quick switch`,
        was,
      );
    }
  });

  it('knows CommandOrControl as the key it is on this platform', async () => {
    // Command on a Mac and Control everywhere else, so the same keys have two names there: what is
    // typed, and the spelling it is read as.
    const names: [string, string][] =
      process.platform === 'darwin'
        ? [['Cmd', 'Command'], ['Command', 'Command']]
        : [['Ctrl', 'Control'], ['Control', 'Control']];
    await haveMine({ ...MINE, pause_hotkey: 'CommandOrControl+Shift+9' });
    const was = { ...MINE, pause_hotkey: 'CommandOrControl+Shift+9' };
    for (const [typed, read] of names) {
      await refused(
        { show_hotkey: `${typed}+Shift+9` },
        `${read}+Shift+9 is already the shortcut to ${ACTION.pause_hotkey}`,
        was,
      );
    }
  });

  it('judges a shortcut against one that was never saved, which is the default', async () => {
    await backToShipped();
    await refused(
      { quick_switch_hotkey: 'cmdorctrl+shift+f' },
      'CommandOrControl+Shift+F is already the shortcut to show FocusDesk',
      SHIPPED,
    );
    await refused(
      { show_hotkey: 'CommandOrControl+Shift+Space' },
      `CommandOrControl+Shift+Space is already the shortcut to ${ACTION.pause_hotkey}`,
      SHIPPED,
    );
    await refused(
      { pause_hotkey: 'CmdOrCtrl+Alt+K' },
      'CommandOrControl+Alt+K is already the shortcut to open quick switch',
      SHIPPED,
    );

    // The shipped ones, in every spelling there is for them, and in the order the keys were held.
    const spellings: [typed: string, read: string, action: string][] = [
      ['CmdOrCtrl + Shift + F', 'CommandOrControl+Shift+F', ACTION.show_hotkey],
      ['Shift+CommandOrControl+F', 'Shift+CommandOrControl+F', ACTION.show_hotkey],
      ['COMMANDORCONTROL+SHIFT+SPACE', 'CommandOrControl+Shift+Space', ACTION.pause_hotkey],
      ['Shift+CmdOrCtrl+space', 'Shift+CommandOrControl+Space', ACTION.pause_hotkey],
      ['Alt+CommandOrControl+K', 'Alt+CommandOrControl+K', ACTION.quick_switch_hotkey],
      // The same keys under the names of this platform: Command on a Mac, Control elsewhere.
      process.platform === 'darwin'
        ? ['Cmd+Shift+F', 'Command+Shift+F', ACTION.show_hotkey]
        : ['Ctrl+Shift+F', 'Control+Shift+F', ACTION.show_hotkey],
      process.platform === 'darwin'
        ? ['Command+Shift+Space', 'Command+Shift+Space', ACTION.pause_hotkey]
        : ['Shift+Control+Space', 'Shift+Control+Space', ACTION.pause_hotkey],
    ];
    // Each is tried on the shortcut that is not the one it names.
    for (const [typed, read, action] of spellings) {
      const taker = action === ACTION.quick_switch_hotkey ? 'show_hotkey' : 'quick_switch_hotkey';
      await refused({ [taker]: typed }, `${read} is already the shortcut to ${action}`, SHIPPED);
    }
  });

  it('refuses a shortcut that collides with a stored one in a patch that names only one', async () => {
    // Quick switch, set by itself, onto what show already has.
    await refused(
      { quick_switch_hotkey: MINE.show_hotkey },
      `${MINE.show_hotkey} is already the shortcut to show FocusDesk`,
    );
    // Show, set by itself, onto what quick switch has.
    await refused(
      { show_hotkey: MINE.quick_switch_hotkey },
      `${MINE.quick_switch_hotkey} is already the shortcut to open quick switch`,
    );
  });

  it('takes a swap in one patch, and a rotation of all three', async () => {
    let res = await api.call('PATCH', '/settings', {
      show_hotkey: MINE.pause_hotkey,
      pause_hotkey: MINE.show_hotkey,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await stored(api), {
      show_hotkey: MINE.pause_hotkey,
      pause_hotkey: MINE.show_hotkey,
      quick_switch_hotkey: MINE.quick_switch_hotkey,
    });

    await haveMine();
    res = await api.call('PATCH', '/settings', {
      show_hotkey: MINE.pause_hotkey,
      pause_hotkey: MINE.quick_switch_hotkey,
      quick_switch_hotkey: MINE.show_hotkey,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await stored(api), {
      show_hotkey: MINE.pause_hotkey,
      pause_hotkey: MINE.quick_switch_hotkey,
      quick_switch_hotkey: MINE.show_hotkey,
    });
  });

  it('refuses two in one patch that are the same, naming the one that comes first', async () => {
    await refused(
      { pause_hotkey: 'Control+Alt+9', quick_switch_hotkey: 'ctrl+alt+9' },
      `Control+Alt+9 is already the shortcut to ${ACTION.pause_hotkey}`,
    );
    await refused(
      { show_hotkey: 'Control+Alt+9', pause_hotkey: 'Control+Alt+9', quick_switch_hotkey: 'Control+Alt+9' },
      'Control+Alt+9 is already the shortcut to show FocusDesk',
    );
  });

  it('does not count a shortcut that is off, so two can be off at once', async () => {
    let res = await api.call('PATCH', '/settings', { show_hotkey: '', pause_hotkey: '' });
    assert.equal(res.status, 200);
    res = await api.call('PATCH', '/settings', { quick_switch_hotkey: '' });
    assert.equal(res.status, 200);
    assert.deepEqual(await stored(api), { show_hotkey: '', pause_hotkey: '', quick_switch_hotkey: '' });
  });

  it('lets go of a shortcut when it is turned off, in the same patch or an earlier one', async () => {
    // In the same patch: show goes off, and quick switch takes its keys.
    let res = await api.call('PATCH', '/settings', { show_hotkey: '', quick_switch_hotkey: MINE.show_hotkey });
    assert.equal(res.status, 200);
    assert.equal((await stored(api)).quick_switch_hotkey, MINE.show_hotkey);

    // In an earlier one.
    await haveMine();
    assert.equal((await api.call('PATCH', '/settings', { show_hotkey: '' })).status, 200);
    res = await api.call('PATCH', '/settings', { pause_hotkey: MINE.show_hotkey });
    assert.equal(res.status, 200);
    assert.equal((await stored(api)).pause_hotkey, MINE.show_hotkey);
  });

  it('is not a clash with itself: a shortcut saved again, in any spelling, is fine', async () => {
    for (const same of [MINE.show_hotkey, 'ctrl+alt+1', 'CONTROL + ALT + 1']) {
      const res = await api.call('PATCH', '/settings', { show_hotkey: same });
      assert.equal(res.status, 200, same);
      assert.equal(res.body.show_hotkey, MINE.show_hotkey, same);
    }
  });

  it('leaves close neighbours alone: another key, or another modifier, is another shortcut', async () => {
    for (const [key, free] of [
      ['show_hotkey', 'Control+Alt+Shift+1'],
      ['show_hotkey', 'Control+Shift+1'],
      ['pause_hotkey', 'Control+Alt+Space'],
      ['quick_switch_hotkey', 'Control+Alt+4'],
      ['quick_switch_hotkey', 'Shift+F5'],
    ] as const) {
      assert.equal((await api.call('PATCH', '/settings', { [key]: free })).status, 200, free);
    }
  });

  it('writes nothing when it refuses, not even the other settings in the patch', async () => {
    const before = (await api.call('GET', '/settings')).body.focus_minutes;
    await refused({ focus_minutes: 99, quick_switch_hotkey: MINE.show_hotkey }, `${MINE.show_hotkey} is already the shortcut to show FocusDesk`);
    assert.equal((await api.call('GET', '/settings')).body.focus_minutes, before);
  });

  it('only looks when a shortcut is being written, so the settings screen can save the others', async () => {
    // Two that are the same are in the database somehow (edited by hand). A patch that is about
    // something else is not refused for it: there is nothing in it that could have made it worse.
    await haveMine({ ...MINE, pause_hotkey: MINE.show_hotkey });
    const res = await api.call('PATCH', '/settings', { focus_minutes: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.body.focus_minutes, '50');
    await api.call('PATCH', '/settings', { focus_minutes: 45 });
  });

  it("is not tripped by a save of every setting as it was loaded, which is what the Timer card's older saves sent", async () => {
    const loaded = (await api.call('GET', '/settings')).body;
    const res = await api.call('PATCH', '/settings', { ...loaded, focus_minutes: 50 });
    assert.equal(res.status, 200);
    assert.deepEqual(await stored(api), MINE);
    assert.equal(res.body.focus_minutes, '50');
    await api.call('PATCH', '/settings', { focus_minutes: 45 });
  });
});

describe('hotkeyClash', () => {
  const all = (show: string, pause: string, quick: string) => ({
    show_hotkey: show,
    pause_hotkey: pause,
    quick_switch_hotkey: quick,
  });

  it('is null for three that are different, off ones, and ones that are not shortcuts', async () => {
    const { hotkeyClash } = await acceleratorMod();
    assert.equal(hotkeyClash(all(...(Object.values(SHIPPED) as [string, string, string]))), null);
    assert.equal(hotkeyClash(all('', '', '')), null);
    assert.equal(hotkeyClash(all('', 'Control+Alt+1', '')), null);
    // Not for this to say: normalizeAccelerator refuses them where they are written.
    assert.equal(hotkeyClash(all('nope', 'nope', 'nope')), null);
  });

  it('names the action that already has the shortcut, for each pair', async () => {
    const { hotkeyClash } = await acceleratorMod();
    // With no word about what is being written, the later of two gives way to the earlier.
    assert.equal(
      hotkeyClash(all('Control+Alt+1', 'Control+Alt+1', 'Control+Alt+3')),
      'Control+Alt+1 is already the shortcut to show FocusDesk',
    );
    assert.equal(
      hotkeyClash(all('Control+Alt+1', 'Control+Alt+2', 'Control+Alt+1')),
      'Control+Alt+1 is already the shortcut to show FocusDesk',
    );
    assert.equal(
      hotkeyClash(all('Control+Alt+1', 'Control+Alt+2', 'Control+Alt+2')),
      `Control+Alt+2 is already the shortcut to ${ACTION.pause_hotkey}`,
    );
  });

  it('lets what is being written give way to what is already there', async () => {
    const { hotkeyClash } = await acceleratorMod();
    const same = all('Control+Alt+1', 'Control+Alt+1', '');
    // Only show is being written, so pause is the one that had it.
    assert.equal(
      hotkeyClash(same, ['show_hotkey']),
      `Control+Alt+1 is already the shortcut to ${ACTION.pause_hotkey}`,
    );
    // Only pause, or both: the later one gives way.
    assert.equal(hotkeyClash(same, ['pause_hotkey']), 'Control+Alt+1 is already the shortcut to show FocusDesk');
    assert.equal(
      hotkeyClash(same, ['show_hotkey', 'pause_hotkey']),
      'Control+Alt+1 is already the shortcut to show FocusDesk',
    );
  });

  it('spells the shortcut as normalizeAccelerator does, whatever it was stored as', async () => {
    const { hotkeyClash } = await acceleratorMod();
    assert.equal(
      hotkeyClash(all('Control+Alt+1', '', 'ctrl + ALT + 1'), ['quick_switch_hotkey']),
      'Control+Alt+1 is already the shortcut to show FocusDesk',
    );
  });

  it('judges by the keys pressed, in any spelling and any order, on every platform', async () => {
    const { hotkeyClash } = await acceleratorMod();
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const spelling of [
        'CommandOrControl+Shift+F',
        'cmdorctrl+shift+f',
        'CmdOrCtrl + Shift + F',
        'Shift+CommandOrControl+F',
        'COMMANDORCONTROL+SHIFT+F',
      ]) {
        assert.match(
          hotkeyClash(all('CommandOrControl+Shift+F', spelling, ''), ['pause_hotkey'], platform) ?? '',
          /is already the shortcut to show FocusDesk$/,
          `${spelling} on ${platform}`,
        );
      }
    }
  });

  it('knows the Command key on a Mac, where CommandOrControl is Command, and not Control', async () => {
    const { hotkeyClash } = await acceleratorMod();
    const clash = (other: string) =>
      hotkeyClash(all('CommandOrControl+Shift+F', other, ''), ['pause_hotkey'], 'darwin');
    assert.ok(clash('Command+Shift+F'));
    assert.ok(clash('Cmd+Shift+F'));
    assert.ok(clash('Super+Shift+F'));
    assert.equal(clash('Control+Shift+F'), null);
    assert.equal(clash('Ctrl+Shift+F'), null);
  });

  it('knows the Control key everywhere else, where CommandOrControl is Control, and not Command', async () => {
    const { hotkeyClash } = await acceleratorMod();
    for (const platform of ['linux', 'win32']) {
      const clash = (other: string) =>
        hotkeyClash(all('CommandOrControl+Shift+F', other, ''), ['pause_hotkey'], platform);
      assert.ok(clash('Control+Shift+F'), platform);
      assert.ok(clash('Ctrl+Shift+F'), platform);
      assert.ok(clash('Shift+Control+F'), platform);
      // Command is the Windows key there, which is another key.
      assert.equal(clash('Command+Shift+F'), null, platform);
      assert.equal(clash('Super+Shift+F'), null, platform);
      // Command and Super are the one key there, the Windows key, and the same on a Mac.
      assert.ok(hotkeyClash(all('Command+Shift+F', 'Super+Shift+F', ''), undefined, platform), platform);
    }
    assert.ok(hotkeyClash(all('Command+Shift+F', 'Super+Shift+F', ''), undefined, 'darwin'));
  });

  it('does not count a combination that differs by a key or a modifier', async () => {
    const { hotkeyClash } = await acceleratorMod();
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const other of [
        'CommandOrControl+Alt+K',
        'CommandOrControl+Shift+K',
        'CommandOrControl+Alt+F',
        'CommandOrControl+F',
        'CommandOrControl+Shift+Alt+F',
        'CommandOrControl+Shift+Enter',
        'CommandOrControl+Alt+Space',
        'Control+Alt+Shift+F',
        'Shift+F5',
      ]) {
        assert.equal(
          hotkeyClash(all('CommandOrControl+Shift+F', other, ''), ['pause_hotkey'], platform),
          null,
          `${other} on ${platform}`,
        );
      }
    }
  });
});

/** Every spelling of the command key the settings take, as typed. */
const COMMAND_KEYS = ['Command', 'cmd', 'Control', 'ctrl', 'CommandOrControl', 'CmdOrCtrl'];

/** The keys that go with the command key alone in every app: see reservedKind. */
const EVERYDAY = [...'ACFHMNOPQRSTVWXZ'].concat('Tab');

describe('shortcuts that are already something: refused where a shortcut is read', () => {
  it('refuses the command key with one of A C F H M N O P Q R S T V W X Z or Tab, in every spelling', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const command of COMMAND_KEYS) {
      for (const key of EVERYDAY) {
        for (const typed of [
          `${command}+${key}`,
          `${command.toUpperCase()}+${key.toLowerCase()}`,
          ` ${command} + ${key} `,
        ]) {
          assert.equal(normalizeAccelerator(typed), null, typed);
        }
      }
    }
  });

  it('refuses redo: Shift and the command key with Z, in either order', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const command of COMMAND_KEYS) {
      assert.equal(normalizeAccelerator(`Shift+${command}+Z`), null, `Shift+${command}+Z`);
      assert.equal(normalizeAccelerator(`${command}+Shift+Z`), null, `${command}+Shift+Z`);
    }
  });

  it('refuses Alt+F4 and Alt+Tab, and Option for Alt', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const typed of ['Alt+F4', 'alt+f4', 'Option+F4', 'Alt+Tab', 'option+tab', ' ALT + TAB ']) {
      assert.equal(normalizeAccelerator(typed), null, typed);
    }
  });

  it('refuses Command+Space, which is Spotlight, and CommandOrControl+Space, which is it on a Mac', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const typed of ['Command+Space', 'cmd+space', 'CommandOrControl+Space', 'CmdOrCtrl+SPACE']) {
      assert.equal(normalizeAccelerator(typed), null, typed);
    }
    // Control+Space is not Spotlight, anywhere.
    assert.equal(normalizeAccelerator('Control+Space'), 'Control+Space');
  });

  it('keeps the three shortcuts that ship valid, in their own spelling', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const key of HOTKEYS) assert.equal(normalizeAccelerator(SHIPPED[key]), SHIPPED[key], key);
  });

  it('leaves alone anything with another modifier or another key: those are other shortcuts', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    for (const typed of [
      // Another modifier makes it another shortcut.
      'Command+Shift+C',
      'Control+Alt+C',
      'CommandOrControl+Shift+Q',
      'CommandOrControl+Shift+Tab',
      'Command+Alt+Z',
      'Command+Shift+Alt+Z',
      'Control+Command+C',
      'Shift+Alt+F4',
      'Control+Alt+F4',
      'Command+Shift+Space',
      'CommandOrControl+Alt+Space',
      'Shift+Control+Y',
      // Another key.
      'Command+B',
      'Command+K',
      'Control+J',
      'CommandOrControl+Y',
      'Command+1',
      'Command+Enter',
      // A function key may go with Alt or Shift alone, and only Alt+F4 of them is a system key.
      'Alt+F5',
      'Shift+F4',
      'Alt+F12',
    ]) {
      assert.notEqual(normalizeAccelerator(typed), null, typed);
    }
  });

  it('says which it is: reserved, and not only that it is not a shortcut', async () => {
    const { readAccelerator } = await acceleratorMod();

    assert.deepEqual(readAccelerator('cmd+c', false), {
      ok: false,
      reason: 'reserved',
      message:
        'Command+C is a shortcut every app uses; pick one with Command+Shift or Command+Alt instead',
    });
    assert.deepEqual(readAccelerator('ctrl+tab'), {
      ok: false,
      reason: 'reserved',
      message:
        'Control+Tab is a shortcut every app uses; pick one with Control+Shift or Control+Alt instead',
    });
    assert.deepEqual(readAccelerator('Shift+CommandOrControl+Z'), {
      ok: false,
      reason: 'reserved',
      message: 'Shift+CommandOrControl+Z is redo in nearly every app; pick another key',
    });
    assert.deepEqual(readAccelerator('alt+f4'), {
      ok: false,
      reason: 'reserved',
      message: 'Alt+F4 closes a window on Windows; pick another shortcut',
    });
    assert.deepEqual(readAccelerator('Alt+Tab'), {
      ok: false,
      reason: 'reserved',
      message: 'Alt+Tab switches between windows on Windows; pick another shortcut',
    });
    assert.deepEqual(readAccelerator('CmdOrCtrl+Space'), {
      ok: false,
      reason: 'reserved',
      message:
        'CommandOrControl+Space opens Spotlight on a Mac; pick one with CommandOrControl+Shift or CommandOrControl+Alt instead',
    });

    // Not a shortcut at all, or one that would take a key from every app, is only that.
    for (const junk of ['Foo+A', 'K', 'Cmd+Shift', 'Shift+A', 'Alt+Space', '', 'Cmd+Shift+Ж']) {
      assert.deepEqual(readAccelerator(junk), { ok: false, reason: 'invalid' }, JSON.stringify(junk));
    }
    // A good one is read as before.
    assert.deepEqual(readAccelerator('ctrl+alt+j'), { ok: true, accelerator: 'Control+Alt+J' });
  });

  it('counts Super as the command key on a Mac, where it is, and not elsewhere, where it is the Windows key', async () => {
    const { readAccelerator, reservedKind } = await acceleratorMod();
    assert.equal(reservedKind(['Super'], 'C', true), 'everyday');
    assert.equal(reservedKind(['Super'], 'Space', true), 'spotlight');
    assert.equal(reservedKind(['Shift', 'Super'], 'Z', true), 'redo');
    assert.equal(readAccelerator('Super+Q', true).ok, false);

    assert.equal(reservedKind(['Super'], 'C', false), null);
    assert.equal(reservedKind(['Super'], 'Space', false), null);
    assert.equal(reservedKind(['Shift', 'Super'], 'Z', false), null);
    assert.deepEqual(readAccelerator('Super+Q', false), { ok: true, accelerator: 'Super+Q' });
    // Command is a Mac's key by name, and is refused on every platform.
    assert.equal(readAccelerator('Command+Q', false).ok, false);
    assert.equal(readAccelerator('Command+Q', true).ok, false);
  });

  it('is judged by the modifiers as a set: both command keys, or a third modifier, is another shortcut', async () => {
    const { reservedKind } = await acceleratorMod();
    assert.equal(reservedKind(['Command', 'Control'], 'C', true), null);
    assert.equal(reservedKind(['Command', 'Alt'], 'C', true), null);
    assert.equal(reservedKind(['Command', 'Shift'], 'C', true), null);
    assert.equal(reservedKind(['Command', 'Shift'], 'Z', true), 'redo');
    assert.equal(reservedKind(['Shift', 'Command'], 'Z', true), 'redo');
    assert.equal(reservedKind(['Command', 'Alt', 'Shift'], 'Z', true), null);
    assert.equal(reservedKind(['Alt', 'Shift'], 'F4', true), null);
    assert.equal(reservedKind(['Alt'], 'F5', true), null);
    assert.equal(reservedKind([], 'C', true), null);
    // Shift is not the command key, so Shift+Alt+Z is not redo.
    assert.equal(reservedKind(['Shift', 'Alt'], 'Z', true), null);
  });
});

for (const key of HOTKEYS) {
  describe(`the ${key} setting and the shortcuts that are already something`, () => {
    let api: Api;

    before(async () => {
      await freshDb();
      api = await serve();
    });
    beforeEach(backToShipped);
    after(() => api.close());

    it('refuses each of them with a 400 that says what it is, and writes nothing', async () => {
      assert.equal((await api.call('PATCH', '/settings', { [key]: MINE[key] })).status, 200);
      for (const [typed, said] of [
        [
          'Command+C',
          /^Command\+C is a shortcut every app uses; pick one with Command\+Shift or Command\+Alt instead$/,
        ],
        ['ctrl+q', /^Control\+Q is a shortcut every app uses/],
        ['CmdOrCtrl+Tab', /^CommandOrControl\+Tab is a shortcut every app uses/],
        ['Control+W', /^Control\+W is a shortcut every app uses/],
        ['CommandOrControl+Z', /^CommandOrControl\+Z is a shortcut every app uses/],
        ['Shift+Command+Z', /^Shift\+Command\+Z is redo in nearly every app/],
        ['Shift+Control+Z', /^Shift\+Control\+Z is redo in nearly every app/],
        ['Alt+F4', /^Alt\+F4 closes a window on Windows/],
        ['Alt+Tab', /^Alt\+Tab switches between windows on Windows/],
        ['Command+Space', /^Command\+Space opens Spotlight on a Mac/],
      ] as const) {
        const res = await api.call('PATCH', '/settings', { [key]: typed });
        assert.equal(res.status, 400, typed);
        assert.equal(res.body.error, 'Invalid request', typed);
        assert.match(res.body.details.fieldErrors[key][0], said, typed);
      }
      assert.equal((await api.call('GET', '/settings')).body[key], MINE[key]);
    });

    it('refuses the whole patch when this one is reserved, and nothing in it is written', async () => {
      const was = (await api.call('GET', '/settings')).body;
      const res = await api.call('PATCH', '/settings', { focus_minutes: 99, [key]: 'cmd+s' });
      assert.equal(res.status, 400);
      const now = (await api.call('GET', '/settings')).body;
      assert.equal(now.focus_minutes, was.focus_minutes);
      assert.equal(now[key], was[key]);
    });

    it('takes the same keys with another modifier, the one that ships, and off', async () => {
      for (const [typed, saved] of [
        ['cmd+shift+c', 'Command+Shift+C'],
        ['ctrl+alt+c', 'Control+Alt+C'],
        ['CommandOrControl+Shift+Tab', 'CommandOrControl+Shift+Tab'],
        ['Control+Space', 'Control+Space'],
        ['alt+f5', 'Alt+F5'],
        [SHIPPED[key], SHIPPED[key]],
        ['', ''],
      ] as const) {
        const res = await api.call('PATCH', '/settings', { [key]: typed });
        assert.equal(res.status, 200, typed);
        assert.equal(res.body[key], saved, typed);
      }
    });
  });
}

describe('the notification settings', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });
  beforeEach(backToShipped);
  after(() => api.close());

  it('are all on by default', async () => {
    const all = (await api.call('GET', '/settings')).body;
    for (const key of NOTIFICATIONS) assert.equal(all[key], 'true', key);
  });

  it('take true, false, "true" and "false", and give back the text', async () => {
    for (const key of NOTIFICATIONS) {
      for (const [sent, kept] of [
        [false, 'false'],
        [true, 'true'],
        ['false', 'false'],
        ['true', 'true'],
      ] as const) {
        const res = await api.call('PATCH', '/settings', { [key]: sent });
        assert.equal(res.status, 200, `${key}: ${sent}`);
        assert.equal(res.body[key], kept, `${key}: ${sent}`);
        assert.equal((await api.call('GET', '/settings')).body[key], kept, `${key}: ${sent}`);
      }
    }
  });

  it('refuse anything else, and write nothing', async () => {
    for (const key of NOTIFICATIONS) {
      assert.equal((await api.call('PATCH', '/settings', { [key]: false })).status, 200);
      for (const bad of ['yes', 'no', 'on', 'off', 'TRUE', 'False', ' true', '', '0', '1', 0, 1, null, [], {}, ['true']]) {
        const res = await api.call('PATCH', '/settings', { [key]: bad });
        assert.equal(res.status, 400, `${key}: ${JSON.stringify(bad)}`);
        assert.ok(res.body.details.fieldErrors[key], `${key}: ${JSON.stringify(bad)} is named`);
        assert.equal((await api.call('GET', '/settings')).body[key], 'false', `${key}: ${JSON.stringify(bad)}`);
      }
    }
  });

  it('refuse the whole patch when one of them is bad', async () => {
    const res = await api.call('PATCH', '/settings', { notifications: false, notify_away: 'maybe' });
    assert.equal(res.status, 400);
    assert.equal((await api.call('GET', '/settings')).body.notifications, 'true');
  });

  it('are each their own: one off leaves the others as they were, the master included', async () => {
    for (const key of NOTIFICATIONS) {
      await backToShipped();
      const res = await api.call('PATCH', '/settings', { [key]: false });
      assert.equal(res.status, 200);
      for (const other of NOTIFICATIONS) {
        assert.equal(res.body[other], other === key ? 'false' : 'true', `${key} off, ${other}`);
      }
    }
  });

  it('are left alone by a patch about other settings, as the Timer card sends them', async () => {
    await api.call('PATCH', '/settings', { notifications: false, notify_idle: false });
    const loaded = (await api.call('GET', '/settings')).body;
    const res = await api.call('PATCH', '/settings', { ...loaded, focus_minutes: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications, 'false');
    assert.equal(res.body.notify_idle, 'false');
    assert.equal(res.body.notify_away, 'true');
    await api.call('PATCH', '/settings', { focus_minutes: 45 });
  });
});
