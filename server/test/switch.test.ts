import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { SessionRow, StartInput } from '../src/lib/sessions.js';
import { freshDb } from './setup.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const tasksMod = () => import('../src/lib/tasks.js');
const settingsMod = () => import('../src/lib/settings.js');
const acceleratorMod = () => import('../src/lib/accelerator.js');
const dbMod = () => import('../src/db.js');

const MINUTE = 60_000;

/** A clean database, with the user's day pinned to UTC and rolling over at 04:00. */
async function reset() {
  await freshDb();
  const { setSettings } = await settingsMod();
  setSettings({ timezone: 'UTC', day_start_hour: 4 });
}

/** Stop the wall clock at an instant, so a block's elapsed time and "today" are exact. */
function freeze(iso: string) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
}
const advance = (ms: number) => mock.timers.tick(ms);

async function makeProject(name: string, color = '#0ea5e9'): Promise<number> {
  const { db } = await dbMod();
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, color, now, now);
  return Number(info.lastInsertRowid);
}

/** A block's row exactly as stored, every column, and every one of its segments. */
async function storedBlock(id: number) {
  const { db } = await dbMod();
  return {
    block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow,
    segments: db.prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id').all(id),
  };
}

/** How many rows a table holds, straight from the database. */
async function countRows(table: 'sessions' | 'session_segments') {
  const { db } = await dbMod();
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** How many blocks are on the clock, running or paused: the schema allows one. */
async function liveCount() {
  const { db } = await dbMod();
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status IN ('running','paused')").get() as {
      n: number;
    }
  ).n;
}

