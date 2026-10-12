import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  createAttention,
  interruptedItem,
  MENU_LABEL_MAX,
  PRESENT_WITHIN_SECONDS,
  trimLabel,
} from '../attention.mjs';

/* ------------------------------------------------------------ what the server lists */

const at = '2026-10-12T14:30:00.000Z';

const away = {
  id: 'away:3',
  kind: 'away',
  title: 'You were away 40 min',
  body: '10:10 AM to 10:50 AM, while “Deep work” was on the clock.',
  createdAt: at,
  actions: [
    { id: 'keep', label: 'Keep it' },
    { id: 'drop', label: 'Drop 40 min' },
  ],
};
const longBlock = {
  id: 'long-block:5:1',
  kind: 'long-block',
  title: 'Still on “Deep work”?',
  body: 'You have worked 2 h on this block.',
  createdAt: at,
  actions: [
    { id: 'finish', label: 'Finish block', open: '/?finish=1' },
    { id: 'keep-going', label: 'Keep going' },
  ],
};
const meetingStart = {
  id: 'meeting-start:ics:x',
  kind: 'meeting-start',
  title: 'Roadmap review has started',
  body: 'Pause “Deep work” for it?',
  createdAt: at,
  actions: [
    { id: 'pause', label: 'Pause block', primary: true },
    { id: 'dismiss', label: 'Dismiss' },
  ],
};
const wrapUp = {
  id: 'wrapup:2026-10-12',
  kind: 'wrapup',
  title: 'Time to wrap up the day',
  body: 'You have focused for 4 h 10 min across 3 blocks so far today.',
  createdAt: at,
  actions: [
    { id: 'wrap-up', label: 'Wrap up', primary: true, open: '/wrap-up' },
    { id: 'dismiss', label: 'Not today' },
  ],
};
const review = {
  id: 'week-review:2026-10-05',
  kind: 'week-review',
  title: 'Review last week',
  body: 'The week of Oct 5, with 22 h 15 min of focus.',
  createdAt: at,
  actions: [
    { id: 'review', label: 'Review', primary: true, open: '/wrap-up/week?week=2026-10-05' },
    { id: 'dismiss', label: 'Not this week' },
  ],
};
const idle = {
  id: 'idle:2026-10-12T14:15:00.000Z',
  kind: 'idle',
  title: 'Nothing on the clock',
  body: 'Since 2:15 PM. Start something?',
  createdAt: at,
  actions: [
    { id: 'start', label: 'Start a block', primary: true, open: '/' },
    { id: 'dismiss', label: 'Not now' },
  ],
};

/* ---------------------------------------------------------------------------- the world */

/** Electron's Notification, as far as it matters: made, shown, and clicked or closed by someone. */
function notificationClass({ supported = true, failsToShow = false } = {}) {
  return class FakeNotification extends EventEmitter {
    static created = [];
    static isSupported() {
      return supported;
    }
    constructor(options) {
      super();
      this.options = options;
      this.shown = false;
      FakeNotification.created.push(this);
    }
    show() {
      if (failsToShow) throw new Error('this platform cannot show it');
      this.shown = true;
    }
  };
}

/** What the person does with the machine, and what the app was asked to do about it. */
function setup({ prompts = [], supported = true, failsToShow = false } = {}) {
  const world = { prompts, idle: 0, locked: false, listError: null, answerError: null, listed: 0 };
  const calls = { acted: [], windows: [], palettes: 0, errors: [], changes: 0, afterActions: 0, logs: [] };
  const Notification = notificationClass({ supported, failsToShow });
  const attention = createAttention({
    fetchPrompts: async () => {
      world.listed++;
      if (world.listError) throw world.listError;
      return world.prompts;
    },
    actOnPrompt: async (id, action) => {
      calls.acted.push([id, action]);
      if (world.answerError) throw world.answerError;
    },
    Notification,
    getIdleSeconds: () => {
      if (world.idle instanceof Error) throw world.idle;
      return world.idle;
    },
    isLocked: () => world.locked,
    openWindow: (route) => calls.windows.push(route),
    openPalette: () => calls.palettes++,
    showError: (message) => calls.errors.push(message),
    onChange: () => calls.changes++,
    afterAction: () => calls.afterActions++,
    log: (...args) => calls.logs.push(args),
  });
  return { world, calls, attention, Notification };
}

