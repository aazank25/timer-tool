import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import Database from 'better-sqlite3';
import type { Prompt, PromptProvider } from '../src/lib/prompts.js';
import type { StartInput } from '../src/lib/sessions.js';
import {
  addEvent,
  advance,
  at,
  awayPromptId,
  type Api,
  DAY,
  failOnLoggedErrors,
  freeze,
  goTo,
  makeProject,
  MINUTE,
  reset,
  serve,
  startPromptId,
} from './prompt-helpers.js';

const sessionsMod = () => import('../src/lib/sessions.js');
const promptsMod = () => import('../src/lib/prompts.js');
const meetingsMod = () => import('../src/lib/meetings.js');
const settingsMod = () => import('../src/lib/settings.js');
const dbMod = () => import('../src/db.js');

/** Start a stopwatch block on the frozen clock. */
async function startBlock(title = 'Deep work', rest: Partial<StartInput> = {}) {
  const { startSession } = await sessionsMod();
  return startSession({ title, ...rest });
}

const ids = (prompts: Prompt[]) => prompts.map((p) => p.id);
const actionIds = (prompt: Prompt | undefined) => prompt?.actions.map((a) => a.id);

async function listed() {
  const { listPrompts } = await promptsMod();
  return listPrompts();
}

async function savedState(key: string) {
  const { db } = await dbMod();
  const row = db.prepare('SELECT status, data FROM prompt_state WHERE key = ?').get(key) as
    | { status: string; data: string | null }
    | undefined;
  return row && { status: row.status, data: row.data ? JSON.parse(row.data) : null };
}

