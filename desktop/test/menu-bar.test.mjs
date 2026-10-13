import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  elapsedSeconds,
  formatClock,
  menuBarText,
  nativeAccelerator,
  TOOLTIP_MAX,
  trayIconFiles,
  trayMenuWording,
  WAITING_MARK,
} from '../menu-bar.mjs';

const stopwatch = {
  title: 'Deep work',
  projectName: 'ROI Dashboard',
  plannedSeconds: null,
  status: 'running',
};
const pomodoro = { ...stopwatch, plannedSeconds: 25 * 60 };

describe('a clock', () => {
  it('is minutes and seconds up to an hour, then hours as well', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(5), '00:05');
    assert.equal(formatClock(59), '00:59');
    assert.equal(formatClock(60), '01:00');
    assert.equal(formatClock(25 * 60), '25:00');
    assert.equal(formatClock(3599), '59:59');
    assert.equal(formatClock(3600), '1:00:00');
    assert.equal(formatClock(3661), '1:01:01');
    assert.equal(formatClock(10 * 3600 + 5), '10:00:05');
  });

  it('rounds to the second, and is never negative', () => {
    assert.equal(formatClock(59.4), '00:59');
    assert.equal(formatClock(59.6), '01:00');
    assert.equal(formatClock(-30), '00:00');
    assert.equal(formatClock(Number.NaN), '00:00');
  });
});

describe('how long a block has run', () => {
  const read = (session, elapsedAtPoll = 100, polledAt = 1_000_000) => ({
    session,
    elapsedAtPoll,
    polledAt,
  });

  it('is nothing with nothing on the clock', () => {
    assert.equal(elapsedSeconds(read(null), 2_000_000), 0);
  });

  it('goes on at the rate of the clock from the last read while it is running', () => {
    assert.equal(elapsedSeconds(read({ status: 'running' }), 1_000_000), 100);
    assert.equal(elapsedSeconds(read({ status: 'running' }), 1_004_500), 104.5);
  });

  it('stands still while it is paused, however long it has been', () => {
    assert.equal(elapsedSeconds(read({ status: 'paused' }), 5_000_000), 100);
  });

  it('does not take time off for a clock that was set back', () => {
    assert.equal(elapsedSeconds(read({ status: 'running' }), 900_000), 100);
  });
});

describe('what the menu-bar item says', () => {
  it('has no title and says nothing is running, when nothing is and nothing waits', () => {
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 0 }), {
      title: '',
      toolTip: 'FocusDesk - nothing running',
    });
  });

  it('is only the dot, and says how many wait, when nothing is running and something is', () => {
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 1 }), {
      title: WAITING_MARK,
      toolTip: 'FocusDesk - nothing running\n1 thing needs your attention',
    });
    assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 3 }), {
      title: '•',
      toolTip: 'FocusDesk - nothing running\n3 things need your attention',
    });
  });

  it('counts a stopwatch up, unsigned, with its block and project in the tooltip', () => {
    assert.deepEqual(menuBarText({ session: stopwatch, elapsed: 754, waiting: 0 }), {
      title: ' 12:34',
      toolTip: 'Deep work\nROI Dashboard · stopwatch 12:34',
    });
  });

  it('counts a Pomodoro down to its end, and past it with a plus', () => {
    assert.deepEqual(menuBarText({ session: pomodoro, elapsed: 600, waiting: 0 }), {
      title: ' 15:00',
      toolTip: 'Deep work\nROI Dashboard - 15:00',
    });
    assert.equal(menuBarText({ session: pomodoro, elapsed: 25 * 60, waiting: 0 }).title, ' 00:00');
    assert.equal(
      menuBarText({ session: pomodoro, elapsed: 25 * 60 + 90, waiting: 0 }).title,
      ' +01:30',
    );
    assert.equal(
      menuBarText({ session: pomodoro, elapsed: 25 * 60 + 90, waiting: 0 }).toolTip,
      'Deep work\nROI Dashboard - +01:30',
    );
  });

  it('says || for a paused block, which keeps the time it had', () => {
    assert.equal(
      menuBarText({ session: { ...stopwatch, status: 'paused' }, elapsed: 754, waiting: 0 }).title,
      '|| 12:34',
    );
    assert.equal(
      menuBarText({ session: { ...pomodoro, status: 'paused' }, elapsed: 600, waiting: 0 }).title,
      '|| 15:00',
    );
  });

  it('puts the dot before the clock when something waits, running or paused', () => {
    assert.equal(menuBarText({ session: stopwatch, elapsed: 754, waiting: 2 }).title, '• 12:34');
    assert.equal(
      menuBarText({ session: { ...stopwatch, status: 'paused' }, elapsed: 754, waiting: 2 }).title,
      '• || 12:34',
    );
  });

  it('says in the tooltip how many wait, in the singular and the plural, after the block', () => {
    assert.equal(
      menuBarText({ session: stopwatch, elapsed: 754, waiting: 1 }).toolTip,
      'Deep work\nROI Dashboard · stopwatch 12:34\n1 thing needs your attention',
    );
    assert.equal(
      menuBarText({ session: pomodoro, elapsed: 600, waiting: 4 }).toolTip,
      'Deep work\nROI Dashboard - 15:00\n4 things need your attention',
    );
  });

  it('names a block with no project as having none', () => {
    const bare = { ...stopwatch, projectName: null };
    assert.equal(
      menuBarText({ session: bare, elapsed: 60, waiting: 0 }).toolTip,
      'Deep work\nNo project · stopwatch 01:00',
    );
    assert.equal(
      menuBarText({
        session: { ...bare, projectName: undefined, plannedSeconds: 60 },
        elapsed: 0,
        waiting: 0,
      }).toolTip,
      'Deep work\nNo project - 01:00',
    );
  });
});