/** The items of the menu section, by label. */
const section = (attention) => attention.menuItems();
const submenuOf = (attention, title) => section(attention).find((item) => item.label === title);

/* ----------------------------------------------------------------------- notifications */

describe('notifications', () => {
  it('tells about a prompt the first time it is listed, with its title and body and nothing else', async () => {
    const { attention, Notification } = setup({ prompts: [away] });

    await attention.refresh();

    assert.equal(Notification.created.length, 1);
    const [notification] = Notification.created;
    // No buttons: they need a signed app on a Mac, and a click opens the app where the buttons are.
    assert.deepEqual(notification.options, { title: away.title, body: away.body });
    assert.equal(notification.shown, true);
    assert.deepEqual(attention.notified(), ['away:3']);
  });

  it('tells about each prompt once, however often the list is read, and what is new as it comes', async () => {
    const { world, attention, Notification } = setup({ prompts: [away] });

    await attention.refresh();
    await attention.refresh();
    await attention.refresh();
    assert.equal(Notification.created.length, 1);

    world.prompts = [away, wrapUp];
    await attention.refresh();
    assert.deepEqual(
      Notification.created.map((n) => n.options.title),
      [away.title, wrapUp.title],
    );

    // Answered, and then listed again some time later: it has been told about already.
    world.prompts = [wrapUp];
    await attention.refresh();
    world.prompts = [away, wrapUp];
    await attention.refresh();
    assert.equal(Notification.created.length, 2);
    assert.deepEqual(attention.notified(), ['away:3', 'wrapup:2026-10-12']);
  });

  it('tells about everything that is new at once, in the order the server lists it', async () => {
    const { attention, Notification } = setup({ prompts: [longBlock, away, idle] });

    await attention.refresh();

    assert.deepEqual(
      Notification.created.map((n) => n.options.title),
      [longBlock.title, away.title, idle.title],
    );
  });

  it('waits while the screen is locked, and tells once you are back', async () => {
    const { world, attention, Notification } = setup({ prompts: [away] });

    world.locked = true;
    await attention.refresh();
    await attention.refresh();
    assert.equal(Notification.created.length, 0);
    assert.deepEqual(attention.notified(), []);
    // It is on the menu all the same.
    assert.equal(attention.pending(), 1);

    world.locked = false;
    await attention.refresh();
    assert.equal(Notification.created.length, 1);
  });

  it('waits until you have touched the machine in the last two minutes', async () => {
    const { world, attention, Notification } = setup({ prompts: [away] });
    assert.equal(PRESENT_WITHIN_SECONDS, 120);

    world.idle = 120;
    await attention.refresh();
    assert.equal(Notification.created.length, 0, 'two minutes untouched is away');

    world.idle = 119;
    await attention.refresh();
    assert.equal(Notification.created.length, 1, 'a moment short of that is not');
  });

  it('tells about what it had to wait for, and not again about what it did not', async () => {
    const { world, attention, Notification } = setup({ prompts: [away] });
    await attention.refresh();
    assert.equal(Notification.created.length, 1);

    world.prompts = [away, wrapUp];
    world.locked = true;
    await attention.refresh();
    world.prompts = [away, wrapUp, idle];
    world.locked = false;
    await attention.refresh();

    assert.deepEqual(
      Notification.created.map((n) => n.options.title),
      [away.title, wrapUp.title, idle.title],
    );
  });

  it('is told about at once when the idle time cannot be read', async () => {
    const { world, attention, Notification } = setup({ prompts: [away] });
    world.idle = new Error('not on this platform');

    await attention.refresh();

    assert.equal(Notification.created.length, 1);
    assert.equal(world.idle instanceof Error, true);
  });

  it('shows nothing at all where notifications are not supported, and the list and menu work the same', async () => {
    const { attention, calls, Notification } = setup({ prompts: [away, wrapUp], supported: false });

    await attention.refresh();
    await attention.refresh();

    assert.equal(Notification.created.length, 0);
    assert.deepEqual(attention.notified(), []);
    assert.equal(attention.pending(), 2);
    assert.equal(section(attention).length, 4);
    assert.equal(calls.changes, 2);
    assert.deepEqual(calls.logs, []);
  });

  it('logs a notification that cannot be shown, goes on, and does not try that one again', async () => {
    const { attention, calls, Notification } = setup({ prompts: [away], failsToShow: true });

    await assert.doesNotReject(attention.refresh());
    await attention.refresh();

    assert.equal(Notification.created.length, 1, 'tried once');
    assert.equal(calls.logs.length, 1);
    assert.equal(attention.heldCount(), 0, 'and not held on to');
    assert.equal(attention.pending(), 1, 'the prompt is still on the menu');
  });

  it('holds on to every notification until it is clicked or closed, or macOS lets go of it', async () => {
    const { attention, Notification } = setup({ prompts: [away, wrapUp, idle] });

    await attention.refresh();
    assert.equal(attention.heldCount(), 3);

    const [first, second] = Notification.created;
    first.emit('click', {});
    assert.equal(attention.heldCount(), 2, 'clicked');
    second.emit('close', {});
    assert.equal(attention.heldCount(), 1, 'closed');
    Notification.created[2].emit('failed', {}, 'denied');
    assert.equal(attention.heldCount(), 0, 'failed');
  });

  it('listens for the click and the close on each notification it shows', async () => {
    const { attention, Notification } = setup({ prompts: [away] });

    await attention.refresh();

    const [notification] = Notification.created;
    assert.equal(notification.listenerCount('click'), 1);
    assert.equal(notification.listenerCount('close'), 1);
  });
});