/** The API on a loopback port of its own, so a route's validation and wiring are tested too. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text && res.headers.get('content-type')?.includes('json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (json ? JSON.parse(text) : text || undefined) as any };
  };

  return {
    call,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe('switching blocks', () => {
  let roi = 0;

  beforeEach(async () => {
    await reset();
    roi = await makeProject('ROI Dashboard');
  });
  afterEach(() => mock.timers.reset());

  it('completes the running block with its rating and starts the new one', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, switchSession, liveSessionRow } = await sessionsMod();
    const first = startSession({ title: 'Competitor teardown', projectId: roi, plannedMinutes: 45 });
    advance(30 * MINUTE);

    const { stopped, started } = switchSession({
      start: { title: 'Pricing memo', projectId: roi },
      rating: 4,
    });

    assert.ok(stopped);
    assert.equal(stopped.id, first.id);
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.focusRating, 4);
    assert.equal(stopped.elapsedSeconds, 30 * 60);
    assert.equal(stopped.endedAt, '2026-10-08T12:30:00.000Z');
    assert.equal(stopped.title, 'Competitor teardown');

    assert.equal(started.status, 'running');
    assert.equal(started.title, 'Pricing memo');
    assert.equal(started.projectId, roi);
    assert.equal(started.startedAt, '2026-10-08T12:30:00.000Z');
    assert.notEqual(started.id, first.id);

    // One block is on the clock, and it is the new one; the old one has nothing left open.
    assert.equal(await liveCount(), 1);
    assert.equal(liveSessionRow()?.id, started.id);
    const old = await storedBlock(first.id);
    assert.ok(old.segments.every((s) => (s as { ended_at: string | null }).ended_at !== null));
  });

  it('completes a paused block too, counting only the time it ran', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, pauseSession, switchSession } = await sessionsMod();
    const first = startSession({ title: 'Interrupted work' });
    advance(10 * MINUTE);
    pauseSession(first.id);
    // Paused time is not focused time, however long it goes on.
    advance(20 * MINUTE);

    const { stopped, started } = switchSession({ start: { title: 'Next thing' }, rating: 2 });

    assert.ok(stopped);
    assert.equal(stopped.id, first.id);
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.focusRating, 2);
    assert.equal(stopped.elapsedSeconds, 10 * 60);
    assert.equal(started.status, 'running');
    assert.equal(started.title, 'Next thing');
    assert.equal(await liveCount(), 1);
  });

  it('leaves the old block unrated when no rating is given, or a null one', async () => {
    const { startSession, switchSession } = await sessionsMod();
    const first = startSession({ title: 'No opinion' });
    const second = switchSession({ start: { title: 'Second' } });
    assert.equal(second.stopped?.id, first.id);
    assert.equal(second.stopped?.focusRating, null);
    const third = switchSession({ start: { title: 'Third' }, rating: null });
    assert.equal(third.stopped?.id, second.started.id);
    assert.equal(third.stopped?.focusRating, null);
    assert.equal((await storedBlock(first.id)).block.focus_rating, null);
  });

  it('starts the new block and reports nothing stopped when nothing is on the clock', async () => {
    const { switchSession, liveSessionRow } = await sessionsMod();
    assert.equal(liveSessionRow(), undefined);

    // A rating has nothing to rate, so it is ignored, not an error.
    const { stopped, started } = switchSession({ start: { title: 'First of the day' }, rating: 5 });

    assert.equal(stopped, null);
    assert.equal(started.status, 'running');
    assert.equal(started.title, 'First of the day');
    assert.equal(await liveCount(), 1);
    assert.equal(await countRows('sessions'), 1);
  });

  it("files a block started on a task under the task's project and moves the task along", async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, switchSession } = await sessionsMod();
    const { createTask, getTask } = await tasksMod();
    const task = createTask({ title: 'Competitor teardown', projectId: roi });
    assert.equal(task.status, 'not_started');
    startSession({ title: 'Something else' });
    advance(5 * MINUTE);

    const { stopped, started } = switchSession({
      start: { title: task.title, taskId: task.id },
      rating: 3,
    });

    assert.equal(stopped?.title, 'Something else');
    // The caller names no project; the task's is where the block belongs.
    assert.equal(started.taskId, task.id);
    assert.equal(started.taskTitle, 'Competitor teardown');
    assert.equal(started.projectId, roi);
    assert.equal(started.projectName, 'ROI Dashboard');
    // The same thing starting a block on a task does anywhere else.
    const after = getTask(task.id);
    assert.equal(after.status, 'in_progress');
    assert.equal(after.startDate, '2026-10-08');
    assert.equal(after.blockCount, 1);
  });

  it('starts a saved timer as the Focus screen would: its project, mode and length', async () => {
    const { startSession, switchSession } = await sessionsMod();
    startSession({ title: 'Warming up' });

    const pomodoro = switchSession({
      start: { projectId: roi, title: 'Deep work', mode: 'pomodoro', plannedMinutes: 25 },
    }).started;
    assert.equal(pomodoro.mode, 'pomodoro');
    assert.equal(pomodoro.plannedMinutes, 25);
    assert.equal(pomodoro.projectId, roi);

    const stopwatch = switchSession({
      start: { projectId: null, title: 'Reading', mode: 'stopwatch' },
    }).started;
    assert.equal(stopwatch.mode, 'stopwatch');
    assert.equal(stopwatch.plannedMinutes, null);
    assert.equal(stopwatch.projectId, null);
  });

  /**
   * A switch that cannot start its block must not have stopped the one on the clock: the
   * person is left exactly where they were, with the same block, not rated and not ended,
   * and the plan item it was started from not ticked off.
   */
  async function assertLeftAlone(start: StartInput, message: RegExp) {
    const { startSession, pauseSession, resumeSession, switchSession, liveSessionRow } =
      await sessionsMod();
    const { db } = await dbMod();
    const planned = Number(
      db
        .prepare(
          `INSERT INTO plan_items (plan_day, title, created_at, updated_at)
           VALUES ('2026-10-08', 'Planned work', 'now', 'now')`,
        )
        .run().lastInsertRowid,
    );
    const live = startSession({
      title: 'Still going',
      projectId: roi,
      plannedMinutes: 45,
      planItemId: planned,
    });
    advance(7 * MINUTE);
    pauseSession(live.id);
    advance(MINUTE);
    resumeSession(live.id);
    advance(MINUTE);

    const before = await storedBlock(live.id);
    const planBefore = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(planned);
    const blocksBefore = await countRows('sessions');
    const segmentsBefore = await countRows('session_segments');
    assert.equal(before.segments.length, 2);
    assert.equal((planBefore as { session_id: number; done: number }).session_id, live.id);

    assert.throws(() => switchSession({ start, rating: 5 }), message);

    // Every column and every segment of the block is as it was: still running, still unrated.
    const after = await storedBlock(live.id);
    assert.deepEqual(after, before);
    assert.equal(after.block.status, 'running');
    assert.equal(after.block.focus_rating, null);
    assert.equal(after.block.ended_at, null);
    assert.equal(liveSessionRow()?.id, live.id);
    // Finishing a block ticks off its plan item, and that was undone with the rest.
    assert.deepEqual(db.prepare('SELECT * FROM plan_items WHERE id = ?').get(planned), planBefore);
    assert.equal((planBefore as { done: number }).done, 0);
    // And nothing new was started.
    assert.equal(await countRows('sessions'), blocksBefore);
    assert.equal(await countRows('session_segments'), segmentsBefore);
    assert.equal(await liveCount(), 1);
  }

  it('leaves the block on the clock as it was when the task is not there, and starts nothing', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    await assertLeftAlone({ title: 'Ghost task', taskId: 999_999 }, /Unknown task/);
  });

  it('leaves the block on the clock as it was when the project is not there, and starts nothing', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    await assertLeftAlone({ title: 'Ghost project', projectId: 999_999 }, /Unknown project/);
  });

  it('leaves the block on the clock as it was when a stopwatch is given a length, and starts nothing', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    await assertLeftAlone(
      { title: 'Contradiction', mode: 'stopwatch', plannedMinutes: 25 },
      /A stopwatch has no planned length/,
    );
  });

  it('leaves the task as it was too when the start is refused', async () => {
    freeze('2026-10-08T12:00:00.000Z');
    const { startSession, switchSession } = await sessionsMod();
    const { createTask, getTask } = await tasksMod();
    const task = createTask({ title: 'Not started yet', projectId: roi });
    startSession({ title: 'Still going' });

    // The task is there but the project named for the block is not.
    assert.throws(
      () => switchSession({ start: { title: 'x', taskId: task.id, projectId: 999_999 } }),
      /Unknown project/,
    );

    const after = getTask(task.id);
    assert.equal(after.status, 'not_started');
    assert.equal(after.startDate, null);
    assert.equal(after.blockCount, 0);
  });
});