/* ------------------------------------------------------ off a Mac: the clock is the tooltip */

const NOT_A_MAC = ['win32', 'linux'];
const text = (what) => menuBarText({ platform: 'win32', ...what });
/** Half of an emoji, which cannot be drawn: what is left when a cut goes through the middle of one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('the tooltip on Windows and Linux, which is all there is of the clock', () => {
  it('has the clock first, then the block, then its project', () => {
    for (const platform of NOT_A_MAC) {
      assert.deepEqual(menuBarText({ session: stopwatch, elapsed: 754, waiting: 0, platform }), {
        title: ' 12:34',
        toolTip: '12:34 · Deep work\nROI Dashboard · stopwatch',
      });
      assert.equal(
        menuBarText({ session: pomodoro, elapsed: 600, waiting: 0, platform }).toolTip,
        '15:00 · Deep work\nROI Dashboard',
      );
    }
  });

  it('counts a Pomodoro past its end with a plus, and says || for a paused block', () => {
    assert.equal(
      text({ session: pomodoro, elapsed: 25 * 60 + 90, waiting: 0 }).toolTip,
      '+01:30 · Deep work\nROI Dashboard',
    );
    assert.equal(
      text({ session: { ...pomodoro, status: 'paused' }, elapsed: 600, waiting: 0 }).toolTip,
      '|| 15:00 · Deep work\nROI Dashboard',
    );
    assert.equal(
      text({ session: { ...stopwatch, status: 'paused' }, elapsed: 754, waiting: 0 }).toolTip,
      '|| 12:34 · Deep work\nROI Dashboard · stopwatch',
    );
  });

  it('says in words how many questions wait, last, as it does on a Mac', () => {
    assert.equal(
      text({ session: stopwatch, elapsed: 754, waiting: 1 }).toolTip,
      '12:34 · Deep work\nROI Dashboard · stopwatch\n1 thing needs your attention',
    );
    assert.equal(
      text({ session: pomodoro, elapsed: 600, waiting: 4 }).toolTip,
      '15:00 · Deep work\nROI Dashboard\n4 things need your attention',
    );
  });

  it('names a block with no project as having none, and has no empty line for it', () => {
    assert.equal(
      text({ session: { ...stopwatch, projectName: null }, elapsed: 60, waiting: 0 }).toolTip,
      '01:00 · Deep work\nNo project · stopwatch',
    );
    assert.equal(
      text({ session: { ...pomodoro, projectName: '  ' }, elapsed: 0, waiting: 0 }).toolTip,
      '25:00 · Deep work\nNo project',
    );
  });

  it('leaves out the title when there is none, and never leaves a separator hanging', () => {
    assert.equal(
      text({ session: { ...pomodoro, title: ' \n ' }, elapsed: 0, waiting: 0 }).toolTip,
      '25:00\nROI Dashboard',
    );
  });

  it('says nothing is running as it does on a Mac', () => {
    for (const platform of NOT_A_MAC) {
      assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 0, platform }), {
        title: '',
        toolTip: 'FocusDesk - nothing running',
      });
      assert.deepEqual(menuBarText({ session: null, elapsed: 0, waiting: 3, platform }), {
        title: '•',
        toolTip: 'FocusDesk - nothing running\n3 things need your attention',
      });
    }
  });

  it('keeps the title it has everywhere: only a Mac shows one, and the tests read it', () => {
    for (const session of [stopwatch, pomodoro, { ...stopwatch, status: 'paused' }]) {
      for (const waiting of [0, 2]) {
        const mac = menuBarText({ session, elapsed: 754, waiting });
        for (const platform of NOT_A_MAC) {
          assert.equal(menuBarText({ session, elapsed: 754, waiting, platform }).title, mac.title);
        }
      }
    }
  });

  it('puts a line break in a title on one line, so it cannot hide the clock or make a third', () => {
    const session = { ...stopwatch, title: 'Deep\nwork\t\r\n today' };
    assert.equal(
      text({ session, elapsed: 5, waiting: 0 }).toolTip,
      '00:05 · Deep work today\nROI Dashboard · stopwatch',
    );
  });
});

describe('the tooltip when the title is longer than Windows will show', () => {
  const long = (n, ch = 'x') => ch.repeat(n);
  const tipOf = (title, project, waiting = 0, extra = {}) =>
    text({
      session: { ...stopwatch, title, projectName: project, ...extra },
      elapsed: 754,
      waiting,
    }).toolTip;

  it('is 127 characters at most: what Windows holds', () => {
    assert.equal(TOOLTIP_MAX, 127);
    assert.ok(tipOf(long(300), 'ROI Dashboard').length <= TOOLTIP_MAX);
    assert.ok(tipOf(long(300), long(300), 12).length <= TOOLTIP_MAX);
    assert.ok(tipOf('Deep work', long(300), 1).length <= TOOLTIP_MAX);
  });

  it('keeps the clock at the front, and the count of waiting questions at the end, whole', () => {
    const tip = tipOf(long(300), long(300), 7, { status: 'paused' });
    assert.ok(tip.startsWith('|| 12:34 · x'), tip);
    assert.ok(tip.endsWith('\n7 things need your attention'), tip);
    assert.ok(tip.length <= TOOLTIP_MAX);
  });

  it('cuts the title with an ellipsis, and keeps a short project whole', () => {
    const tip = tipOf(long(300), 'ROI Dashboard');
    const [first, second] = tip.split('\n');
    assert.ok(first.startsWith('12:34 · xxx') && first.endsWith('x…'), first);
    assert.equal(second, 'ROI Dashboard · stopwatch');
    assert.ok(tip.length <= TOOLTIP_MAX);
  });

  it('cuts a long project and keeps a short title whole', () => {
    const [first, second] = tipOf('Deep work', long(300)).split('\n');
    assert.equal(first, '12:34 · Deep work');
    assert.ok(second.startsWith('xxx') && second.endsWith('x… · stopwatch'), second);
  });

  it('shares what there is between a long title and a project, the longer losing more', () => {
    // A project that is shorter than an equal share is kept whole, and the title has the rest.
    const [first, second] = tipOf(long(300), long(30), 0).split('\n');
    assert.equal(second, `${long(30)} · stopwatch`);
    const titleKept = first.length - '12:34 · '.length;
    assert.ok(titleKept > 70, `the title has what the project leaves: ${titleKept}`);
    assert.ok(first.endsWith('…'), first);
    assert.equal(first.length + 1 + second.length, TOOLTIP_MAX);
  });

  it('shares it equally between a title and a project that are both longer than that', () => {
    const [first, second] = tipOf(long(300), long(300), 0).split('\n');
    const titleKept = first.length - '12:34 · '.length;
    const projectKept = second.length - ' · stopwatch'.length;
    assert.ok(Math.abs(titleKept - projectKept) <= 1, `${titleKept} and ${projectKept}`);
    assert.ok(first.endsWith('…') && second.includes('… · stopwatch'));
    assert.ok(first.length + 1 + second.length <= TOOLTIP_MAX);
  });

  it('leaves what already fits exactly as it is', () => {
    // 127 characters, to the last.
    const title = long(TOOLTIP_MAX - '12:34 · '.length - '\nNo project · stopwatch'.length);
    const tip = tipOf(title, null);
    assert.equal(tip.length, TOOLTIP_MAX);
    assert.equal(tip, `12:34 · ${title}\nNo project · stopwatch`);
    // One more and it is cut.
    assert.ok(tipOf(`${title}x`, null).includes('…'));
  });

  it('counts in UTF-16 units, as Windows does, and never cuts an emoji in two', () => {
    // Each of these is two units long, or more. The room to cut into is odd and even by turns as
    // the count of waiting questions changes how much else there is to fit.
    for (const emoji of ['🍅', '👩🏽‍💻', '𝒳']) {
      for (const waiting of [0, 1, 2, 15, 150, 1500]) {
        for (let n = 1; n <= 150; n += 7) {
          const tip = tipOf(emoji.repeat(n), emoji.repeat(n), waiting);
          const label = `${emoji} x ${n}, ${waiting} waiting`;
          assert.ok(tip.length <= TOOLTIP_MAX, `${label}: ${tip.length}`);
          assert.doesNotMatch(tip, LONE_SURROGATE, label);
          // All three lines are there and whole: nothing was cut off the end to make it fit.
          const [first, second, third] = tip.split('\n');
          assert.ok(first.startsWith('12:34 · '), label);
          assert.ok(second.endsWith(' · stopwatch'), label);
          assert.equal(
            third,
            waiting === 0
              ? undefined
              : `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} your attention`,
            label,
          );
        }
      }
    }
  });

  it('is never more than that, whatever the title, the project, the clock or the count', () => {
    const titles = ['', 'a', long(40), long(80), long(120), long(300), '🍅'.repeat(100)];
    const projects = [null, '', 'p', long(40), long(100), long(300)];
    for (const title of titles) {
      for (const project of projects) {
        for (const waiting of [0, 1, 2, 99, 12345, 1e15]) {
          for (const [elapsed, planned] of [
            [0, null],
            [754, null],
            [36000 + 5, null],
            [600, 25 * 60],
            [25 * 60 + 36000, 25 * 60],
          ]) {
            for (const status of ['running', 'paused']) {
              const session = { title, projectName: project, plannedSeconds: planned, status };
              const tip = text({ session, elapsed, waiting }).toolTip;
              const clock = formatClock(planned === null ? elapsed : Math.abs(planned - elapsed));
              assert.ok(tip.length <= TOOLTIP_MAX, `${tip.length}: ${JSON.stringify(tip)}`);
              assert.doesNotMatch(tip, LONE_SURROGATE);
              assert.match(tip, status === 'paused' ? /^\|\| \+?[\d:]+/ : /^\+?[\d:]+/, tip);
              assert.ok(tip.includes(clock), `${clock} in ${JSON.stringify(tip)}`);
            }
          }
        }
      }
    }
  });

  it('is cut at 127 from the end, the clock still first, if nothing else can be made to fit', () => {
    // Not a count anybody could have, which is the point: a number cannot be longer than a few
    // characters, so only something that is not one can make the rest too long for the room.
    const waiting = '9'.repeat(200);
    const tip = text({ session: stopwatch, elapsed: 754, waiting }).toolTip;
    assert.ok(tip.length <= TOOLTIP_MAX, `${tip.length}`);
    // The title and the project have given way, and the clock is still the first thing there.
    assert.ok(tip.startsWith('12:34\n'), tip);
    assert.ok(tip.endsWith('…'), tip);
    const nothing = text({ session: null, elapsed: 0, waiting }).toolTip;
    assert.ok(nothing.length <= TOOLTIP_MAX, `${nothing.length}`);
    assert.ok(nothing.startsWith('FocusDesk - nothing running\n9999'));
    // And the biggest number there is does not need it.
    const biggest = text({ session: stopwatch, elapsed: 754, waiting: Number.MAX_VALUE }).toolTip;
    assert.ok(biggest.length <= TOOLTIP_MAX);
    assert.ok(biggest.endsWith(' things need your attention'), biggest);
  });
});

describe('the tooltip on a Mac is not touched, however long', () => {
  it("is cut by nothing: that is the Mac's own tooltip, which has no such limit", () => {
    const session = { ...stopwatch, title: 'x'.repeat(300), projectName: 'p'.repeat(300) };
    const mac = menuBarText({ session, elapsed: 754, waiting: 3 });
    assert.equal(
      mac.toolTip,
      `${'x'.repeat(300)}\n${'p'.repeat(300)} · stopwatch 12:34\n3 things need your attention`,
    );
    assert.deepEqual(menuBarText({ session, elapsed: 754, waiting: 3, platform: 'darwin' }), mac);
  });

  it('keeps a line break in a title, as it always did', () => {
    assert.equal(
      menuBarText({ session: { ...stopwatch, title: 'a\nb' }, elapsed: 5, waiting: 0 }).toolTip,
      'a\nb\nROI Dashboard · stopwatch 00:05',
    );
  });
});

/* ----------------------------------------------------- the rest of what a platform changes */