describe('clicking a notification', () => {
  /** Show a notification for the prompt, click it, and say what was opened. */
  async function clickOn(prompt) {
    const { attention, calls, Notification } = setup({ prompts: [prompt] });
    await attention.refresh();
    Notification.created[0].emit('click', {});
    return calls;
  }

  it('opens the quick-switch box for the nudge to start something, and not the window', async () => {
    const calls = await clickOn(idle);

    assert.equal(calls.palettes, 1);
    assert.deepEqual(calls.windows, []);
  });

  it('opens the window at the page of the main answer when that opens a page', async () => {
    assert.deepEqual((await clickOn(wrapUp)).windows, ['/wrap-up']);
    assert.deepEqual((await clickOn(review)).windows, ['/wrap-up/week?week=2026-10-05']);
    assert.equal((await clickOn(wrapUp)).palettes, 0);
  });

  it('opens the window as it is for anything else, where the banners have the buttons', async () => {
    // Its first answer opens a page, but it is not the main one.
    assert.deepEqual((await clickOn(longBlock)).windows, [undefined]);
    // Answers that are sent to the server, main or not.
    assert.deepEqual((await clickOn(away)).windows, [undefined]);
    assert.deepEqual((await clickOn(meetingStart)).windows, [undefined]);
    // A kind it has not heard of.
    const strange = { ...away, id: 'strange:1', kind: 'strange' };
    assert.deepEqual((await clickOn(strange)).windows, [undefined]);
  });

  it('answers nothing: a click only opens what is waiting', async () => {
    const calls = await clickOn(meetingStart);

    assert.deepEqual(calls.acted, []);
  });

  it('is logged and not thrown when what it opens fails', async () => {
    const logs = [];
    const Notification = notificationClass();
    const attention = createAttention({
      fetchPrompts: async () => [wrapUp],
      actOnPrompt: async () => {},
      Notification,
      getIdleSeconds: () => 0,
      isLocked: () => false,
      openWindow: () => {
        throw new Error('no window');
      },
      openPalette: () => {},
      showError: () => {},
      log: (...args) => logs.push(args),
    });
    await attention.refresh();

    assert.doesNotThrow(() => Notification.created[0].emit('click', {}));
    assert.equal(logs.length, 1);
  });
});