async function sessionRows(where = '1 = 1') {
  const { db } = await dbMod();
  return db.prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY id`).all() as {
    id: number;
    title: string;
    project_id: number | null;
    kind: string;
    status: string;
    started_at: string;
    ended_at: string | null;
    active_seconds: number;
    calendar_event_id: string | null;
  }[];
}

/* ------------------------------------------------------------------- engine */

describe('the prompt engine', () => {
  let api: Api;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(reset);
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });

  /** One away prompt on a running block, the simplest thing to act on. */
  async function awayPrompt() {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const res = await api.call('POST', `/sessions/${block.id}/away`, {
      startedAt: at('10:10'),
      endedAt: at('10:50'),
    });
    return { block, id: await awayPromptId(res.body.away.id) };
  }

  it('lists nothing when nothing needs your attention', async () => {
    const res = await api.call('GET', '/prompts');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('lists every kind together, oldest first, whatever order the kinds are kept in', async () => {
    freeze(at('08:00'));
    const block = await startBlock('Deep work');
    // The meeting that has just ended, which began before the block did so that some of it is
    // not on the block, and the one that has just started.
    await addEvent({ title: 'Workshop', start: at('07:00'), end: at('10:10') });
    await addEvent({ title: 'Roadmap review', start: at('10:20'), end: at('11:20') });
    goTo(at('10:30'));
    await api.call('POST', `/sessions/${block.id}/away`, {
      startedAt: at('09:00'),
      endedAt: at('09:30'),
    });
    goTo(at('10:35'));

    const prompts = (await api.call('GET', '/prompts')).body as Prompt[];

    // Away (due 10:30) is kept first and long-block (due 10:00) is kept second, so a list in
    // the order the kinds are held in would be away, long-block, start, end.
    assert.deepEqual(
      prompts.map((p) => [p.kind, p.createdAt]),
      [
        ['long-block', at('10:00')],
        ['meeting-end', at('10:10')],
        ['meeting-start', at('10:20')],
        ['away', at('10:30')],
      ],
    );
  });

  it('puts prompts that fell due together in order of their ids', async () => {
    const { registerPromptProvider, listPrompts } = await promptsMod();
    const make = (id: string): Prompt => ({
      id,
      kind: 'twin',
      title: id,
      body: 'Both at once.',
      createdAt: at('12:00'),
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
    });
    const unregister = registerPromptProvider({
      kind: 'twin',
      list: () => [make('twin:b'), make('twin:a')],
      act: () => {},
    });
    try {
      assert.deepEqual(ids(listPrompts()), ['twin:a', 'twin:b']);
    } finally {
      unregister();
    }
  });

  it('orders by the instant a prompt fell due, however its time is written', async () => {
    const { registerPromptProvider, listPrompts } = await promptsMod();
    const make = (id: string, createdAt: string): Prompt => ({
      id,
      kind: 'clock',
      title: id,
      body: 'Written differently.',
      createdAt,
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
    });
    const unregister = registerPromptProvider({
      kind: 'clock',
      // Compared as text, ".500Z" would come before "00Z", which is half a second late.
      list: () => [
        make('clock:late', '2026-10-12T12:00:00.500Z'),
        make('clock:early', '2026-10-12T12:00:00Z'),
        make('clock:offset', '2026-10-12T14:00:00.250+02:00'),
      ],
      act: () => {},
    });
    try {
      assert.deepEqual(ids(listPrompts()), ['clock:early', 'clock:offset', 'clock:late']);
    } finally {
      unregister();
    }
  });

  it('lists and answers a kind registered later like the built-in ones', async () => {
    const { registerPromptProvider, listPrompts } = await promptsMod();
    const answered: [string, string][] = [];
    const provider: PromptProvider = {
      kind: 'wrap-up',
      list: () => [
        {
          id: 'wrap-up:2026-10-12',
          kind: 'wrap-up',
          title: 'Wrap up the day?',
          body: 'Five blocks logged.',
          createdAt: at('17:00'),
          actions: [{ id: 'dismiss', label: 'Dismiss' }],
        },
      ],
      act: (id, action) => answered.push([id, action]),
    };
    const unregister = registerPromptProvider(provider);
    try {
      assert.deepEqual(ids(listPrompts()), ['wrap-up:2026-10-12']);
      assert.throws(() => registerPromptProvider(provider), /already registered/);

      const res = await act('wrap-up:2026-10-12', 'dismiss');
      assert.equal(res.status, 200);
      assert.deepEqual(answered, [['wrap-up:2026-10-12', 'dismiss']]);
    } finally {
      unregister();
    }
    assert.deepEqual(listPrompts(), []);
    assert.equal((await act('wrap-up:2026-10-12', 'dismiss')).status, 409);
  });

  it('answers 409 to a prompt that is not there, whatever the action', async () => {
    for (const id of ['away:999', 'long-block:1:1', 'meeting-start:nothing', 'nonsense']) {
      for (const action of ['keep', 'dismiss', 'bogus']) {
        const res = await act(id, action);
        assert.equal(res.status, 409, `${id} / ${action}`);
        assert.equal(res.body.error, 'That prompt is no longer current');
      }
    }
  });

  it('answers 400 to an action the prompt does not offer, and changes nothing', async () => {
    const { id } = await awayPrompt();

    for (const action of ['bogus', 'dismiss', 'pause', 'Keep']) {
      assert.equal((await act(id, action)).status, 400, action);
    }

    assert.deepEqual(ids((await api.call('GET', '/prompts')).body), [id]);
  });

  it('answers 400 to an action that only opens a page, which the app carries out itself', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('12:00'));
    const [prompt] = await listed();
    assert.deepEqual(
      prompt?.actions.find((a) => a.id === 'finish'),
      { id: 'finish', label: 'Finish block', open: `/?finish=${block.id}` },
    );

    const res = await act(prompt!.id, 'finish');

    assert.equal(res.status, 400);
    assert.deepEqual(ids(await listed()), [prompt!.id]);
    assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'running');
  });

  it('refuses a request that is not an id and an action', async () => {
    for (const body of [
      {},
      { id: 'away:1' },
      { action: 'keep' },
      { id: '', action: 'keep' },
      { id: 5, action: 'keep' },
    ]) {
      assert.equal(
        (await api.call('POST', '/prompts/act', body)).status,
        400,
        JSON.stringify(body),
      );
    }
  });

  it('hands back the list as it stands after the answer', async () => {
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('11:00'));
    const away = async (from: string, to: string) =>
      awayPromptId(
        (
          await api.call('POST', `/sessions/${block.id}/away`, {
            startedAt: at(from),
            endedAt: at(to),
          })
        ).body.away.id,
      );
    const first = await away('10:10', '10:20');
    const second = await away('10:30', '10:40');

    const res = await act(first, 'keep');

    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body.prompts), [second]);
    assert.deepEqual(res.body.prompts, (await api.call('GET', '/prompts')).body);
  });

  it('keeps listing the rest when one kind of prompt fails', async () => {
    const { registerPromptProvider, listPrompts } = await promptsMod();
    const { id } = await awayPrompt();
    const unregister = registerPromptProvider({
      kind: 'broken',
      list: () => {
        throw new Error('this kind is broken');
      },
      act: () => {},
    });
    const quiet = mock.method(console, 'error', () => {});
    try {
      assert.deepEqual(ids(listPrompts()), [id]);
      assert.equal(quiet.mock.callCount(), 1);
    } finally {
      quiet.mock.restore();
      unregister();
    }
  });

  it('leaves nothing changed when an answer fails partway', async () => {
    const { registerPromptProvider } = await promptsMod();
    const { db } = await dbMod();
    const unregister = registerPromptProvider({
      kind: 'flaky',
      list: () => [
        {
          id: 'flaky:1',
          kind: 'flaky',
          title: 'Flaky',
          body: 'It writes, then fails.',
          createdAt: at('12:00'),
          actions: [{ id: 'try', label: 'Try' }],
        },
      ],
      act: (id) => {
        db.prepare("INSERT INTO prompt_state (key, status, updated_at) VALUES (?, 'done', ?)").run(
          id,
          at('12:00'),
        );
        throw new Error('then it fails');
      },
    });
    const quiet = mock.method(console, 'error', () => {});
    try {
      const res = await act('flaky:1', 'try');
      assert.equal(res.status, 500);
    } finally {
      quiet.mock.restore();
      unregister();
    }
    assert.equal(await savedState('flaky:1'), undefined);
  });

  it('never carries out an action that only opens a page, even for a provider that would accept it', async () => {
    const { registerPromptProvider } = await promptsMod();
    const answered: string[] = [];
    const unregister = registerPromptProvider({
      kind: 'opener',
      list: () => [
        {
          id: 'opener:1',
          kind: 'opener',
          title: 'Open it',
          body: 'It has a page of its own.',
          createdAt: at('12:00'),
          actions: [
            { id: 'go', label: 'Go', open: '/somewhere' },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        },
      ],
      // Takes whatever it is given, so it is the engine that has to say no.
      act: (_id, action) => void answered.push(action),
    });
    try {
      const res = await act('opener:1', 'go');

      assert.equal(res.status, 400);
      assert.deepEqual(answered, []);
      // The other action is carried out, so the provider is wired up and it is only this one.
      assert.equal((await act('opener:1', 'dismiss')).status, 200);
      assert.deepEqual(answered, ['dismiss']);
    } finally {
      unregister();
    }
  });

  it('answers 409 to an action its kind gives but the prompt does not, and 400 to one the kind never gives', async () => {
    const { registerPromptProvider } = await promptsMod();
    const answered: string[] = [];
    const prompt = (actions: string[]): Prompt => ({
      id: 'two-step:1',
      kind: 'two-step',
      title: 'Two steps',
      body: 'Offers what is left to do.',
      createdAt: at('12:00'),
      actions: actions.map((id) => ({ id, label: id })),
    });
    let offered = ['first', 'second'];
    const unregister = registerPromptProvider({
      kind: 'two-step',
      actionIds: ['first', 'second'],
      list: () => [prompt(offered)],
      act: (_id, action) => void answered.push(action),
    });
    try {
      // The first step has been done since the banner was drawn.
      offered = ['second'];

      const stale = await act('two-step:1', 'first');
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, 'That prompt is no longer current');
      assert.equal((await act('two-step:1', 'third')).status, 400);
      assert.deepEqual(answered, []);
      assert.equal((await act('two-step:1', 'second')).status, 200);
    } finally {
      unregister();
    }
  });

  it('answers 400 to every action it does not offer when its kind does not say what it gives', async () => {
    const { registerPromptProvider } = await promptsMod();
    const unregister = registerPromptProvider({
      kind: 'silent',
      list: () => [
        {
          id: 'silent:1',
          kind: 'silent',
          title: 'Silent',
          body: 'Says nothing of what it can give.',
          createdAt: at('12:00'),
          actions: [{ id: 'ok', label: 'Ok' }],
        },
      ],
      act: () => {},
    });
    try {
      assert.equal((await act('silent:1', 'other')).status, 400);
    } finally {
      unregister();
    }
  });

  /**
   * How many statements `work` runs against the database, counted as they run. A list that
   * asks the database once for every prompt shows as a count that grows with the list.
   */
  async function statementsRun(work: () => void): Promise<number> {
    const { db } = await dbMod();
    const prepare = db.prepare.bind(db);
    let ran = 0;
    const counting = mock.method(
      db as unknown as { prepare: (sql: string) => unknown },
      'prepare',
      (sql: string) => {
        const statement = prepare(sql) as unknown as Record<string, unknown>;
        return new Proxy(statement, {
          get(target, key) {
            const value = target[key as string];
            if (typeof value !== 'function') return value;
            const counts = key === 'all' || key === 'get' || key === 'run' || key === 'iterate';
            return (...args: unknown[]) => {
              if (counts) ran++;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
      },
    );
    try {
      work();
    } finally {
      counting.mock.restore();
    }
    return ran;
  }

  it('reads what it needs once for the whole list, however many stretches there are to ask about', async () => {
    const { db } = await dbMod();
    const { listPrompts } = await promptsMod();
    freeze(at('10:00'));
    const block = await startBlock();
    goTo(at('16:00'));
    // A block of many runs, so that reading them over again for every stretch would show.
    db.prepare('DELETE FROM session_segments WHERE session_id = ?').run(block.id);
    const run = db.prepare(
      'INSERT INTO session_segments (session_id, started_at, ended_at) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 20; i++) {
      const from = Date.parse(at('10:00')) + i * 10 * MINUTE;
      run.run(block.id, new Date(from).toISOString(), new Date(from + 8 * MINUTE).toISOString());
    }
    run.run(block.id, at('13:20'), null);
    const stretches = db.prepare(
      'INSERT INTO away_intervals (session_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?)',
    );
    let made = 0;
    const addStretches = (n: number) => {
      for (const end = made + n; made < end; made++) {
        const from = Date.parse(at('10:00')) + made * 4 * MINUTE;
        stretches.run(
          block.id,
          new Date(from).toISOString(),
          new Date(from + 2 * MINUTE).toISOString(),
          at('15:00'),
        );
      }
    };
    const statementsFor = async (n: number) => {
      addStretches(n);
      return statementsRun(() => {
        assert.equal(listPrompts().filter((p) => p.kind === 'away').length, made);
      });
    };

    const few = await statementsFor(3);
    const many = await statementsFor(57);

    assert.equal(made, 60);
    assert.equal(many, few);
  });

  it('reads what it needs once for the whole list, however many meetings there are to ask about', async () => {
    const { db } = await dbMod();
    const { listPrompts } = await promptsMod();
    freeze(at('15:00'));
    // A block that was running before the meetings, which are all over by now.
    const block = await startBlock();
    goTo(at('15:10'));
    (await sessionsMod()).pauseSession(block.id);
    goTo(at('16:00'));
    const insert = db.prepare(
      `INSERT INTO calendar_events (id, provider, calendar_id, title, starts_at, ends_at, all_day, local_day, synced_at)
       VALUES (?, 'ics:test', 'Test', ?, ?, ?, 0, ?, ?)`,
    );
    let made = 0;
    const addMeetings = (n: number) => {
      for (const end = made + n; made < end; made++) {
        const to = Date.parse(at('15:05')) + (made % 50) * MINUTE;
        const [from, finished] = [
          new Date(to - 20 * MINUTE).toISOString(),
          new Date(to).toISOString(),
        ];
        insert.run(
          `ics:test:meeting-${made}:${from}`,
          `Meeting ${made}`,
          from,
          finished,
          DAY,
          from,
        );
      }
    };
    const statementsFor = async (n: number) => {
      addMeetings(n);
      return statementsRun(() => {
        assert.equal(listPrompts().filter((p) => p.kind === 'meeting-end').length, made);
      });
    };

    const few = await statementsFor(3);
    const many = await statementsFor(47);

    assert.equal(made, 50);
    assert.equal(many, few);
  });
});

/* -------------------------------------------------------------- long blocks */

describe('the long-block prompt', () => {
  let api: Api;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    // Two hours, as it ships; said here so the numbers below read on their own.
    (await settingsMod()).setSettings({ long_block_minutes: 120 });
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });

  it('appears when the running block reaches the threshold, and not before', async () => {
    freeze(at('08:00'));
    // An earlier block, so that the one asked about is not number 1 and a page that was
    // told a fixed number would show.
    const { stopSession } = await sessionsMod();
    stopSession((await startBlock('Earlier')).id, 'completed');
    const block = await startBlock('Deep work');
    assert.notEqual(block.id, 1);

    goTo(at('09:59:59'));
    assert.deepEqual(await listed(), []);

    goTo(at('10:00'));
    const [prompt, ...others] = await listed();
    assert.equal(others.length, 0);
    assert.deepEqual(prompt, {
      id: `long-block:${block.id}:1`,
      kind: 'long-block',
      title: 'Still on “Deep work”?',
      body: 'You have worked 2 h on this block.',
      createdAt: at('10:00'),
      actions: [
        // The page is told which block it is about.
        { id: 'finish', label: 'Finish block', open: `/?finish=${block.id}` },
        { id: 'keep-going', label: 'Keep going' },
      ],
    });
  });

  it('says how long it has been in the body as the block goes on', async () => {
    freeze(at('08:00'));
    await startBlock();
    goTo(at('10:35'));

    assert.equal((await listed())[0]?.body, 'You have worked 2 h 35 min on this block.');
  });

  it('is hidden by Keep going until the block reaches the next multiple', async () => {
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('10:00'));
    const res = await act(`long-block:${block.id}:1`, 'keep-going');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { prompts: [] });
    assert.equal((await savedState(`long-block:${block.id}:1`))?.status, 'dismissed');

    goTo(at('11:59:59'));
    assert.deepEqual(await listed(), []);

    // Dismissing it at two hours asks again at four.
    goTo(at('12:00'));
    const [again] = await listed();
    assert.equal(again?.id, `long-block:${block.id}:2`);
    assert.equal(again?.createdAt, at('12:00'));
    assert.equal(again?.body, 'You have worked 4 h on this block.');
  });

  it('asks only for the latest multiple when several have gone by unanswered', async () => {
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('14:10'));

    const prompts = await listed();

    // Six hours in: one banner, for the third multiple, and not three.
    assert.deepEqual(ids(prompts), [`long-block:${block.id}:3`]);
    assert.equal(prompts[0]?.createdAt, at('14:00'));
  });

  it('is off when the setting is 0', async () => {
    const { setSettings } = await settingsMod();
    freeze(at('08:00'));
    await startBlock();
    goTo(at('13:00'));
    assert.equal((await listed()).length, 1);

    setSettings({ long_block_minutes: 0 });

    assert.deepEqual(await listed(), []);
  });

  it('follows the setting: a shorter threshold asks sooner', async () => {
    const { setSettings } = await settingsMod();
    setSettings({ long_block_minutes: 45 });
    freeze(at('08:00'));
    await startBlock();

    goTo(at('08:44'));
    assert.deepEqual(await listed(), []);
    goTo(at('08:45'));
    assert.equal((await listed())[0]?.createdAt, at('08:45'));
  });

  it('does not ask about a paused block, and asks again when it runs on', async () => {
    const { pauseSession, resumeSession } = await sessionsMod();
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('10:30'));
    assert.equal((await listed()).length, 1);

    pauseSession(block.id);
    assert.deepEqual(await listed(), []);
    goTo(at('13:00'));
    assert.deepEqual(await listed(), []);

    resumeSession(block.id);
    assert.deepEqual(ids(await listed()), [`long-block:${block.id}:1`]);
  });

  it('counts the time worked and not the time since the block began', async () => {
    const { pauseSession, resumeSession } = await sessionsMod();
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('09:00'));
    pauseSession(block.id);
    // Three hours paused, which is not worked.
    goTo(at('12:00'));
    resumeSession(block.id);

    goTo(at('12:59:59'));
    assert.deepEqual(await listed(), []);
    goTo(at('13:00'));
    const [prompt] = await listed();
    assert.equal(prompt?.id, `long-block:${block.id}:1`);
    // Two hours worked, an hour of it before the pause and an hour after: due at 13:00.
    assert.equal(prompt?.createdAt, at('13:00'));
  });

  it('asks about a focus block only, never a break', async () => {
    freeze(at('08:00'));
    await startBlock('Long rest', { kind: 'break', mode: 'stopwatch' } as Partial<StartInput>);
    goTo(at('11:00'));

    assert.deepEqual(await listed(), []);
  });

  it('goes away when the block is finished', async () => {
    const { stopSession } = await sessionsMod();
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('10:30'));
    assert.equal((await listed()).length, 1);

    stopSession(block.id, 'completed');

    assert.deepEqual(await listed(), []);
  });

  it('takes the answer to an earlier block that had the same id as no answer for this one', async () => {
    const { db } = await dbMod();
    freeze(at('08:00'));
    const first = await startBlock('First');
    goTo(at('10:00'));
    await act(`long-block:${first.id}:1`, 'keep-going');
    assert.deepEqual(await listed(), []);

    // The newest block is deleted, so the next one is given its id again.
    db.prepare('DELETE FROM sessions WHERE id = ?').run(first.id);
    const second = await startBlock('Second');
    assert.equal(second.id, first.id);
    goTo(at('12:00'));

    assert.deepEqual(ids(await listed()), [`long-block:${second.id}:1`]);
  });

  it('takes Keep going at a multiple to cover every multiple below it, so dropping time does not ask again', async () => {
    // This one runs into the evening of a work day with focus time on it, when the end-of-day
    // reminder would join the list: it is not what is being tested, so it is switched off.
    const { setSettings } = await import('../src/lib/settings.js');
    setSettings({ wrapup_time: '' });
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('14:10'));
    // Six hours worked: the third multiple, kept going at.
    assert.deepEqual(ids(await listed()), [`long-block:${block.id}:3`]);
    await act(`long-block:${block.id}:3`, 'keep-going');
    assert.deepEqual(await listed(), []);

    // Two hours and five minutes of it were the person being away, and are dropped: the block
    // has worked four hours and five minutes, which is the second multiple.
    const away = await api.call('POST', `/sessions/${block.id}/away`, {
      startedAt: at('10:00'),
      endedAt: at('12:05'),
    });
    const dropped = await act(await awayPromptId(away.body.away.id), 'drop');
    assert.equal(dropped.status, 200);
    const { toView, getSessionRow } = await sessionsMod();
    assert.equal(toView(getSessionRow(block.id)).elapsedSeconds, 4 * 3600 + 5 * 60);

    // It had been told to keep going at the third, so it is not asked at the second.
    assert.deepEqual(await listed(), []);
    goTo(at('17:59:59'));
    assert.deepEqual(await listed(), []);

    // Eight hours worked is the fourth multiple, which nobody has answered.
    goTo(at('18:05'));
    const [again] = await listed();
    assert.equal(again?.id, `long-block:${block.id}:4`);
    assert.equal(again?.createdAt, at('18:05'));
  });

  it('does not take Keep going at a multiple to cover the ones above it', async () => {
    freeze(at('08:00'));
    const block = await startBlock();
    goTo(at('10:00'));
    await act(`long-block:${block.id}:1`, 'keep-going');
    goTo(at('13:00'));

    // Dismissed at two hours, and asked again at four and at six: the third multiple is new.
    assert.deepEqual(ids(await listed()), [`long-block:${block.id}:2`]);
    goTo(at('14:00'));
    assert.deepEqual(ids(await listed()), [`long-block:${block.id}:3`]);
  });
});

/* ----------------------------------------------------------------- meetings */

describe('meeting prompts', () => {
  let api: Api;
  let alpha = 0;
  failOnLoggedErrors();

  before(async () => {
    api = await serve();
  });
  beforeEach(async () => {
    await reset();
    alpha = await makeProject('Alpha');
    // Nothing here is about long blocks, and one would only get in the way.
    (await settingsMod()).setSettings({ long_block_minutes: 0 });
  });
  afterEach(() => mock.timers.reset());
  after(() => api.close());

  const act = (id: string, action: string) => api.call('POST', '/prompts/act', { id, action });
  const get = async () => (await api.call('GET', '/prompts')).body as Prompt[];

  /** The Roadmap review, 14:00-14:45 under Alpha, and a block running since 13:30. */
  async function reviewAndBlock(opts: { project?: boolean } = {}) {
    freeze(at('13:30'));
    const block = await startBlock('Deep work');
    const event = await addEvent({
      title: 'Roadmap review',
      start: at('14:00'),
      end: at('14:45'),
      projectId: opts.project === false ? null : alpha,
    });
    return { block, event };
  }

  /**
   * The Roadmap review with nothing ticking through it: the block that was running since
   * 13:30 is paused, by hand, before it begins. It is still the block on the clock, but it
   * was not paused for the meeting, so there is nothing to pick back up afterwards.
   */
  async function reviewAfterPausing() {
    const { pauseSession } = await sessionsMod();
    const { block, event } = await reviewAndBlock();
    goTo(at('13:59'));
    pauseSession(block.id);
    return { block, event };
  }

  describe('when a meeting starts', () => {
    it('offers to pause the running block', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));

      const [prompt, ...others] = await get();

      assert.equal(others.length, 0);
      assert.deepEqual(prompt, {
        id: startPromptId(event, block.id),
        kind: 'meeting-start',
        title: 'Roadmap review has started',
        body: 'Pause “Deep work” for it?',
        createdAt: at('14:00'),
        actions: [
          { id: 'pause', label: 'Pause block', primary: true },
          { id: 'dismiss', label: 'Dismiss' },
        ],
      });
    });

    it('asks from the start of the meeting to fifteen minutes in, and not outside that', async () => {
      await reviewAndBlock();

      goTo(at('13:59:59'));
      assert.deepEqual(await get(), []);
      goTo(at('14:00'));
      assert.equal((await get()).length, 1);
      goTo(at('14:15'));
      assert.equal((await get()).length, 1);
      goTo(at('14:15:01'));
      assert.deepEqual(await get(), []);
    });

    it('does not ask about a meeting that is already over', async () => {
      freeze(at('13:30'));
      const block = await startBlock();
      await addEvent({ title: 'Quick sync', start: at('14:00'), end: at('14:10') });

      goTo(at('14:09:59'));
      assert.deepEqual(ids(await get()), [
        startPromptId(`ics:test:Quick sync:${at('14:00')}`, block.id),
      ]);
      // Over: nothing to pause for now, and none of it to log either, as the block ran all through it.
      goTo(at('14:10'));
      assert.deepEqual(await get(), []);
    });

    it('needs a focus block that is running', async () => {
      const { pauseSession, resumeSession, stopSession } = await sessionsMod();
      freeze(at('13:30'));
      await addEvent({ title: 'Roadmap review', start: at('14:00'), end: at('14:45') });
      goTo(at('14:02'));
      assert.deepEqual(await get(), [], 'nothing running');

      const rest = await startBlock('Stretch', { kind: 'break' });
      assert.deepEqual(await get(), [], 'a break');
      stopSession(rest.id, 'completed');

      const block = await startBlock('Deep work');
      assert.equal((await get()).length, 1);
      pauseSession(block.id);
      assert.deepEqual(await get(), [], 'paused');
      resumeSession(block.id);
      assert.equal((await get()).length, 1);
    });

    it('does not ask about a block that is the time spent on that very meeting', async () => {
      freeze(at('13:30'));
      const event = await addEvent({
        title: 'Roadmap review',
        start: at('14:00'),
        end: at('14:45'),
      });
      await startBlock('Taking notes', { calendarEventId: event });

      goTo(at('14:02'));

      assert.deepEqual(await get(), []);
    });

    it('is due when the clock started running, if that was after the meeting began', async () => {
      const { pauseSession, resumeSession } = await sessionsMod();
      freeze(at('13:30'));
      const block = await startBlock();
      await addEvent({ title: 'Roadmap review', start: at('14:00'), end: at('14:45') });
      goTo(at('14:01'));
      pauseSession(block.id);
      goTo(at('14:06'));
      resumeSession(block.id);
      goTo(at('14:07'));

      assert.equal((await get())[0]?.createdAt, at('14:06'));
    });

    it('pauses the live block on Pause, and writes down which block it was', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));

      const res = await act(startPromptId(event, block.id), 'pause');

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { prompts: [] });
      const live = (await api.call('GET', '/sessions/active')).body.session;
      assert.equal(live.id, block.id);
      assert.equal(live.status, 'paused');
      // 14:02 less 13:30: the time before the pause is kept.
      assert.equal(live.elapsedSeconds, 32 * 60);
      const note = await savedState(`meeting-start:${event}`);
      assert.equal(note?.status, 'done');
      assert.equal(note?.data.sessionId, block.id);
    });

    it('is hidden for good by Dismiss, and leaves the block running', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));

      const res = await act(startPromptId(event, block.id), 'dismiss');

      assert.deepEqual(res.body, { prompts: [] });
      assert.equal((await savedState(`meeting-start:${event}`))?.status, 'dismissed');
      assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'running');
      // Not asked again a minute later either.
      advance(MINUTE);
      assert.deepEqual(await get(), []);
    });

    it('asks about two meetings that start together on their own, and pausing for one answers both', async () => {
      freeze(at('13:30'));
      const block = await startBlock('Deep work');
      const a = await addEvent({ title: 'Design crit', start: at('14:00'), end: at('14:30') });
      const b = await addEvent({ title: 'Pipeline review', start: at('14:00'), end: at('14:30') });
      goTo(at('14:02'));
      assert.deepEqual(
        ids(await get()),
        [startPromptId(a, block.id), startPromptId(b, block.id)].sort(),
      );

      await act(startPromptId(a, block.id), 'pause');

      // The block is paused, so nothing is left to ask for the other.
      assert.deepEqual(await get(), []);

      goTo(at('14:35'));
      const [first, second] = await get();
      // Only the one it was paused for knows to offer the block back.
      const forA = [first, second].find((p) => p?.id === `meeting-end:${a}`);
      const forB = [first, second].find((p) => p?.id === `meeting-end:${b}`);
      assert.deepEqual(actionIds(forA), ['log-resume', 'log', 'resume', 'dismiss']);
      assert.deepEqual(actionIds(forB), ['log', 'dismiss']);
    });

    it('ignores all-day events, and does nothing when meeting prompts are off', async () => {
      const { setSettings } = await settingsMod();
      freeze(at('13:30'));
      await startBlock();
      await addEvent({ title: 'Offsite', start: at('13:55'), end: at('18:00'), allDay: true });
      goTo(at('14:02'));
      assert.deepEqual(await get(), []);

      await addEvent({ title: 'Roadmap review', start: at('14:00'), end: at('14:45') });
      assert.equal((await get()).length, 1);
      setSettings({ meeting_prompts: false });
      assert.deepEqual(await get(), []);
      setSettings({ meeting_prompts: true });
      assert.equal((await get()).length, 1);
    });

    it('does not pause a different block than the one the question named', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:01'));
      const [shown] = await get();
      assert.equal(shown?.id, startPromptId(event, block.id));
      assert.equal(shown?.body, 'Pause “Deep work” for it?');
      // The block is swapped for another while the banner is still on screen.
      const switched = await api.call('POST', '/sessions/switch', {
        start: { title: 'Second block' },
      });
      assert.equal(switched.status, 201);

      const res = await act(shown!.id, 'pause');

      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'That prompt is no longer current');
      const live = (await api.call('GET', '/sessions/active')).body.session;
      assert.equal(live.title, 'Second block');
      assert.equal(live.status, 'running');
      assert.equal(await savedState(`meeting-start:${event}`), undefined);
      // The meeting asks again, about the block that is on the clock now and under its own id.
      const [now] = await get();
      assert.equal(now?.id, startPromptId(event, switched.body.started.id));
      assert.equal(now?.body, 'Pause “Second block” for it?');
    });

    it('keeps what was said about a meeting for the meeting, whichever block is on the clock', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:01'));
      await act(startPromptId(event, block.id), 'dismiss');

      await api.call('POST', '/sessions/switch', { start: { title: 'Second block' } });

      assert.deepEqual(await get(), []);
      assert.equal((await savedState(`meeting-start:${event}`))?.status, 'dismissed');
    });

    it('refuses, in the provider itself, to pause a block other than the one the id names', async () => {
      const { meetingStartProvider } = await meetingsMod();
      const { block, event } = await reviewAndBlock();
      goTo(at('14:01'));

      for (const id of [
        startPromptId(event, block.id + 1),
        `meeting-start:${event}`,
        `meeting-start:${event}:`,
        `meeting-start:${event}:x`,
        'meeting-start:',
        'meeting-start:x',
      ]) {
        assert.throws(() => meetingStartProvider.act(id, 'pause', new Date()), { status: 409 }, id);
      }

      assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'running');
      assert.equal(await savedState(`meeting-start:${event}`), undefined);
    });
  });

  describe('when a meeting ends', () => {
    it('offers to log a meeting that has no time on it', async () => {
      const { event } = await reviewAfterPausing();
      goTo(at('14:46'));

      // The block on the clock was not paused for it, so there is nothing to resume.
      const prompts = await get();
      const end = prompts.find((p) => p.kind === 'meeting-end');

      assert.deepEqual(end, {
        id: `meeting-end:${event}`,
        kind: 'meeting-end',
        title: 'Roadmap review is over',
        body: 'Log the 45m as time spent?',
        createdAt: at('14:45'),
        actions: [
          { id: 'log', label: 'Log 45m under Alpha', primary: true },
          { id: 'dismiss', label: 'Dismiss' },
        ],
      });
    });

    it('asks from the moment it ends for an hour, and not outside that', async () => {
      await reviewAfterPausing();

      goTo(at('14:44:59'));
      assert.deepEqual(
        (await get()).map((p) => p.kind),
        [],
      );
      goTo(at('14:45'));
      assert.deepEqual(
        (await get()).map((p) => p.kind),
        ['meeting-end'],
      );
      goTo(at('15:45'));
      assert.equal((await get()).length, 1);
      goTo(at('15:45:01'));
      assert.deepEqual(await get(), []);
    });

    it('offers to resume the block it paused, and to log the meeting and resume it in one', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));

      const [prompt, ...others] = await get();

      assert.equal(others.length, 0);
      assert.equal(prompt?.id, `meeting-end:${event}`);
      // The block ticked through the first two minutes of the meeting, so they are on it already.
      assert.equal(prompt?.body, 'Log the 43m and resume “Deep work”?');
      assert.deepEqual(prompt?.actions, [
        { id: 'log-resume', label: 'Log 43m and resume', primary: true },
        { id: 'log', label: 'Log 43m under Alpha' },
        { id: 'resume', label: 'Resume' },
        { id: 'dismiss', label: 'Dismiss' },
      ]);
    });

    it('logs the meeting as a finished focus block over its scheduled time, linked to it', async () => {
      const { block, event } = await reviewAfterPausing();
      goTo(at('14:46'));

      const res = await act(`meeting-end:${event}`, 'log');

      assert.equal(res.status, 200);
      const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
      assert.equal(logged?.title, 'Roadmap review');
      assert.equal(logged?.project_id, alpha);
      assert.equal(logged?.kind, 'focus');
      assert.equal(logged?.status, 'completed');
      assert.equal(logged?.started_at, at('14:00'));
      assert.equal(logged?.ended_at, at('14:45'));
      assert.equal(logged?.active_seconds, 45 * 60);
      assert.equal(logged?.calendar_event_id, event);
      // The meeting now shows it, and the block on the clock is untouched.
      const events = (await api.call('GET', '/calendar/events?day=2026-10-12')).body;
      assert.equal(events[0].loggedSeconds, 45 * 60);
      const [untouched] = await sessionRows(`id = ${block.id}`);
      assert.equal(untouched?.status, 'paused');
      assert.equal(untouched?.active_seconds, 29 * 60);
      assert.deepEqual(res.body, { prompts: [] });
    });

    it('does not log a meeting twice', async () => {
      const { event } = await reviewAfterPausing();
      const { meetingEndProvider } = await meetingsMod();
      goTo(at('14:46'));
      await act(`meeting-end:${event}`, 'log');
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 1);

      // Asked to log it again, through the app...
      assert.equal((await act(`meeting-end:${event}`, 'log')).status, 409);
      // ...and by a caller that did not look first.
      meetingEndProvider.act(`meeting-end:${event}`, 'log', new Date());
      meetingEndProvider.act(`meeting-end:${event}`, 'log-resume', new Date());
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 1);

      // Not even when the block that was logged has been made shorter since, so that some of
      // the meeting is on no block: it is logged, and that is all that is asked.
      const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
      await api.call('PATCH', `/sessions/${logged!.id}`, { activeSeconds: 10 * 60 });
      meetingEndProvider.act(`meeting-end:${event}`, 'log', new Date());
      meetingEndProvider.act(`meeting-end:${event}`, 'log-resume', new Date());
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 1);
    });

    it('does not ask to log a meeting that was logged by hand', async () => {
      const { event } = await reviewAfterPausing();
      goTo(at('14:46'));
      assert.equal((await get()).length, 1);

      const manual = await api.call('POST', '/sessions/manual', {
        title: 'Roadmap review',
        startedAt: at('14:00'),
        minutes: 45,
        calendarEventId: event,
      });
      assert.equal(manual.status, 201);

      assert.deepEqual(await get(), []);
    });

    it('does not count a discarded block as the meeting being logged', async () => {
      const { stopSession } = await sessionsMod();
      freeze(at('13:30'));
      const event = await addEvent({
        title: 'Roadmap review',
        start: at('14:00'),
        end: at('14:45'),
      });
      const notes = await startBlock('Taking notes', { calendarEventId: event });
      goTo(at('14:30'));
      stopSession(notes.id, 'abandoned');
      goTo(at('14:46'));

      // Not a minute of it was ticked through by the block that was thrown away.
      const [prompt] = await get();
      assert.deepEqual(actionIds(prompt), ['log', 'dismiss']);
      assert.equal(prompt?.body, 'Log the 45m as time spent?');
    });

    it('logs and resumes in one answer', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));

      const res = await act(`meeting-end:${event}`, 'log-resume');

      assert.deepEqual(res.body, { prompts: [] });
      const live = (await api.call('GET', '/sessions/active')).body.session;
      assert.equal(live.status, 'running');
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 1);
      assert.equal((await savedState(`meeting-end:${event}`))?.status, 'done');
    });

    it('leaves the question of logging when only Resume is chosen', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));

      const res = await act(`meeting-end:${event}`, 'resume');

      assert.equal((await api.call('GET', '/sessions/active')).body.session.status, 'running');
      const [prompt] = res.body.prompts as Prompt[];
      assert.equal(prompt?.body, 'Log the 43m as time spent?');
      assert.deepEqual(prompt?.actions, [
        { id: 'log', label: 'Log 43m under Alpha', primary: true },
        { id: 'dismiss', label: 'Dismiss' },
      ]);
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 0);
    });

    it('leaves the question of resuming when only Log is chosen, until it is resumed', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));

      const logged = await act(`meeting-end:${event}`, 'log');

      const [prompt] = logged.body.prompts as Prompt[];
      assert.equal(prompt?.body, 'Resume “Deep work”?');
      assert.deepEqual(prompt?.actions, [
        { id: 'resume', label: 'Resume', primary: true },
        { id: 'dismiss', label: 'Dismiss' },
      ]);
      assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'paused');

      const resumed = await act(`meeting-end:${event}`, 'resume');

      assert.deepEqual(resumed.body, { prompts: [] });
      assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'running');
      assert.equal((await savedState(`meeting-end:${event}`))?.status, 'done');
    });

    it('is gone for good once it is dismissed, with the block left paused', async () => {
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));

      const res = await act(`meeting-end:${event}`, 'dismiss');

      assert.deepEqual(res.body, { prompts: [] });
      assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'paused');
      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 0);
      advance(10 * MINUTE);
      assert.deepEqual(await get(), []);
    });

    it('does not stay once the logged meeting is deleted on purpose', async () => {
      const { event } = await reviewAfterPausing();
      goTo(at('14:46'));
      await act(`meeting-end:${event}`, 'log');
      const { db } = await dbMod();

      db.prepare('DELETE FROM sessions WHERE calendar_event_id = ?').run(event);

      assert.deepEqual(await get(), []);
    });

    it('stops offering to resume a block that was resumed or stopped since', async () => {
      const { resumeSession, stopSession } = await sessionsMod();
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:20'));
      resumeSession(block.id);
      goTo(at('14:46'));
      // Back on the clock already, so only the logging is left to ask about.
      assert.deepEqual(actionIds((await get())[0]), ['log', 'dismiss']);

      stopSession(block.id, 'completed');
      assert.deepEqual(actionIds((await get())[0]), ['log', 'dismiss']);
    });

    it('does not offer the block back after another block has taken its id', async () => {
      const { pauseSession } = await sessionsMod();
      const { db } = await dbMod();
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      // The paused block is thrown away and the next is given its id, and is itself paused.
      db.prepare('DELETE FROM sessions WHERE id = ?').run(block.id);
      goTo(at('14:10'));
      const next = await startBlock('Something else');
      assert.equal(next.id, block.id);
      pauseSession(next.id);
      goTo(at('14:46'));

      assert.deepEqual(actionIds((await get())[0]), ['log', 'dismiss']);
    });

    it('names no project when the meeting has none, and takes its length from the schedule', async () => {
      freeze(at('13:30'));
      const noProject = await addEvent({ title: 'Coffee', start: at('13:00'), end: at('13:20') });
      const long = await addEvent({ title: 'Workshop', start: at('11:30'), end: at('13:00') });
      goTo(at('13:30'));

      const prompts = await get();
      const labels = Object.fromEntries(
        prompts.map((p) => [p.id, p.actions.find((a) => a.id === 'log')?.label]),
      );

      assert.equal(labels[`meeting-end:${noProject}`], 'Log 20m');
      assert.equal(labels[`meeting-end:${long}`], 'Log 1h 30m');
    });

    it('logs a meeting at no more than twelve hours, and no less than a minute', async () => {
      freeze(at('13:30'));
      const marathon = await addEvent({
        title: 'Marathon',
        start: '2026-10-11T22:00:00.000Z',
        end: at('13:00'),
      });
      const blip = await addEvent({ title: 'Blip', start: at('13:10'), end: at('13:10:20') });
      goTo(at('13:30'));

      const labels = Object.fromEntries(
        (await get()).map((p) => [p.id, p.actions.find((a) => a.id === 'log')?.label]),
      );
      assert.equal(labels[`meeting-end:${marathon}`], 'Log 12h');
      assert.equal(labels[`meeting-end:${blip}`], 'Log 1m');

      await act(`meeting-end:${marathon}`, 'log');
      assert.equal(
        (await sessionRows('calendar_event_id IS NOT NULL'))[0]?.active_seconds,
        12 * 3600,
      );
    });

    it('ignores all-day events, and does nothing when meeting prompts are off', async () => {
      const { setSettings } = await settingsMod();
      freeze(at('13:30'));
      await addEvent({ title: 'Offsite', start: at('12:00'), end: at('13:00'), allDay: true });
      assert.deepEqual(await get(), []);

      await addEvent({ title: 'Roadmap review', start: at('12:00'), end: at('13:00') });
      assert.equal((await get()).length, 1);
      setSettings({ meeting_prompts: false });
      assert.deepEqual(await get(), []);
    });

    it('is left alone while the meeting is going on, and for a meeting not yet begun', async () => {
      freeze(at('13:30'));
      await addEvent({ title: 'Roadmap review', start: at('13:00'), end: at('14:00') });
      await addEvent({ title: 'Later', start: at('15:00'), end: at('16:00') });

      assert.deepEqual(await get(), []);
    });

    it('goes with the meeting when the sync removes it, and fails cleanly if it is gone mid-answer', async () => {
      const { event } = await reviewAfterPausing();
      goTo(at('14:46'));
      const { db } = await dbMod();
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(event);

      assert.deepEqual(await get(), []);
      assert.equal((await act(`meeting-end:${event}`, 'log')).status, 409);
    });

    it('answers 409, and does nothing, to an answer the prompt offered a moment ago and no longer does', async () => {
      const { resumeSession } = await sessionsMod();
      const { block, event } = await reviewAndBlock();
      goTo(at('14:02'));
      await act(startPromptId(event, block.id), 'pause');
      goTo(at('14:46'));
      assert.deepEqual(actionIds((await get())[0]), ['log-resume', 'log', 'resume', 'dismiss']);
      // The block is picked back up by hand while the question is on screen.
      resumeSession(block.id);
      assert.deepEqual(actionIds((await get())[0]), ['log', 'dismiss']);

      for (const action of ['resume', 'log-resume']) {
        const res = await act(`meeting-end:${event}`, action);
        assert.equal(res.status, 409, action);
        assert.equal(res.body.error, 'That prompt is no longer current');
      }

      assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 0);
      // An answer this kind of prompt never gives is a mistake in the request, not a stale one.
      for (const action of ['keep', 'pause', 'bogus']) {
        assert.equal((await act(`meeting-end:${event}`, action)).status, 400, action);
      }
      assert.deepEqual(actionIds((await get())[0]), ['log', 'dismiss']);
    });

    describe('when blocks already hold some of its time', () => {
      /** The Review, 14:00-14:30, and a block running since 13:30. */
      async function reviewAndBlockShort() {
        freeze(at('13:30'));
        const block = await startBlock('Deep work');
        const event = await addEvent({ title: 'Review', start: at('14:00'), end: at('14:30') });
        return { block, event };
      }

      it('logs only the time after the block was paused, from the moment it was paused', async () => {
        const { block, event } = await reviewAndBlockShort();
        goTo(at('14:14'));
        await act(startPromptId(event, block.id), 'pause');
        goTo(at('14:31'));

        const [prompt] = await get();
        // Fourteen of its thirty minutes are on the block already.
        assert.equal(prompt?.body, 'Log the 16m and resume “Deep work”?');
        assert.deepEqual(
          prompt?.actions.map((a) => a.label),
          ['Log 16m and resume', 'Log 16m', 'Resume', 'Dismiss'],
        );

        const res = await act(`meeting-end:${event}`, 'log-resume');

        assert.equal(res.status, 200);
        const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
        assert.equal(logged?.title, 'Review');
        assert.equal(logged?.status, 'completed');
        assert.equal(logged?.started_at, at('14:14'));
        assert.equal(logged?.ended_at, at('14:30'));
        assert.equal(logged?.active_seconds, 16 * 60);
        assert.equal((await sessionsMod()).getSessionRow(block.id).status, 'running');
      });

      it('never counts a minute twice, whatever the block does afterwards', async () => {
        const { stopSession } = await sessionsMod();
        const { block, event } = await reviewAndBlockShort();
        goTo(at('14:14'));
        await act(startPromptId(event, block.id), 'pause');
        goTo(at('14:31'));
        await act(`meeting-end:${event}`, 'log-resume');
        goTo(at('15:00'));
        stopSession(block.id, 'completed');

        const rows = await sessionRows();
        // From 13:30 to 15:00 is ninety minutes, and one of them (14:30 to 14:31) nobody worked.
        assert.equal(
          rows.reduce((sum, r) => sum + r.active_seconds, 0),
          89 * 60,
        );
      });

      it('counts a block that was logged by hand with a time that carries an offset', async () => {
        freeze(at('13:30'));
        const event = await addEvent({ title: 'Review', start: at('14:00'), end: at('14:30') });
        // 16:00 to 16:30 in a zone two hours ahead is 14:00 to 14:30, the meeting exactly,
        // logged before it begins.
        const logged = await api.call('POST', '/sessions/manual', {
          title: 'Taking notes',
          startedAt: '2026-10-12T16:00:00+02:00',
          minutes: 30,
        });
        assert.equal(logged.status, 201);
        goTo(at('14:31'));

        // All of it is on that block, so there is nothing to log.
        assert.deepEqual(await get(), []);
        assert.equal((await act(`meeting-end:${event}`, 'log')).status, 409);
      });

      it('does not count a break as time on the meeting', async () => {
        freeze(at('13:30'));
        await startBlock('Long rest', { kind: 'break' });
        const event = await addEvent({ title: 'Review', start: at('14:00'), end: at('14:30') });
        goTo(at('14:31'));

        // The break ran all through it, and is not focus time: the meeting is still all to log.
        const [prompt] = await get();
        assert.equal(prompt?.id, `meeting-end:${event}`);
        assert.equal(prompt?.body, 'Log the 30m as time spent?');
      });

      it('offers nothing to log when the block ran all through the meeting, and refuses to log it', async () => {
        const { block, event } = await reviewAndBlockShort();
        goTo(at('14:01'));
        await act(startPromptId(event, block.id), 'dismiss');
        goTo(at('14:31'));

        // Everything it scheduled is on the block already.
        assert.deepEqual(await get(), []);
        assert.equal((await act(`meeting-end:${event}`, 'log')).status, 409);
        assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 0);
      });

      it('logs only the time before a block that began partway through the meeting', async () => {
        freeze(at('13:30'));
        const event = await addEvent({ title: 'Review', start: at('14:00'), end: at('14:30') });
        goTo(at('14:10'));
        await startBlock('Deep work');
        goTo(at('14:31'));

        const [prompt] = await get();
        assert.equal(prompt?.body, 'Log the 10m as time spent?');
        assert.deepEqual(actionIds(prompt), ['log', 'dismiss']);

        await act(`meeting-end:${event}`, 'log');

        const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
        assert.equal(logged?.started_at, at('14:00'));
        assert.equal(logged?.ended_at, at('14:10'));
        assert.equal(logged?.active_seconds, 10 * 60);
      });

      it('leaves out the time before and after a block that ran through the middle of it', async () => {
        const { pauseSession, resumeSession } = await sessionsMod();
        freeze(at('13:30'));
        const event = await addEvent({ title: 'Review', start: at('14:00'), end: at('14:30') });
        const block = await startBlock('Deep work');
        goTo(at('14:05'));
        pauseSession(block.id);
        goTo(at('14:10'));
        resumeSession(block.id);
        goTo(at('14:20'));
        pauseSession(block.id);
        goTo(at('14:31'));

        // The block held 14:00-14:05 and 14:10-14:20, which leaves five and ten minutes.
        const [prompt] = await get();
        assert.equal(prompt?.body, 'Log the 15m as time spent?');
        await act(`meeting-end:${event}`, 'log');
        const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
        // From the first minute that nobody worked, for as long as there is of them.
        assert.equal(logged?.started_at, at('14:05'));
        assert.equal(logged?.active_seconds, 15 * 60);
      });

      it('offers only to resume when less than a minute of it is left, and takes exactly a minute', async () => {
        const { block, event } = await reviewAndBlockShortMeeting();
        // 14:00-14:10, and the block is paused 59.999 seconds before the end.
        goTo(new Date(Date.parse(at('14:09:00')) + 1).toISOString());
        await act(startPromptId(event, block.id), 'pause');
        goTo(at('14:11'));

        const [prompt] = await get();
        assert.equal(prompt?.body, 'Resume “Deep work”?');
        assert.deepEqual(actionIds(prompt), ['resume', 'dismiss']);
        // The log is not on offer, so it is out of date to ask for it, and nothing is logged.
        assert.equal((await act(`meeting-end:${event}`, 'log')).status, 409);
        assert.equal((await act(`meeting-end:${event}`, 'log-resume')).status, 409);
        assert.equal((await sessionRows('calendar_event_id IS NOT NULL')).length, 0);
        // The block can still be picked back up, and the question is gone with it.
        const resumed = await act(`meeting-end:${event}`, 'resume');
        assert.deepEqual(resumed.body, { prompts: [] });
      });

      it('offers to log exactly a minute of it', async () => {
        const { block, event } = await reviewAndBlockShortMeeting();
        goTo(at('14:09'));
        await act(startPromptId(event, block.id), 'pause');
        goTo(at('14:11'));

        const [prompt] = await get();

        assert.equal(prompt?.body, 'Log the 1m and resume “Deep work”?');
        await act(`meeting-end:${event}`, 'log');
        const [logged] = await sessionRows('calendar_event_id IS NOT NULL');
        assert.equal(logged?.started_at, at('14:09'));
        assert.equal(logged?.active_seconds, 60);
      });

      /** The Standup, 14:00-14:10, and a block running since 13:30. */
      async function reviewAndBlockShortMeeting() {
        freeze(at('13:30'));
        const block = await startBlock('Deep work');
        const event = await addEvent({ title: 'Standup', start: at('14:00'), end: at('14:10') });
        return { block, event };
      }

      it('counts the time another meeting logged, when two meetings overlap', async () => {
        freeze(at('09:00'));
        const first = await addEvent({ title: 'First', start: at('10:00'), end: at('10:30') });
        const second = await addEvent({ title: 'Second', start: at('10:10'), end: at('10:40') });
        goTo(at('10:31'));
        await act(`meeting-end:${first}`, 'log');
        goTo(at('10:41'));

        const [prompt] = await get();
        // Twenty of its thirty minutes are in the first meeting, which was logged.
        assert.equal(prompt?.id, `meeting-end:${second}`);
        assert.equal(prompt?.body, 'Log the 10m as time spent?');
        await act(prompt!.id, 'log');

        const logged = await sessionRows('calendar_event_id IS NOT NULL');
        assert.deepEqual(
          logged.map((r) => [r.title, r.started_at, r.ended_at, r.active_seconds]),
          [
            ['First', at('10:00'), at('10:30'), 30 * 60],
            ['Second', at('10:30'), at('10:40'), 10 * 60],
          ],
        );
      });
    });

    it('asks about every meeting however many there are, and leaves out the ones that were dismissed or logged', async () => {
      const { db } = await dbMod();
      freeze(at('16:00'));
      const insert = db.prepare(
        `INSERT INTO calendar_events (id, provider, calendar_id, title, starts_at, ends_at, all_day, local_day, synced_at)
         VALUES (?, 'ics:test', 'Test', ?, ?, ?, 0, ?, ?)`,
      );
      const ids: string[] = [];
      for (let i = 0; i < 1100; i++) {
        const end = Date.parse(at('15:05')) + (i % 50) * MINUTE;
        const from = new Date(end - 20 * MINUTE).toISOString();
        const id = `ics:test:meeting-${i}:${from}`;
        insert.run(id, `Meeting ${i}`, from, new Date(end).toISOString(), DAY, from);
        ids.push(id);
      }
      // Ones from the far end of the list, past every batch the database is asked in.
      const dismissed = [ids[505]!, ids[1020]!];
      const logged = [ids[510]!, ids[1030]!];
      for (const id of dismissed) {
        db.prepare(
          "INSERT INTO prompt_state (key, status, updated_at) VALUES (?, 'dismissed', ?)",
        ).run(`meeting-end:${id}`, at('15:30'));
      }
      for (const id of logged) {
        db.prepare(
          `INSERT INTO sessions (title, kind, planned_minutes, started_at, ended_at, local_day,
             active_seconds, status, calendar_event_id, created_at, updated_at)
           VALUES ('Logged', 'focus', 20, ?, ?, ?, 1200, 'completed', ?, ?, ?)`,
        ).run(at('15:00'), at('15:20'), DAY, id, at('15:20'), at('15:20'));
      }

      const asked = (await get()).filter((p) => p.kind === 'meeting-end');

      assert.equal(asked.length, 1100 - 4);
      const askedIds = new Set(asked.map((p) => p.id));
      for (const id of [...dismissed, ...logged]) assert.ok(!askedIds.has(`meeting-end:${id}`), id);
    });

    it('answers and logs a meeting whose id is long', async () => {
      freeze(at('13:30'));
      // A UID of 1,400 characters, and one that makes the id as long as an id can be.
      const long = await addEvent({
        title: 'Long uid',
        id: `ics:cal_x:${'u'.repeat(1400)}:${at('13:00')}`,
        start: at('13:00'),
        end: at('13:20'),
      });
      const longest = await addEvent({
        title: 'Longest uid',
        id: `ics:cal_x:${'v'.repeat(2000 - 'ics:cal_x::'.length - at('13:00').length)}:${at('13:00')}`,
        start: at('13:00'),
        end: at('13:20'),
      });
      assert.equal(longest.length, 2000);
      const shown = await get();
      assert.ok(shown.some((p) => p.id === `meeting-end:${long}` && p.id.length > 1000));

      // Answered from the prompt, which carries the whole id...
      assert.equal((await act(`meeting-end:${longest}`, 'dismiss')).status, 200);
      // ...and logged by hand, which carries it as well.
      const manual = await api.call('POST', '/sessions/manual', {
        title: 'Long uid',
        startedAt: at('13:00'),
        minutes: 20,
        calendarEventId: long,
      });
      assert.equal(manual.status, 201);
      assert.equal(manual.body.calendarEventId, long);
      assert.deepEqual(
        (await get()).map((p) => p.id),
        [],
      );
    });
  });
});

/* ----------------------------------------------------------------- settings */

describe('the settings these features add', () => {
  let api: Api;

  before(async () => {
    api = await serve();
  });
  beforeEach(reset);
  after(() => api.close());

  const KEYS = [
    'away_minutes',
    'long_block_minutes',
    'meeting_prompts',
    'work_days',
    'work_start',
    'work_end',
    'nudge_minutes',
  ] as const;
  const patch = (body: unknown) => api.call('PATCH', '/settings', body);
  const all = async () => (await api.call('GET', '/settings')).body as Record<string, string>;

  it('ship with these defaults', async () => {
    const settings = await all();
    assert.deepEqual(Object.fromEntries(KEYS.map((k) => [k, settings[k]])), {
      away_minutes: '10',
      long_block_minutes: '120',
      meeting_prompts: 'true',
      work_days: '1,2,3,4,5',
      work_start: '09:00',
      work_end: '18:00',
      nudge_minutes: '15',
    });
  });

  it('take whole minutes from 0 (off) up to their ceilings, as numbers or as strings', async () => {
    const ceilings = { away_minutes: 240, long_block_minutes: 720, nudge_minutes: 240 };
    for (const [key, max] of Object.entries(ceilings)) {
      for (const [sent, stored] of [
        [0, '0'],
        [1, '1'],
        [max, String(max)],
        [String(Math.floor(max / 2)), String(Math.floor(max / 2))],
      ] as const) {
        const res = await patch({ [key]: sent });
        assert.equal(res.status, 200, `${key} = ${sent}`);
        assert.equal(res.body[key], stored);
        assert.equal((await all())[key], stored);
      }
    }
  });

  it('refuse minutes that are negative, past the ceiling, fractional, empty or not numbers', async () => {
    const ceilings = { away_minutes: 240, long_block_minutes: 720, nudge_minutes: 240 };
    for (const [key, max] of Object.entries(ceilings)) {
      const before = await all();
      for (const bad of [
        -1,
        max + 1,
        1.5,
        'abc',
        '',
        ' ',
        null,
        true,
        [5],
        { n: 5 },
        '1.5',
        '-5',
      ]) {
        assert.equal((await patch({ [key]: bad })).status, 400, `${key} = ${JSON.stringify(bad)}`);
      }
      assert.deepEqual(await all(), before, `${key} was written`);
    }
  });

  it('say meeting prompts on or off, as a boolean or the words', async () => {
    for (const [sent, stored] of [
      [false, 'false'],
      [true, 'true'],
      ['false', 'false'],
      ['true', 'true'],
    ] as const) {
      const res = await patch({ meeting_prompts: sent });
      assert.equal(res.status, 200);
      assert.equal(res.body.meeting_prompts, stored);
    }
    for (const bad of ['yes', 'on', 1, 0, null, 'TRUE', '']) {
      assert.equal((await patch({ meeting_prompts: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await all()).meeting_prompts, 'true');
  });

  it('take work days as distinct ISO weekdays, one to seven, or none at all', async () => {
    for (const good of ['', '1', '5,1', '1,2,3,4,5,6,7', '6,7']) {
      const res = await patch({ work_days: good });
      assert.equal(res.status, 200, JSON.stringify(good));
      assert.equal(res.body.work_days, good);
    }
    for (const bad of [
      '0',
      '8',
      '1,1',
      '1,,2',
      ',1',
      '1,',
      'a',
      'mon',
      ' 1',
      '1, 2',
      '12',
      '1;2',
      1,
      [1, 2],
      null,
    ]) {
      assert.equal((await patch({ work_days: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await all()).work_days, '6,7');
  });

  it('take work hours as HH:MM on a 24-hour clock', async () => {
    for (const [key, value] of [
      ['work_start', '00:00'],
      ['work_start', '08:30'],
      ['work_end', '23:59'],
      ['work_end', '17:45'],
    ] as const) {
      const res = await patch({ [key]: value });
      assert.equal(res.status, 200, `${key} = ${value}`);
      assert.equal(res.body[key], value);
    }
    for (const bad of [
      '9:00',
      '24:00',
      '09:60',
      '0900',
      '09:00:00',
      'noon',
      '',
      '9',
      '09.00',
      900,
      null,
    ]) {
      for (const key of ['work_start', 'work_end']) {
        assert.equal((await patch({ [key]: bad })).status, 400, `${key} = ${JSON.stringify(bad)}`);
      }
    }
  });

  it('refuse work hours that do not end after they start', async () => {
    const equal = await patch({ work_start: '10:00', work_end: '10:00' });
    assert.equal(equal.status, 400);
    assert.equal(equal.body.error, 'Work hours must end after they start');
    assert.equal((await patch({ work_start: '18:00', work_end: '09:00' })).status, 400);

    const ok = await patch({ work_start: '07:30', work_end: '16:00' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.work_start, '07:30');
    assert.equal(ok.body.work_end, '16:00');
  });

  it('judge a change to one of the work hours against the other as stored', async () => {
    // 09:00 to 18:00 as it ships.
    assert.equal((await patch({ work_end: '08:00' })).status, 400);
    assert.equal((await patch({ work_end: '09:00' })).status, 400);
    assert.equal((await patch({ work_start: '18:00' })).status, 400);
    assert.equal((await patch({ work_start: '19:00' })).status, 400);
    const after = await all();
    assert.equal(after.work_start, '09:00');
    assert.equal(after.work_end, '18:00');

    assert.equal((await patch({ work_end: '09:01' })).status, 200);
    assert.equal((await patch({ work_start: '09:00' })).status, 200);
    assert.equal((await patch({ work_start: '00:00' })).status, 200);
  });

  it('write nothing from a request that is refused, whichever key is at fault', async () => {
    const before = await all();

    assert.equal((await patch({ away_minutes: 30, work_days: '9' })).status, 400);
    assert.equal(
      (await patch({ away_minutes: 30, nudge_minutes: 30, work_end: '08:00' })).status,
      400,
    );
    assert.equal((await patch({ meeting_prompts: false, long_block_minutes: 721 })).status, 400);

    assert.deepEqual(await all(), before);
  });

  it('are accepted together with the older keys, and leave unnamed ones alone', async () => {
    const res = await patch({ focus_minutes: 30, away_minutes: 20, work_days: '1,3,5' });

    assert.equal(res.status, 200);
    assert.equal(res.body.focus_minutes, '30');
    assert.equal(res.body.away_minutes, '20');
    assert.equal(res.body.work_days, '1,3,5');
    assert.equal(res.body.nudge_minutes, '15');
    assert.equal(res.body.long_block_minutes, '120');
  });

  it('survive a save of the whole settings page, which sends every key back as text', async () => {
    const everything = await all();

    const res = await patch(everything);

    assert.equal(res.status, 200);
    assert.deepEqual(await all(), everything);
  });
});

/* ------------------------------------------------------ migration 8, on disk */

describe('migration 8 on an existing database', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-prompts-'));
    dirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds the two tables beside what was there, with their constraints, and backs up first', async () => {
    const { migrations, runMigrations } = await dbMod();
    const dir = scratch();
    const file = path.join(dir, 'focusdesk.sqlite');
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    try {
      // The database as it stood before this migration: every earlier one applied.
      const stamp = '2026-10-12T10:00:00.000Z';
      conn.exec(`CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      for (const m of migrations.filter((m) => m.id < 8)) {
        conn.exec(m.up);
        conn
          .prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(m.id, m.name, stamp);
      }
      conn
        .prepare(
          `INSERT INTO sessions (id, title, planned_minutes, started_at, ended_at, local_day,
             active_seconds, status, created_at, updated_at)
           VALUES (7, 'Old block', 45, ?, ?, '2026-10-12', 2700, 'completed', ?, ?)`,
        )
        .run(stamp, '2026-10-12T10:45:00.000Z', stamp, stamp);

      runMigrations(conn, file);

      const applied = conn.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as {
        id: number;
        name: string;
      }[];
      assert.deepEqual(
        applied,
        migrations.map((m) => ({ id: m.id, name: m.name })),
      );
      assert.equal(applied.at(-1)?.name, 'prompts');
      assert.equal(
        (conn.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
        1,
      );

      // An interval defaults to pending, and is the block's: it goes when the block does.
      conn
        .prepare(
          `INSERT INTO away_intervals (session_id, started_at, ended_at, created_at)
           VALUES (7, ?, ?, ?)`,
        )
        .run(stamp, '2026-10-12T10:20:00.000Z', stamp);
      const row = conn.prepare('SELECT status, resolved_at FROM away_intervals').get();
      assert.deepEqual(row, { status: 'pending', resolved_at: null });
      assert.throws(
        () =>
          conn
            .prepare(
              `INSERT INTO away_intervals (session_id, started_at, ended_at, status, created_at)
               VALUES (7, ?, ?, 'bogus', ?)`,
            )
            .run(stamp, stamp, stamp),
        /CHECK/,
      );
      assert.throws(
        () =>
          conn
            .prepare(
              `INSERT INTO away_intervals (session_id, started_at, ended_at, created_at)
               VALUES (999, ?, ?, ?)`,
            )
            .run(stamp, stamp, stamp),
        /FOREIGN KEY/,
      );
      conn.prepare('DELETE FROM sessions WHERE id = 7').run();
      assert.equal(
        (conn.prepare('SELECT COUNT(*) AS n FROM away_intervals').get() as { n: number }).n,
        0,
      );

      // The note of what was done about a prompt is one row a key, done or dismissed.
      const note = conn.prepare(
        'INSERT INTO prompt_state (key, status, data, updated_at) VALUES (?, ?, ?, ?)',
      );
      note.run('long-block:7:1', 'dismissed', null, stamp);
      assert.throws(() => note.run('long-block:7:1', 'done', null, stamp), /UNIQUE/);
      assert.throws(() => note.run('long-block:7:2', 'pending', null, stamp), /CHECK/);

      // The lookup by block has its index.
      assert.deepEqual(conn.prepare("SELECT name FROM pragma_index_info('away_session')").all(), [
        { name: 'session_id' },
      ]);

      // One backup, taken before anything changed.
      const backups = fs.readdirSync(dir).filter((f) => f.includes('backup'));
      assert.equal(backups.length, 1);
      assert.match(backups[0]!, /^focusdesk\.backup-before-8-/);
      const before = new Database(path.join(dir, backups[0]!), { readonly: true });
      try {
        const tables = before
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('away_intervals', 'prompt_state')",
          )
          .all();
        assert.deepEqual(tables, []);
      } finally {
        before.close();
      }
      assert.deepEqual(conn.pragma('foreign_key_check'), []);
    } finally {
      conn.close();
    }
  });
});
