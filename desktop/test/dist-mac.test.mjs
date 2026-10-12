import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { builderArguments, hostChip, parseOptions } from '../scripts/dist-mac.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const script = path.join(desktop, 'scripts', 'dist-mac.mjs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Run the script as the npm script does, but only to see what it would run. */
function dryRun(...args) {
  const run = spawnSync(process.execPath, [script, '--dry-run', ...args], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

describe('the arguments for packaging a Mac app', () => {
  it('make one image, named, for the chip of the Mac: arm64', () => {
    assert.deepEqual(builderArguments({ chip: 'arm64' }), ['--mac', 'dmg', '--arm64']);
  });

  it('make one image, named, for the chip of the Mac: x64', () => {
    assert.deepEqual(builderArguments({ chip: 'x64' }), ['--mac', 'dmg', '--x64']);
  });

  it('make both when both are asked for, whatever the chip', () => {
    assert.deepEqual(builderArguments({ chip: 'arm64', both: true }), [
      '--mac',
      'dmg',
      '--arm64',
      '--x64',
    ]);
    assert.deepEqual(builderArguments({ chip: 'ia32', both: true }), [
      '--mac',
      'dmg',
      '--arm64',
      '--x64',
    ]);
  });

  it('refuse a chip a Mac app is not built for, and say what to do', () => {
    assert.throws(() => builderArguments({ chip: 'ia32' }), /arm64 or x64.*--arch/);
    assert.throws(() => builderArguments({ chip: undefined }), /arm64 or x64/);
  });
});

describe('the chip of this Mac', () => {
  it('is the architecture Node runs as', () => {
    assert.equal(hostChip({ arch: 'arm64' }), 'arm64');
    assert.equal(hostChip({ arch: 'x64' }), 'x64');
    assert.equal(hostChip({ arch: 'ia32' }), 'ia32');
  });

  it('is Apple silicon when an Intel Node is being run on it by Rosetta', () => {
    assert.equal(hostChip({ arch: 'x64', translated: true }), 'arm64');
    // Translation only ever makes an Intel binary of an Apple silicon Mac.
    assert.equal(hostChip({ arch: 'arm64', translated: true }), 'arm64');
  });

  it('is read from the running process when nothing is said', () => {
    assert.equal(hostChip(), process.arch);
  });
});

describe('the command line', () => {
  it('asks for nothing by default, which is this Mac', () => {
    assert.deepEqual(parseOptions([]), { both: false, dryRun: false, arch: null });
  });

  it('takes --all, --dry-run and --arch in either spelling', () => {
    assert.deepEqual(parseOptions(['--all', '--dry-run']), {
      both: true,
      dryRun: true,
      arch: null,
    });
    assert.deepEqual(parseOptions(['--arch', 'x64']), { both: false, dryRun: false, arch: 'x64' });
    assert.deepEqual(parseOptions(['--arch=arm64']), { both: false, dryRun: false, arch: 'arm64' });
  });

  it('refuses what it does not know', () => {
    assert.throws(() => parseOptions(['--universal']), /Unknown option: --universal/);
  });

  it('prints the electron-builder command for an Apple silicon Mac, without running it', () => {
    const run = dryRun('--arch', 'arm64');

    assert.equal(run.status, 0);
    assert.equal(run.out, 'electron-builder --mac dmg --arm64');
  });

  it('prints the electron-builder command for an Intel Mac, without running it', () => {
    const run = dryRun('--arch=x64');

    assert.equal(run.status, 0);
    assert.equal(run.out, 'electron-builder --mac dmg --x64');
  });

  it('prints both chips for the build that is for sharing', () => {
    const run = dryRun('--all');

    assert.equal(run.status, 0);
    assert.equal(run.out, 'electron-builder --mac dmg --arm64 --x64');
  });

  it('picks the chip of the machine it runs on when none is named', () => {
    const run = dryRun();

    // Under Rosetta an Intel Node on an Apple silicon Mac builds for arm64, so only the shape is checked.
    assert.equal(run.status, 0);
    assert.match(run.out, /^electron-builder --mac dmg --(arm64|x64)$/);
  });

  it('exits with a message, not a stack, for a chip that cannot be built', () => {
    const run = dryRun('--arch', 'ia32');

    assert.equal(run.status, 1);
    assert.match(run.err, /arm64 or x64/);
    assert.equal(run.out, '');
  });
});

describe('running electron-builder', () => {
  const folders = [];
  after(() => {
    for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  });

  /**
   * The script as it sits in a desktop folder of its own, with a stand-in for electron-builder
   * that says how it was run and exits with the code it is given: nothing is packaged, and what
   * the script does with the other program (its arguments, where it runs, whose output is shown,
   * which exit code comes back) can be seen.
   */
  function inAFolder({ withBuilder = true, exitCode = 0 } = {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-dist-mac-'));
    folders.push(folder);
    fs.mkdirSync(path.join(folder, 'scripts'));
    fs.copyFileSync(script, path.join(folder, 'scripts', 'dist-mac.mjs'));
    if (withBuilder) {
      const builder = path.join(folder, 'node_modules', 'electron-builder');
      fs.mkdirSync(builder, { recursive: true });
      fs.writeFileSync(
        path.join(builder, 'cli.js'),
        `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n` +
          `process.exitCode = ${exitCode};\n`,
      );
    }
    return folder;
  }

  const run = (folder, ...args) =>
    spawnSync(process.execPath, [path.join(folder, 'scripts', 'dist-mac.mjs'), ...args], {
      encoding: 'utf8',
    });

  it('runs the electron-builder that is installed in the desktop folder, from that folder, with the arguments for one chip', () => {
    const folder = inAFolder();

    const done = run(folder, '--arch', 'arm64');

    assert.equal(done.status, 0);
    // The other program's own output comes through, so its progress and its errors are seen.
    const said = JSON.parse(done.stdout.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(said.args, ['--mac', 'dmg', '--arm64']);
    assert.equal(fs.realpathSync(said.cwd), fs.realpathSync(folder));
    assert.match(done.stdout, /> electron-builder --mac dmg --arm64/);
  });

  it('runs it for both chips when asked for both', () => {
    const done = run(inAFolder(), '--all');

    const said = JSON.parse(done.stdout.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(said.args, ['--mac', 'dmg', '--arm64', '--x64']);
  });

  it('exits with the code electron-builder exits with, so a failed build fails the npm script', () => {
    assert.equal(run(inAFolder({ exitCode: 7 }), '--arch', 'x64').status, 7);
    assert.equal(run(inAFolder({ exitCode: 1 }), '--arch', 'x64').status, 1);
  });

  it('says how to install it, and exits 1, when it is not there', () => {
    const done = run(inAFolder({ withBuilder: false }), '--arch', 'arm64');

    assert.equal(done.status, 1);
    assert.match(
      done.stderr,
      /electron-builder is not installed here\. Run: npm --prefix desktop ci/,
    );
  });
});

describe('the npm scripts that build the app', () => {
  const root = readJson(path.join(desktop, '..', 'package.json')).scripts;
  const inside = readJson(path.join(desktop, 'package.json')).scripts;

  it('install what the lockfile says with npm ci, never npm install, which can rewrite it', () => {
    for (const name of [
      'desktop',
      'desktop:mac',
      'desktop:mac:all',
      'dist:mac:all',
      'desktop:win',
      'desktop:linux',
    ]) {
      assert.match(root[name], /^npm --prefix desktop ci && /, name);
      assert.doesNotMatch(root[name], /npm (--prefix desktop )?install/, name);
    }
  });

  it('build the Mac app through the script that names the chip, and both only on request', () => {
    assert.equal(
      root['desktop:mac'],
      'npm --prefix desktop ci && npm --prefix desktop run dist:mac',
    );
    assert.match(inside['dist:mac'], /node scripts\/dist-mac\.mjs$/);
    assert.doesNotMatch(inside['dist:mac'], /--all/);
    assert.match(inside['dist:mac:all'], /node scripts\/dist-mac\.mjs --all$/);
    assert.equal(
      root['desktop:mac:all'],
      'npm --prefix desktop ci && npm --prefix desktop run dist:mac:all',
    );
    // The same under the name the desktop folder gives it, for whoever types that one at the root.
    assert.equal(root['dist:mac:all'], root['desktop:mac:all']);
  });

  it('run the desktop tests from the root with the pattern that node 22 reads, not a folder it would not', () => {
    // `node --test desktop/test/` is a folder, which node 22 tries to run as a file.
    assert.equal(root.test, 'npm run test -w server && node --test "desktop/test/*.test.mjs"');
  });
});

describe('what the packaged app carries', () => {
  const build = readJson(path.join(desktop, 'package.json')).build;
  const listed = (file) =>
    build.files.some(
      (pattern) =>
        pattern === file || (pattern.endsWith('/**/*') && file.startsWith(pattern.slice(0, -4))),
    );

  it('has every module the main process imports, or it would fail to start once packaged', () => {
    const modules = fs.readdirSync(desktop).filter((file) => file.endsWith('.mjs'));
    assert.ok(
      modules.includes('main.mjs') &&
        modules.includes('away.mjs') &&
        modules.includes('attention.mjs'),
    );
    for (const file of modules) {
      const source = fs.readFileSync(path.join(desktop, file), 'utf8');
      for (const [, imported] of source.matchAll(/from '\.\/([^']+)'/g)) {
        assert.ok(
          listed(imported),
          `${file} imports ./${imported}, which build.files does not list`,
        );
      }
      assert.ok(listed(file), `${file} is not in build.files`);
    }
    assert.ok(listed('preload.cjs'));
  });
});