describe('reading the list', () => {
  it('keeps what it knew when a read fails, says so in the log, and does not tell anyone', async () => {
    const { world, attention, calls, Notification } = setup({ prompts: [away] });
    await attention.refresh();
    const changes = calls.changes;

    world.listError = new Error('the server is away');
    world.prompts = [away, wrapUp];
    await assert.doesNotReject(attention.refresh());

    assert.deepEqual(
      attention.prompts().map((p) => p.id),
      ['away:3'],
    );
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.changes, changes);
    assert.equal(Notification.created.length, 1);
  });

  it('ignores an answer that is not a list', async () => {
    const { world, attention } = setup({ prompts: [away] });
    await attention.refresh();

    world.prompts = { error: 'nope' };
    await attention.refresh();

    assert.equal(attention.pending(), 1);
  });

  it('says the list may have changed after every read that worked', async () => {
    const { world, attention, calls } = setup();

    await attention.refresh();
    world.prompts = [away];
    await attention.refresh();

    assert.equal(calls.changes, 2);
  });

  it('reads one at a time, so two asked together cannot tell about a prompt twice', async () => {
    const { attention, Notification, world } = setup({ prompts: [away] });

    await Promise.all([attention.refresh(), attention.refresh(), attention.refresh()]);

    assert.equal(world.listed, 3);
    assert.equal(Notification.created.length, 1);
  });

  it('keeps the answers in the order the reads were asked for, so an old one cannot overwrite a newer', async () => {
    let calls = 0;
    let answerFirst;
    const attention = createAttention({
      // The first read is slow and the second quick, and the second is the later answer.
      fetchPrompts: () => {
        calls++;
        return calls === 1
          ? new Promise((resolve) => (answerFirst = resolve))
          : Promise.resolve([away, wrapUp]);
      },
      actOnPrompt: async () => {},
      Notification: notificationClass({ supported: false }),
      getIdleSeconds: () => 0,
      isLocked: () => false,
      openWindow: () => {},
      openPalette: () => {},
      showError: () => {},
    });

    const first = attention.refresh();
    const second = attention.refresh();
    // Let the first read begin, and answer it only now that the second has been asked for.
    await new Promise((resolve) => setImmediate(resolve));
    answerFirst([away]);
    await Promise.all([first, second]);

    assert.deepEqual(
      attention.prompts().map((p) => p.id),
      ['away:3', 'wrapup:2026-10-12'],
    );
  });

  it('hands out the list as data that cannot be used to change it', async () => {
    const { attention } = setup({ prompts: [away] });
    await attention.refresh();

    const [copy] = attention.prompts();
    copy.title = 'changed';
    copy.actions[0].label = 'changed';

    assert.equal(attention.prompts()[0].title, away.title);
    assert.equal(attention.prompts()[0].actions[0].label, 'Keep it');
  });

  it('says what the menu is made of, and not what the prompt says in its body', async () => {
    const { world, attention } = setup({ prompts: [longBlock] });
    await attention.refresh();
    const before = attention.signature();

    // A long block's body counts up as it runs.
    world.prompts = [{ ...longBlock, body: 'You have worked 2 h 5 min on this block.' }];
    await attention.refresh();
    assert.equal(attention.signature(), before);

    world.prompts = [{ ...longBlock, title: 'Still on “Writing”?' }];
    await attention.refresh();
    assert.notEqual(attention.signature(), before);

    world.prompts = [];
    await attention.refresh();
    assert.notEqual(attention.signature(), before);
  });
});

/* ------------------------------------------------------------------------------ the menu */

