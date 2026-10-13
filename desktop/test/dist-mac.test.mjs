import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  builderArguments,
  chipToBuild,
  hostChip,
  installCommand,
  isMain,
  openImages,
  parseOptions,
} from '../scripts/dist-mac.mjs';

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

describe('the disk images in the way of a build', () => {
  it('are the open FocusDesk images, whatever number macOS gave them, and nothing else', (t) => {
    const volumes = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-volumes-'));
    t.after(() => fs.rmSync(volumes, { recursive: true, force: true }));
    const names = ['FocusDesk', 'FocusDesk 1', 'FocusDesk 2', 'FocusDeskOld', 'Macintosh HD'];
    for (const name of names) fs.mkdirSync(path.join(volumes, name));

    assert.deepEqual(openImages({ volumes }), [
      path.join(volumes, 'FocusDesk'),
      path.join(volumes, 'FocusDesk 1'),
      path.join(volumes, 'FocusDesk 2'),
    ]);
  });

  it('are none when there is nowhere they could be', () => {
    assert.deepEqual(openImages({ volumes: path.join(os.tmpdir(), 'no-such-volumes-folder') }), []);
  });
});

describe('which chip is built when none is named', () => {
  const host = () => 'arm64';
  const options = (arch = null, both = false) => ({ arch, both });

  it("is this Mac's own on a Mac", () => {
    assert.equal(chipToBuild({ options: options(), platform: 'darwin', host }), 'arm64');
  });

  it('is refused off a Mac, where there is no chip of its own to go by', () => {
    assert.throws(
      () => chipToBuild({ options: options(), platform: 'linux', host }),
      /not a Mac.*--arch arm64 or --arch x64.*--all/,
    );
    assert.throws(() => chipToBuild({ options: options(), platform: 'win32', host }), /not a Mac/);
  });

  it('is the one named, or both, on any machine', () => {
    assert.equal(chipToBuild({ options: options('x64'), platform: 'linux', host }), 'x64');
    assert.equal(chipToBuild({ options: options(null, true), platform: 'linux', host }), null);
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

  it('refuses --arch with no chip after it, rather than building for this Mac as if it had not been typed', () => {
    assert.throws(() => parseOptions(['--arch']), /--arch needs a chip: arm64 or x64/);
    assert.throws(() => parseOptions(['--arch=']), /--arch needs a chip: arm64 or x64/);
    // The next word is another option and not the chip.
    assert.throws(() => parseOptions(['--arch', '--dry-run']), /--arch needs a chip/);
    assert.throws(() => parseOptions(['--arch', '--all']), /--arch needs a chip/);
    assert.throws(() => parseOptions(['--dry-run', '--arch']), /--arch needs a chip/);
  });

  it('refuses --all together with --arch, in either order and either spelling: both is not one of them', () => {
    for (const argv of [
      ['--all', '--arch', 'x64'],
      ['--arch', 'x64', '--all'],
      ['--all', '--arch=arm64'],
      ['--arch=arm64', '--all'],
    ]) {
      assert.throws(() => parseOptions(argv), /--all builds both chips.*--arch/, argv.join(' '));
    }
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

  it('picks the chip of the Mac it runs on when none is named, and off a Mac asks for one', () => {
    const run = dryRun();

    if (process.platform === 'darwin') {
      // Under Rosetta an Intel Node on an Apple silicon Mac builds for arm64, so only the shape is checked.
      assert.equal(run.status, 0);
      assert.match(run.out, /^electron-builder --mac dmg --(arm64|x64)$/);
    } else {
      assert.equal(run.status, 1);
      assert.match(run.err, /not a Mac/);
    }
  });

  it('exits with a message, not a stack, for a chip that cannot be built', () => {
    const run = dryRun('--arch', 'ia32');

    assert.equal(run.status, 1);
    assert.match(run.err, /arm64 or x64/);
    assert.equal(run.out, '');
  });

  it('exits with a message, not a stack, for --arch with no chip, and for --all with --arch', () => {
    for (const args of [['--arch'], ['--arch='], ['--arch', '--all'], ['--all', '--arch', 'x64']]) {
      const run = dryRun(...args);

      assert.equal(run.status, 1, args.join(' '));
      assert.match(run.err, /--arch|--all/, args.join(' '));
      assert.doesNotMatch(run.err, /\n\s+at /, 'no stack');
      assert.equal(run.out, '', 'and nothing is said to be about to run');
    }
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

  /** Run the copy of the script in `folder`, from `cwd` (where this test is run from if it is not given). */
  const runFrom = (cwd, folder, ...args) =>
    spawnSync(process.execPath, [path.join(folder, 'scripts', 'dist-mac.mjs'), ...args], {
      encoding: 'utf8',
      cwd,
    });
  const run = (folder, ...args) => runFrom(undefined, folder, ...args);

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
    const folder = inAFolder({ withBuilder: false });

    const done = run(folder, '--arch', 'arm64');

    assert.equal(done.status, 1);
    assert.match(done.stderr, /electron-builder is not installed here\. Run: npm /);
  });

  it('says to run npm ci when it is run from inside the desktop folder, where --prefix desktop would find nothing', () => {
    const folder = inAFolder({ withBuilder: false });

    const done = runFrom(folder, folder, '--arch', 'arm64');

    assert.equal(done.status, 1);
    assert.match(done.stderr, /Run: npm ci\s*$/);
  });

  it('says to run it with --prefix and the way to the desktop folder when it is run from outside it', () => {
    const folder = inAFolder({ withBuilder: false });

    const done = runFrom(path.dirname(folder), folder, '--arch', 'arm64');

    assert.equal(done.status, 1);
    assert.match(done.stderr, new RegExp(`Run: npm --prefix ${path.basename(folder)} ci\\s*$`));
  });

  /** A link to something, or the test is skipped where links cannot be made. */
  function link(t, target, at) {
    try {
      fs.symlinkSync(target, at);
      return true;
    } catch (err) {
      t.skip(`cannot make a link here: ${err.code}`);
      return false;
    }
  }

  it('builds when it is run through a link to the script, as well as by its own path', (t) => {
    const folder = inAFolder();
    const alias = path.join(folder, 'build-it.mjs');
    if (!link(t, path.join(folder, 'scripts', 'dist-mac.mjs'), alias)) return;

    const done = spawnSync(process.execPath, [alias, '--arch', 'arm64'], { encoding: 'utf8' });

    // The script resolves electron-builder from where it really is, so the folder that is
    // the real one has it, and the link to the file alone is enough.
    assert.equal(done.status, 0, done.stderr);
    const said = JSON.parse(done.stdout.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(said.args, ['--mac', 'dmg', '--arm64']);
  });

  it('builds when the folder it is in is reached through a link, as a checkout that is a link to another is', (t) => {
    const folder = inAFolder();
    const alias = path.join(os.tmpdir(), `focusdesk-dist-mac-link-${process.pid}`);
    if (!link(t, folder, alias)) return;
    folders.push(alias);

    const done = spawnSync(process.execPath, [path.join(alias, 'scripts', 'dist-mac.mjs'), '--arch', 'x64'], {
      encoding: 'utf8',
    });

    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /> electron-builder --mac dmg --x64/);
    assert.equal(fs.realpathSync(JSON.parse(done.stdout.split('\n').find((line) => line.startsWith('{'))).cwd), fs.realpathSync(folder));
  });

  it('prints what it would run when it is run through a link with --dry-run, and not nothing', (t) => {
    const folder = inAFolder();
    const alias = path.join(folder, 'build-it.mjs');
    if (!link(t, path.join(folder, 'scripts', 'dist-mac.mjs'), alias)) return;

    const done = spawnSync(process.execPath, [alias, '--dry-run', '--arch', 'x64'], { encoding: 'utf8' });

    assert.equal(done.status, 0);
    assert.equal(done.stdout.trim(), 'electron-builder --mac dmg --x64');
  });
});

describe('where the script is run from', () => {
  it('is the folder the command to install it is typed in: nothing to add inside it', () => {
    assert.equal(installCommand({ cwd: '/repo/desktop', desktop: '/repo/desktop' }), 'npm ci');
  });

  it('is --prefix and the way to the desktop folder from anywhere else', () => {
    assert.equal(
      installCommand({ cwd: '/repo', desktop: '/repo/desktop' }),
      'npm --prefix desktop ci',
    );
    assert.equal(
      installCommand({ cwd: '/repo/desktop/scripts', desktop: '/repo/desktop' }),
      'npm --prefix .. ci',
    );
    assert.equal(
      installCommand({ cwd: '/elsewhere', desktop: '/repo/desktop' }),
      'npm --prefix ../repo/desktop ci',
    );
  });

  it('quotes a way that has a space in it', () => {
    assert.equal(
      installCommand({ cwd: '/Users/me/My Apps', desktop: '/Users/me/My Apps/focus desk/desktop' }),
      'npm --prefix "focus desk/desktop" ci',
    );
  });

  it('is told apart from a module that is imported, by real paths', (t) => {
    const here = fileURLToPath(import.meta.url);
    const url = pathToFileURL(script).href;
    assert.equal(isMain(script, url), true);
    assert.equal(isMain(here, url), false, 'another file');
    assert.equal(isMain(undefined, url), false, 'no entry script at all');
    assert.equal(isMain('/no/such/file.mjs', url), false, 'one that is not there');

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-dist-mac-'));
    after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const alias = path.join(folder, 'alias.mjs');
    try {
      fs.symlinkSync(script, alias);
    } catch (err) {
      t.skip(`cannot make a link here: ${err.code}`);
      return;
    }
    assert.equal(isMain(alias, url), true, 'a link to it is it');
  });
});

describe('the npm scripts that build the app', () => {
  const root = readJson(path.join(desktop, '..', 'package.json')).scripts;
  const inside = readJson(path.join(desktop, 'package.json')).scripts;
  const ensure = 'node desktop/scripts/ensure-deps.mjs';

  it('install what the lockfile says, only when it is not installed already, and never with npm install, which can rewrite it', () => {
    for (const name of [
      'desktop',
      'desktop:mac',
      'desktop:mac:all',
      'desktop:win',
      'desktop:linux',
    ]) {
      assert.ok(root[name].startsWith(`${ensure} && npm --prefix desktop `), name);
      // Not by npm directly in the script: the file is what decides whether to install, and how.
      assert.doesNotMatch(root[name], /npm (--prefix desktop )?(install|ci|i)( |$)/, name);
    }
  });

  it('has the installer that decides, and it only ever runs npm ci (and the scripts it needs)', () => {
    const source = fs.readFileSync(path.join(desktop, 'scripts', 'ensure-deps.mjs'), 'utf8');

    assert.match(source, /\['ci', '--ignore-scripts'\]/);
    assert.match(source, /\['rebuild', \.\.\.INSTALL_SCRIPTS_NEEDED\]/);
    assert.doesNotMatch(source, /['"`]install['"`]/);
  });

  it('build the Mac app through the script that names the chip, and both only on request', () => {
    assert.equal(root['desktop:mac'], `${ensure} && npm --prefix desktop run dist:mac`);
    assert.match(inside['dist:mac'], /node scripts\/dist-mac\.mjs$/);
    assert.doesNotMatch(inside['dist:mac'], /--all/);
    assert.match(inside['dist:mac:all'], /node scripts\/dist-mac\.mjs --all$/);
    assert.equal(root['desktop:mac:all'], `${ensure} && npm --prefix desktop run dist:mac:all`);
  });

  it('have one script at the root for making both chips, and not two names for it', () => {
    assert.equal(root['dist:mac:all'], undefined);
    const names = Object.entries(root)
      .filter(([, command]) => command.includes('run dist:mac:all'))
      .map(([name]) => name);
    assert.deepEqual(names, ['desktop:mac:all']);
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
