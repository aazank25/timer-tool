import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { builderArguments, hostChip, parseOptions } from '../scripts/dist-mac.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dist-mac.mjs');

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
    assert.deepEqual(builderArguments({ chip: 'arm64', both: true }), ['--mac', 'dmg', '--arm64', '--x64']);
    assert.deepEqual(builderArguments({ chip: 'ia32', both: true }), ['--mac', 'dmg', '--arm64', '--x64']);
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
    assert.deepEqual(parseOptions(['--all', '--dry-run']), { both: true, dryRun: true, arch: null });
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