describe('the tray icon files', () => {
  it("are the Mac's template image on a Mac: black, which macOS recolours", () => {
    assert.deepEqual(trayIconFiles('darwin'), ['trayTemplate.png']);
  });

  it("are the app's own colours on Windows and Linux, never the template: black on a dark taskbar is gone", () => {
    for (const platform of NOT_A_MAC) {
      for (const file of trayIconFiles(platform)) assert.doesNotMatch(file, /template/i, file);
    }
    assert.deepEqual(trayIconFiles('linux'), ['tray.png']);
  });

  it('are an .ico first on Windows, which holds a picture for each screen scaling, and the .png behind it', () => {
    assert.deepEqual(trayIconFiles('win32'), ['tray.ico', 'tray.png']);
  });
});

describe('the words and keys of the tray menu', () => {
  it("are the Mac's as they always were: Reveal, and ⌘Q beside Quit", () => {
    assert.deepEqual(trayMenuWording('darwin'), {
      dataFolder: 'Reveal data folder',
      quitAccelerator: 'CommandOrControl+Q',
    });
  });

  it('open the data folder on Windows and Linux, and name no key for Quit: there is none', () => {
    for (const platform of NOT_A_MAC) {
      assert.deepEqual(trayMenuWording(platform), {
        dataFolder: 'Open data folder',
        quitAccelerator: undefined,
      });
    }
  });
});