describe('the Needs attention section of the menu', () => {
  it('is nothing at all when nothing is pending', async () => {
    const { attention } = setup();

    await attention.refresh();

    assert.deepEqual(section(attention), []);
    assert.equal(attention.pending(), 0);
  });

  it('is a heading, then a submenu for each prompt named by its title, then a separator', async () => {
    const { attention } = setup({ prompts: [away, wrapUp] });

    await attention.refresh();
    const items = section(attention);

    assert.deepEqual(
      items.map((item) => item.label ?? item.type),
      ['Needs attention', away.title, wrapUp.title, 'separator'],
    );
    assert.deepEqual(items[0], { label: 'Needs attention', enabled: false });
    assert.deepEqual(items[3], { type: 'separator' });
  });

  it('has an item for each action of a prompt, as the server labels them, and nothing else', async () => {
    const { attention } = setup({ prompts: [away, wrapUp, idle, longBlock] });

    await attention.refresh();

    assert.deepEqual(
      submenuOf(attention, away.title).submenu.map((item) => item.label),
      ['Keep it', 'Drop 40 min'],
    );
    assert.deepEqual(
      submenuOf(attention, wrapUp.title).submenu.map((item) => item.label),
      ['Wrap up', 'Not today'],
    );
    assert.deepEqual(
      submenuOf(attention, idle.title).submenu.map((item) => item.label),
      ['Start a block', 'Not now'],
    );
    assert.deepEqual(
      submenuOf(attention, longBlock.title).submenu.map((item) => item.label),
      ['Finish block', 'Keep going'],
    );
  });

  it('cuts a long title to sixty characters with an ellipsis, and leaves a short one whole', async () => {
    const long = { ...away, id: 'away:9', title: 'A'.repeat(40) + ' ' + 'B'.repeat(80) };
    const exact = { ...away, id: 'away:10', title: 'C'.repeat(MENU_LABEL_MAX) };
    const { attention } = setup({ prompts: [long, exact, wrapUp] });

    await attention.refresh();
    const labels = section(attention).map((item) => item.label);

    assert.equal(labels[1].length, MENU_LABEL_MAX);
    assert.ok(labels[1].endsWith('…'));
    assert.ok(labels[1].startsWith('A'.repeat(40)));
    assert.equal(labels[2], 'C'.repeat(MENU_LABEL_MAX));
    assert.equal(labels[3], wrapUp.title);
  });

  it('sends an answer that the server carries out, then updates and reads the list again', async () => {
    const { world, attention, calls } = setup({ prompts: [away] });
    await attention.refresh();
    const read = world.listed;

    const drop = submenuOf(attention, away.title).submenu[1];
    world.prompts = [];
    await drop.click();

    assert.deepEqual(calls.acted, [['away:3', 'drop']]);
    assert.equal(calls.afterActions, 1, 'the clock may have moved');
    assert.equal(world.listed, read + 1, 'read again');
    assert.equal(attention.pending(), 0);
    assert.deepEqual(calls.errors, []);
  });

  it('opens the window at the route of an answer that opens a page, and sends nothing', async () => {
    const { world, attention, calls } = setup({ prompts: [wrapUp, longBlock] });
    await attention.refresh();
    const read = world.listed;

    await submenuOf(attention, wrapUp.title).submenu[0].click();
    await submenuOf(attention, longBlock.title).submenu[0].click();

    assert.deepEqual(calls.windows, ['/wrap-up', '/?finish=1']);
    assert.deepEqual(calls.acted, []);
    assert.equal(world.listed, read, 'there was nothing to read again');
  });

  it('opens the quick-switch box for the nudge, and not the window', async () => {
    const { attention, calls } = setup({ prompts: [idle] });
    await attention.refresh();

    await submenuOf(attention, idle.title).submenu[0].click();

    assert.equal(calls.palettes, 1);
    assert.deepEqual(calls.windows, []);
    assert.deepEqual(calls.acted, []);
  });

  it('sends Not now to the server like any other answer', async () => {
    const { attention, calls } = setup({ prompts: [idle] });
    await attention.refresh();

    await submenuOf(attention, idle.title).submenu[1].click();

    assert.deepEqual(calls.acted, [[idle.id, 'dismiss']]);
    assert.equal(calls.palettes, 0);
  });

  it('shows the server\'s own words when an answer is refused, and reads the list again: never a silent nothing', async () => {
    const { world, attention, calls } = setup({ prompts: [away] });
    await attention.refresh();
    const read = world.listed;
    world.answerError = Object.assign(new Error('That prompt is no longer current'), { status: 409 });
    world.prompts = [];

    await assert.doesNotReject(submenuOf(attention, away.title).submenu[0].click());

    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0], /You were away 40 min/);
    assert.match(calls.errors[0], /That prompt is no longer current/);
    assert.equal(world.listed, read + 1, 'and the prompt that is no longer there goes from the menu');
    assert.equal(attention.pending(), 0);
    assert.equal(calls.afterActions, 1);
  });

  it('shows the error when the answer cannot be sent at all', async () => {
    const { world, attention, calls } = setup({ prompts: [away] });
    await attention.refresh();
    world.answerError = new TypeError('fetch failed');

    await submenuOf(attention, away.title).submenu[1].click();

    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0], /fetch failed/);
  });

  it('is logged, and the menu still works, when even showing the error fails', async () => {
    const logs = [];
    const attention = createAttention({
      fetchPrompts: async () => [away],
      actOnPrompt: async () => {
        throw new Error('refused');
      },
      Notification: notificationClass({ supported: false }),
      getIdleSeconds: () => 0,
      isLocked: () => false,
      openWindow: () => {},
      openPalette: () => {},
      showError: () => {
        throw new Error('no dialogs either');
      },
      log: (...args) => logs.push(args),
    });
    await attention.refresh();

    await assert.doesNotReject(submenuOf(attention, away.title).submenu[0].click());

    assert.equal(logs.length, 2);
  });

  it('follows the list: a prompt that has gone is gone from the menu', async () => {
    const { world, attention } = setup({ prompts: [away, wrapUp] });
    await attention.refresh();

    world.prompts = [wrapUp];
    await attention.refresh();

    assert.deepEqual(
      section(attention).map((item) => item.label ?? item.type),
      ['Needs attention', wrapUp.title, 'separator'],
    );
  });
});

