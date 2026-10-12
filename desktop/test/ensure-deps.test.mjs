import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDeps, NOTE_NAME, wantedNote, whyInstall } from '../scripts/ensure-deps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const script = path.join(desktop, 'scripts', 'ensure-deps.mjs');

const folders = [];
after(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

/** A desktop folder of its own, with a lockfile and, if asked, a node_modules that nothing has noted. */
function desktopFolder({ lock = '{"lockfileVersion":3,"packages":{}}', modules = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-ensure-deps-'));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, 'package-lock.json'), lock);
  if (modules) fs.mkdirSync(path.join(folder, 'node_modules'));
  return folder;
}

/** What `npm ci` does to a folder: node_modules cleared, and made again. */
function fakeNpm(status = 0) {
  const calls = [];
  const install = (folder) => {
    calls.push(folder);
    const modules = path.join(folder, 'node_modules');
    fs.rmSync(modules, { recursive: true, force: true });
    if (status === 0) fs.mkdirSync(modules);
    return status;
  };
  return { calls, install };
}

const quiet = () => {};
const noteIn = (folder) => path.join(folder, 'node_modules', NOTE_NAME);

describe('the note of what node_modules was installed from', () => {
  it('is the hash of the lockfile and the platform, and changes with either', () => {
    const a = desktopFolder({ lock: 'one' });
    const b = desktopFolder({ lock: 'two' });

    const note = wantedNote(a, { platform: 'darwin', arch: 'arm64' });
    assert.match(note, /^[0-9a-f]{64} darwin-arm64\n$/);
    assert.equal(wantedNote(a, { platform: 'darwin', arch: 'arm64' }), note, 'the same twice');
    assert.notEqual(wantedNote(b, { platform: 'darwin', arch: 'arm64' }), note, 'another lockfile');
    assert.notEqual(wantedNote(a, { platform: 'darwin', arch: 'x64' }), note, 'another chip');
    assert.notEqual(wantedNote(a, { platform: 'linux', arch: 'arm64' }), note, 'another platform');
  });

  it('is read from the real lockfile of the app, and is on this platform by default', () => {
    assert.match(wantedNote(desktop), new RegExp(`^[0-9a-f]{64} ${process.platform}-${process.arch}\\n$`));
  });

  it('is an error, and not an install, when there is no lockfile', () => {
    const folder = desktopFolder();
    fs.rmSync(path.join(folder, 'package-lock.json'));
    const { calls, install } = fakeNpm();

    assert.throws(() => ensureDeps({ desktop: folder, install, log: quiet }), /package-lock\.json/);
    assert.deepEqual(calls, []);
  });
});

describe('installing the desktop dependencies', () => {
  it('runs npm ci when node_modules is missing, and notes the install only once it has worked', () => {
    const folder = desktopFolder();
    const { calls, install } = fakeNpm();
    const said = [];

    const status = ensureDeps({ desktop: folder, install, log: (line) => said.push(line) });

    assert.equal(status, 0);
    assert.deepEqual(calls, [folder]);
    assert.equal(fs.readFileSync(noteIn(folder), 'utf8'), wantedNote(folder));
    assert.match(said.join('\n'), /node_modules is missing/);
  });

  it('does not run it again while node_modules is what the lockfile says, which is the point of it', () => {
    const folder = desktopFolder();
    const { calls, install } = fakeNpm();
    ensureDeps({ desktop: folder, install, log: quiet });
    const said = [];

    const again = ensureDeps({ desktop: folder, install, log: (line) => said.push(line) });
    ensureDeps({ desktop: folder, install, log: quiet });

    assert.equal(again, 0);
    assert.equal(calls.length, 1, 'once, however many times it is asked');
    assert.match(said.join('\n'), /already installed/);
    assert.equal(whyInstall(folder), null);
  });

  it('runs it again when the lockfile has changed since', () => {
    const folder = desktopFolder({ lock: 'one' });
    const { calls, install } = fakeNpm();
    ensureDeps({ desktop: folder, install, log: quiet });

    fs.writeFileSync(path.join(folder, 'package-lock.json'), 'two');
    ensureDeps({ desktop: folder, install, log: quiet });

    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(noteIn(folder), 'utf8'), wantedNote(folder), 'and notes the new one');
    ensureDeps({ desktop: folder, install, log: quiet });
    assert.equal(calls.length, 2);
  });

  it('runs it again when node_modules is there but nothing noted what it was installed from', () => {
    const folder = desktopFolder({ modules: true });
    const { calls, install } = fakeNpm();
    const said = [];

    ensureDeps({ desktop: folder, install, log: (line) => said.push(line) });

    assert.equal(calls.length, 1);
    assert.match(said.join('\n'), /no record of an install that finished/);
  });

  it('runs it again on another platform, whose optional packages are other ones', () => {
    const folder = desktopFolder();
    const { calls, install } = fakeNpm();
    ensureDeps({ desktop: folder, install, log: quiet, where: { platform: 'linux', arch: 'x64' } });

    ensureDeps({ desktop: folder, install, log: quiet, where: { platform: 'darwin', arch: 'arm64' } });
    assert.equal(calls.length, 2);
    ensureDeps({ desktop: folder, install, log: quiet, where: { platform: 'darwin', arch: 'arm64' } });
    assert.equal(calls.length, 2);
  });

  it('says so, notes nothing and gives back the exit status of npm when it fails, so the next run tries again', () => {
    const folder = desktopFolder();
    const failing = fakeNpm(7);
    const said = [];

    const status = ensureDeps({ desktop: folder, install: failing.install, log: (line) => said.push(line) });

    assert.equal(status, 7);
    assert.equal(fs.existsSync(noteIn(folder)), false);
    assert.match(said.join('\n'), /will try again/);

    const working = fakeNpm();
    assert.equal(ensureDeps({ desktop: folder, install: working.install, log: quiet }), 0);
    assert.equal(working.calls.length, 1);
  });

  it('does nothing about an install that was cut short: there is no note for it, because npm clears node_modules first', () => {
    const folder = desktopFolder();
    const { install } = fakeNpm();
    ensureDeps({ desktop: folder, install, log: quiet });
    // Something wipes node_modules and starts again, and is stopped half way.
    fs.rmSync(path.join(folder, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'node_modules'));

    assert.match(whyInstall(folder), /no record/);
  });

  it('only says what it would do when asked to, and does nothing', () => {
    const folder = desktopFolder();
    const { calls, install } = fakeNpm();
    const said = [];

    const status = ensureDeps({ desktop: folder, dryRun: true, install, log: (line) => said.push(line) });

    assert.equal(status, 0);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(path.join(folder, 'node_modules')), false);
    assert.match(said.join('\n'), /Would run npm ci in .*: node_modules is missing/);
  });
});