describe('a shortcut as Electron is handed it', () => {
  it('is as saved on a Mac, where Command is a key', () => {
    for (const saved of [
      'Command+Shift+K',
      'CommandOrControl+Alt+K',
      'Cmd+Control+Space',
      'Super+K',
    ]) {
      assert.equal(nativeAccelerator(saved, 'darwin'), saved);
    }
  });

  it('says Super for Command off a Mac, which has no Command key, so it is not left to register as Shift+K', () => {
    for (const platform of NOT_A_MAC) {
      assert.equal(nativeAccelerator('Command+Shift+K', platform), 'Super+Shift+K');
      assert.equal(nativeAccelerator('Cmd+Shift+K', platform), 'Super+Shift+K');
      assert.equal(nativeAccelerator('Shift+Command+K', platform), 'Shift+Super+K');
      assert.equal(nativeAccelerator('Control+Command+Space', platform), 'Control+Super+Space');
      assert.equal(nativeAccelerator('Command+F5', platform), 'Super+F5');
    }
  });

  it('reads the name however it is spelled', () => {
    assert.equal(nativeAccelerator('command+k', 'win32'), 'Super+k');
    assert.equal(nativeAccelerator('COMMAND+K', 'win32'), 'Super+K');
    assert.equal(nativeAccelerator('cMd+k', 'win32'), 'Super+k');
  });

  it('leaves everything else as it is: CommandOrControl is Control here, and Super is already Super', () => {
    for (const platform of NOT_A_MAC) {
      for (const saved of [
        'CommandOrControl+Alt+K',
        'CmdOrCtrl+Shift+F',
        'Control+Shift+K',
        'Super+Shift+K',
        'Meta+K',
        'Option+Control+Space',
        'Alt+F5',
        'Shift+F12',
        'CommandOrControl+Plus',
      ]) {
        assert.equal(nativeAccelerator(saved, platform), saved);
      }
    }
  });

  it('has no Command left in it off a Mac, for any shortcut the server stores', () => {
    const stored = [
      'Command+Shift+K',
      'Cmd+Alt+Space',
      'Command+Option+Shift+Plus',
      'Control+Command+PageUp',
      'Shift+Command+F24',
    ];
    for (const saved of stored) {
      for (const platform of NOT_A_MAC) {
        assert.doesNotMatch(nativeAccelerator(saved, platform), /\b(command|cmd)\b/i, saved);
      }
    }
  });
});