describe('trimming a label', () => {
  it('cuts at the limit with one ellipsis, and does not leave a space before it', () => {
    assert.equal(trimLabel('x'.repeat(61)), `${'x'.repeat(59)}…`);
    assert.equal(trimLabel(`${'x'.repeat(58)} yyyy`), `${'x'.repeat(58)}…`);
    assert.equal(trimLabel('short'), 'short');
    assert.equal(trimLabel('  padded  '), 'padded');
    assert.equal(trimLabel('abcdef', 4), 'abc…');
    assert.equal(trimLabel(undefined), '');
  });
});

/* ------------------------------------------------------------------- Got interrupted */

describe('Got interrupted', () => {
  const reasons = [
    { key: 'chat', label: 'Slack / chat' },
    { key: 'meeting', label: 'Meeting' },
    { key: 'person', label: 'Someone stopped by' },
    { key: 'phone', label: 'Phone call' },
    { key: 'email', label: 'Email' },
    { key: 'other', label: 'Something else' },
  ];

  it('is a submenu of every reason and No reason for a focus block', () => {
    const item = interruptedItem({ id: 4, kind: 'focus' }, reasons, () => {});

    assert.equal(item.label, 'Got interrupted');
    assert.equal(item.click, undefined, 'it opens a list, it logs nothing itself');
    assert.deepEqual(
      item.submenu.map((entry) => entry.label),
      ['Slack / chat', 'Meeting', 'Someone stopped by', 'Phone call', 'Email', 'Something else', 'No reason'],
    );
  });

  it('logs the reason that is chosen, on the block it is for, and none for No reason', async () => {
    const logged = [];
    const item = interruptedItem({ id: 4, kind: 'focus' }, reasons, (id, reason) => logged.push([id, reason]));

    for (const entry of item.submenu) await entry.click();

    assert.deepEqual(logged, [
      [4, 'chat'],
      [4, 'meeting'],
      [4, 'person'],
      [4, 'phone'],
      [4, 'email'],
      [4, 'other'],
      [4, null],
    ]);
  });

  it('is the one click it is in the window for a break: there is no reason to ask', () => {
    const logged = [];
    const item = interruptedItem({ id: 9, kind: 'break' }, reasons, (id, reason) => logged.push([id, reason]));

    assert.equal(item.label, 'Got interrupted');
    assert.equal(item.submenu, undefined);
    item.click();

    assert.deepEqual(logged, [[9, null]]);
  });

  it('hands back what logging returns, so a caller can wait for it', async () => {
    const item = interruptedItem({ id: 4, kind: 'focus' }, reasons, async () => 'logged');

    assert.equal(await item.submenu[0].click(), 'logged');
  });
});