describe('the script, run from the command line', () => {
  const windows = process.platform === 'win32';

  /**
   * A desktop folder with the script in it, and an npm of its own at the front of the PATH that
   * only writes down how it was run and does what `npm ci` does to node_modules, so that nothing
   * is installed: what the script asks of npm (its arguments, and where) can be seen.
   */
  function withStubNpm(exitCode = 0) {
    const folder = desktopFolder();
    fs.mkdirSync(path.join(folder, 'scripts'));
    fs.copyFileSync(script, path.join(folder, 'scripts', 'ensure-deps.mjs'));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-stub-npm-'));
    folders.push(bin);
    const log = path.join(bin, 'calls.log');
    const npm = path.join(bin, 'npm');
    fs.writeFileSync(
      npm,
      `#!/bin/sh\necho "$*|$PWD" >> "${log}"\nrm -rf node_modules\nmkdir node_modules\nexit ${exitCode}\n`,
    );
    fs.chmodSync(npm, 0o755);
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(folder, 'scripts', 'ensure-deps.mjs'), ...args], {
        encoding: 'utf8',
        cwd: os.tmpdir(),
        // The stub first, and not the npm that is running these tests, whose own settings the
        // child would otherwise inherit.
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, npm_execpath: '' },
      });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return { folder, run, calls };
  }

  it('runs npm ci, and nothing but npm ci, in its own folder, from wherever it is run', { skip: windows }, () => {
    const { folder, run, calls } = withStubNpm();

    const done = run();

    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(
      calls().map((line) => line.split('|')[0]),
      ['ci'],
    );
    assert.equal(fs.realpathSync(calls()[0].split('|')[1]), fs.realpathSync(folder));
    assert.equal(fs.readFileSync(noteIn(folder), 'utf8'), wantedNote(folder));
  });

  it('does not run npm at all the second time', { skip: windows }, () => {
    const { run, calls } = withStubNpm();
    run();

    const again = run();

    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already installed/);
    assert.equal(calls().length, 1);
  });

  it('exits with the status of npm when it fails, and notes nothing', { skip: windows }, () => {
    const { folder, run, calls } = withStubNpm(3);

    const done = run();

    assert.equal(done.status, 3);
    assert.equal(calls().length, 1);
    assert.equal(fs.existsSync(noteIn(folder)), false);
  });

  it('says what it would do, and runs nothing, with --dry-run', { skip: windows }, () => {
    const { folder, run, calls } = withStubNpm();

    const done = run('--dry-run');

    assert.equal(done.status, 0);
    assert.match(done.stdout, /Would run npm ci/);
    assert.deepEqual(calls(), []);
    assert.equal(fs.existsSync(path.join(folder, 'node_modules')), false);
  });

  it('refuses an option it does not know, with a message and not a stack', { skip: windows }, () => {
    const { run, calls } = withStubNpm();

    const done = run('--force');

    assert.equal(done.status, 1);
    assert.match(done.stderr, /Unknown option: --force/);
    assert.deepEqual(calls(), []);
  });

  it('exits 1 with a message, and runs nothing, when there is no lockfile to go by', { skip: windows }, () => {
    const { folder, run, calls } = withStubNpm();
    fs.rmSync(path.join(folder, 'package-lock.json'));

    const done = run();

    assert.equal(done.status, 1);
    assert.match(done.stderr, /Cannot tell what is installed.*package-lock\.json/);
    assert.deepEqual(calls(), []);
  });
});