describe('switching blocks over the API', () => {
  let roi = 0;
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    roi = await makeProject('ROI Dashboard');
    api = await serve();
  });

  beforeEach(async () => {
    const { db } = await dbMod();
    db.exec('DELETE FROM session_segments; DELETE FROM sessions; DELETE FROM tasks;');
  });

  after(() => api.close());

  it('answers 201 with the block it stopped and the block it started', async () => {
    const first = (await api.call('POST', '/sessions', { title: 'Before', projectId: roi })).body;

    const res = await api.call('POST', '/sessions/switch', {
      start: { title: 'After', projectId: roi },
      rating: 4,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.stopped.id, first.id);
    assert.equal(res.body.stopped.status, 'completed');
    assert.equal(res.body.stopped.focusRating, 4);
    assert.equal(res.body.started.title, 'After');
    assert.equal(res.body.started.status, 'running');
    assert.equal(res.body.started.projectName, 'ROI Dashboard');
    const active = (await api.call('GET', '/sessions/active')).body.session;
    assert.equal(active.id, res.body.started.id);
  });

  it('answers 201 with stopped null when nothing was on the clock', async () => {
    const res = await api.call('POST', '/sessions/switch', { start: { title: 'Cold start' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.stopped, null);
    assert.equal(res.body.started.title, 'Cold start');
  });

  it('takes exactly the body that starting a block takes', async () => {
    const task = (await api.call('POST', '/tasks', { title: 'A task', projectId: roi })).body;
    const res = await api.call('POST', '/sessions/switch', {
      start: {
        taskId: task.id,
        title: 'A task',
        intent: 'see how it goes',
        mode: 'pomodoro',
        plannedMinutes: 30,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.started.taskId, task.id);
    assert.equal(res.body.started.projectId, roi);
    assert.equal(res.body.started.intent, 'see how it goes');
    assert.equal(res.body.started.mode, 'pomodoro');
    assert.equal(res.body.started.plannedMinutes, 30);
  });

  it('refuses a rating that is not a whole number from 1 to 5 with a 400, and changes nothing', async () => {
    const live = (await api.call('POST', '/sessions', { title: 'Keep me' })).body;

    for (const bad of [0, 6, -1, 2.5, '3', true]) {
      const res = await api.call('POST', '/sessions/switch', {
        start: { title: 'Never started' },
        rating: bad,
      });
      assert.equal(res.status, 400, `rating ${String(bad)}`);
      assert.equal(res.body.error, 'Invalid request');
    }

    const active = (await api.call('GET', '/sessions/active')).body.session;
    assert.equal(active.id, live.id);
    assert.equal(active.status, 'running');
    assert.equal(active.focusRating, null);
    assert.equal(await countRows('sessions'), 1);
  });

  it('refuses a body with nothing to start, or a start the schema would refuse', async () => {
    const live = (await api.call('POST', '/sessions', { title: 'Keep me' })).body;
    for (const bad of [{}, { rating: 3 }, { start: {} }, { start: { title: '   ' } }]) {
      const res = await api.call('POST', '/sessions/switch', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await api.call('GET', '/sessions/active')).body.session.id, live.id);
    assert.equal(await countRows('sessions'), 1);
  });

  it('answers 400 and leaves the block running when the start is refused', async () => {
    const live = (await api.call('POST', '/sessions', { title: 'Keep me', projectId: roi })).body;
    const before = await storedBlock(live.id);

    const unknownTask = await api.call('POST', '/sessions/switch', {
      start: { title: 'Ghost', taskId: 999_999 },
      rating: 5,
    });
    assert.equal(unknownTask.status, 400);
    assert.equal(unknownTask.body.error, 'Unknown task');

    const unknownProject = await api.call('POST', '/sessions/switch', {
      start: { title: 'Ghost', projectId: 999_999 },
      rating: 5,
    });
    assert.equal(unknownProject.status, 400);
    assert.equal(unknownProject.body.error, 'Unknown project');

    const contradiction = await api.call('POST', '/sessions/switch', {
      start: { title: 'Both', mode: 'stopwatch', plannedMinutes: 25 },
      rating: 5,
    });
    assert.equal(contradiction.status, 400);
    assert.match(contradiction.body.error, /stopwatch has no planned length/);

    assert.deepEqual(await storedBlock(live.id), before);
    assert.equal(await countRows('sessions'), 1);
  });
});

describe('normalizeAccelerator', () => {
  it('accepts good combinations and spells them one way', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    const cases: [string, string][] = [
      // Already canonical, so unchanged: the shipped default among them.
      ['CommandOrControl+Shift+K', 'CommandOrControl+Shift+K'],
      ['Control+Alt+Space', 'Control+Alt+Space'],
      // Case does not matter.
      ['commandorcontrol+shift+k', 'CommandOrControl+Shift+K'],
      ['COMMAND+SHIFT+SPACE', 'Command+Shift+Space'],
      // Short names become the long ones.
      ['CmdOrCtrl+Shift+K', 'CommandOrControl+Shift+K'],
      ['cmd+shift+k', 'Command+Shift+K'],
      ['ctrl+alt+f5', 'Control+Alt+F5'],
      ['meta+esc', 'Super+Escape'],
      ['Ctrl+Return', 'Control+Enter'],
      // Option is the Mac name for Alt and is kept.
      ['option+space', 'Option+Space'],
      // Every kind of key.
      ['Alt+0', 'Alt+0'],
      ['Alt+z', 'Alt+Z'],
      ['Ctrl+F1', 'Control+F1'],
      ['Ctrl+f24', 'Control+F24'],
      ['Ctrl+Tab', 'Control+Tab'],
      ['Ctrl+Backspace', 'Control+Backspace'],
      ['Ctrl+Delete', 'Control+Delete'],
      ['Ctrl+Insert', 'Control+Insert'],
      ['Ctrl+up', 'Control+Up'],
      ['Ctrl+Down', 'Control+Down'],
      ['Ctrl+LEFT', 'Control+Left'],
      ['Ctrl+Right', 'Control+Right'],
      ['Ctrl+Home', 'Control+Home'],
      ['Ctrl+End', 'Control+End'],
      ['Ctrl+pageup', 'Control+PageUp'],
      ['Ctrl+PageDown', 'Control+PageDown'],
      ['Ctrl+plus', 'Control+Plus'],
      // Any number of modifiers, in the order they were typed.
      ['Shift+Ctrl+Alt+Cmd+K', 'Shift+Control+Alt+Command+K'],
      // Space around a plus is only a way of typing it.
      ['  cmd + shift + k ', 'Command+Shift+K'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeAccelerator(input), expected, input);
    }
  });

  it('rejects what Electron would quietly misread, and what is not a shortcut', async () => {
    const { normalizeAccelerator } = await acceleratorMod();
    const rejected = [
      // A name Electron does not know is dropped, so this would register plain A.
      'Foo+A',
      'Cmd+Fo+A',
      'Cmmd+Shift+K',
      // Two keys.
      'A+B',
      'Cmd+A+B',
      'Cmd+Space+K',
      // No modifier: a bare key would be taken from every app.
      'K',
      'F5',
      'Space',
      // No key.
      'Cmd+Shift',
      'Cmd',
      'Shift+',
      // A modifier twice, by whatever name.
      'Cmd+Cmd+K',
      'Cmd+Command+K',
      'Ctrl+Control+K',
      'Alt+Option+K',
      'Shift+shift+K',
      'Meta+Super+K',
      // CommandOrControl is the Command key or Control, so it repeats either.
      'CmdOrCtrl+Cmd+K',
      'CmdOrCtrl+Ctrl+K',
      // Command and Super are the same key on a Mac.
      'Cmd+Super+K',
      // Not empty, not blank.
      '',
      '   ',
      '+',
      'Cmd++',
      'Cmd+Shift++',
      '++K',
      // Keys that are not on the list.
      'Cmd+F0',
      'Cmd+F25',
      'Cmd+F01',
      'Cmd+KK',
      'Cmd+10',
      'Cmd+,',
      'Cmd+;',
      'Cmd+Numpad1',
      'Cmd+CapsLock',
      // Modifiers that are not on the list.
      'AltGr+K',
      'Hyper+K',
      'Win+K',
    ];
    for (const input of rejected) {
      assert.equal(normalizeAccelerator(input), null, JSON.stringify(input));
    }
  });

  it('is exported from the server entry, which is what the desktop app imports', async () => {
    const entry = await import('../src/app.js');
    const { normalizeAccelerator } = await acceleratorMod();
    assert.equal(entry.normalizeAccelerator, normalizeAccelerator);
    assert.equal(entry.normalizeAccelerator('cmdorctrl+shift+k'), 'CommandOrControl+Shift+K');
  });
});

describe('the quick_switch_hotkey setting', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await reset();
    api = await serve();
  });

  beforeEach(async () => {
    // Each case starts from the shipped default, whatever the one before it saved.
    const { db } = await dbMod();
    db.exec("DELETE FROM settings WHERE key = 'quick_switch_hotkey'");
  });

  after(() => api.close());

  it('is on by default, as Command+Shift+K on a Mac', async () => {
    const res = await api.call('GET', '/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.quick_switch_hotkey, 'CommandOrControl+Shift+K');
  });

  it('accepts an empty string, which turns the shortcut off', async () => {
    const res = await api.call('PATCH', '/settings', { quick_switch_hotkey: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.quick_switch_hotkey, '');
    // And it stays off: an empty value is a choice, not a missing one that falls back to the default.
    assert.equal((await api.call('GET', '/settings')).body.quick_switch_hotkey, '');
    const { getSetting } = await settingsMod();
    assert.equal(getSetting('quick_switch_hotkey'), '');
  });

  it('treats a blank string as off too', async () => {
    const res = await api.call('PATCH', '/settings', { quick_switch_hotkey: '   ' });
    assert.equal(res.status, 200);
    assert.equal(res.body.quick_switch_hotkey, '');
  });

  it('stores a good combination in its canonical spelling', async () => {
    const res = await api.call('PATCH', '/settings', { quick_switch_hotkey: 'cmdorctrl+alt+space' });
    assert.equal(res.status, 200);
    assert.equal(res.body.quick_switch_hotkey, 'CommandOrControl+Alt+Space');
    assert.equal((await api.call('GET', '/settings')).body.quick_switch_hotkey, 'CommandOrControl+Alt+Space');
  });

  it('rejects junk with a 400 that says what to type, and keeps the shortcut it had', async () => {
    assert.equal(
      (await api.call('PATCH', '/settings', { quick_switch_hotkey: 'Control+Alt+J' })).status,
      200,
    );
    for (const junk of ['Foo+A', 'K', 'Cmd+Shift', 'A+B', 'Cmd+Cmd+K', 'hello world', 'Cmd+Shift+Ж']) {
      const res = await api.call('PATCH', '/settings', { quick_switch_hotkey: junk });
      assert.equal(res.status, 400, junk);
      assert.equal(res.body.error, 'Invalid request');
      assert.match(res.body.details.fieldErrors.quick_switch_hotkey[0], /CommandOrControl\+Shift\+K/);
    }
    assert.equal((await api.call('GET', '/settings')).body.quick_switch_hotkey, 'Control+Alt+J');
  });

  it('rejects a value that is not a string, and refuses the whole patch when one key is bad', async () => {
    for (const bad of [null, 5, true, ['Cmd+K']]) {
      assert.equal(
        (await api.call('PATCH', '/settings', { quick_switch_hotkey: bad })).status,
        400,
        JSON.stringify(bad),
      );
    }
    // The other settings in the same request are not applied either.
    const before = (await api.call('GET', '/settings')).body.focus_minutes;
    const res = await api.call('PATCH', '/settings', {
      focus_minutes: 99,
      quick_switch_hotkey: 'nope',
    });
    assert.equal(res.status, 400);
    assert.equal((await api.call('GET', '/settings')).body.focus_minutes, before);
  });

  it('leaves it alone when a patch is about other settings, as the Timer card sends them', async () => {
    await api.call('PATCH', '/settings', { quick_switch_hotkey: 'Control+Alt+J' });
    // The settings screen saves every setting it loaded, this one included, unchanged.
    const loaded = (await api.call('GET', '/settings')).body;
    const res = await api.call('PATCH', '/settings', { ...loaded, focus_minutes: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.body.quick_switch_hotkey, 'Control+Alt+J');
    assert.equal(res.body.focus_minutes, '50');
    await api.call('PATCH', '/settings', { focus_minutes: 45 });
  });
});
