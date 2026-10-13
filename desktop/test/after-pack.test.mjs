import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { afterPack, decideAdHocSigning } from '../scripts/after-pack.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const build = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).build;

/** What electron-builder hands the hook for one packed app: only what the hook reads of it. */
function packed({ platform = 'darwin', identity, productFilename = 'FocusDesk', appOutDir } = {}) {
  return {
    electronPlatformName: platform,
    appOutDir: appOutDir ?? path.join('build', 'release', 'mac-arm64'),
    packager: { appInfo: { productFilename }, platformSpecificBuildOptions: { identity } },
  };
}

/**
 * A codesign that is not run, since there is none here to run: it notes what it is asked, says
 * `said`, and fails on the calls named (the first, the second). The environment is empty, so
 * that whoever runs the tests has no say in what they find.
 */
function fakes({ failOn = [], said = '' } = {}) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    env: {},
    run(args) {
      calls.push(args);
      if (failOn.includes(calls.length)) throw new Error(`codesign said no, call ${calls.length}`);
      return said;
    },
    // Nothing to clear: no app is there, and xattr is the Mac's.
    clear: () => {},
    log: (line) => lines.push(line),
  };
}

describe('whether a Mac app is signed ad hoc', () => {
  it('is, on a macOS build that nothing else is going to sign', () => {
    const { sign, reason } = decideAdHocSigning({ platform: 'darwin', env: {}, identity: undefined });

    assert.equal(sign, true);
    // The reason is what the build log tells whoever wonders why: it names the rule.
    assert.match(reason, /CSC_LINK.*CSC_NAME.*build\.mac\.identity/);
  });

  it('is not, on anything but a macOS app, and the reason says what it was', () => {
    for (const platform of ['linux', 'win32', 'mas']) {
      const { sign, reason } = decideAdHocSigning({ platform, env: {}, identity: undefined });
      assert.equal(sign, false, platform);
      assert.ok(reason.includes(platform), reason);
    }
  });

  it('is not, when CSC_LINK or CSC_NAME is set: electron-builder signs with it, and the reason says which', () => {
    for (const name of ['CSC_LINK', 'CSC_NAME']) {
      const { sign, reason } = decideAdHocSigning({
        platform: 'darwin',
        env: { [name]: 'something' },
        identity: undefined,
      });
      assert.equal(sign, false, name);
      assert.ok(reason.includes(name), reason);
    }
  });

  it('is not, when build.mac.identity names an identity', () => {
    const { sign, reason } = decideAdHocSigning({
      platform: 'darwin',
      env: {},
      identity: 'Developer ID Application: Someone (ABCDE12345)',
    });

    assert.equal(sign, false);
    assert.match(reason, /build\.mac\.identity/);
  });

  it('is, when what is set is blank: a secret that is not there reaches a build as an empty variable', () => {
    const env = { CSC_LINK: '', CSC_NAME: '   ' };
    assert.equal(decideAdHocSigning({ platform: 'darwin', env, identity: '' }).sign, true);
  });

  it('is, when build.mac.identity is null: that is "do not sign", and names nothing to sign with', () => {
    assert.equal(decideAdHocSigning({ platform: 'darwin', env: {}, identity: null }).sign, true);
  });

  it('reads what it is given, and not the environment of whoever runs it', () => {
    const before = process.env.CSC_LINK;
    process.env.CSC_LINK = '/somewhere/certificate.p12';
    try {
      assert.equal(decideAdHocSigning({ platform: 'darwin', identity: undefined }).sign, true);
    } finally {
      if (before === undefined) delete process.env.CSC_LINK;
      else process.env.CSC_LINK = before;
    }
  });
});

describe('the afterPack hook', () => {
  const app = path.join('build', 'release', 'mac-arm64', 'FocusDesk.app');

  it('signs the app ad hoc and then checks the signature, in that order, and with those arguments', async () => {
    const f = fakes();
    await afterPack(packed(), f);

    assert.deepEqual(f.calls, [
      ['--force', '--deep', '--sign', '-', app],
      ['--verify', '--deep', '--strict', '--verbose=2', app],
    ]);
  });

  it("clears the app's extended attributes first, so that --strict has no detritus to refuse", async () => {
    const steps = [];
    await afterPack(packed(), {
      env: {},
      log: () => {},
      clear: (target) => steps.push(['clear', target]),
      run: (args) => {
        steps.push(['codesign', args[0]]);
        return '';
      },
    });

    assert.deepEqual(steps, [
      ['clear', app],
      ['codesign', '--force'],
      ['codesign', '--verify'],
    ]);
  });

  it('finds the app by the product file name, spaces and all, and gives it to codesign as one argument', async () => {
    const f = fakes();
    await afterPack(packed({ productFilename: 'Focus Desk' }), f);

    const named = path.join('build', 'release', 'mac-arm64', 'Focus Desk.app');
    assert.deepEqual(
      f.calls.map((args) => args.at(-1)),
      [named, named],
    );
  });

  it('says what it did and why, and what codesign made of the signature', async () => {
    const f = fakes({
      said: `--validated:${app}/Contents/Frameworks/Squirrel\n${app}: valid on disk\n${app}: satisfies its Designated Requirement\n`,
    });
    await afterPack(packed(), f);

    const log = f.lines.join('\n');
    assert.match(log, /ad-hoc signing/);
    assert.ok(log.includes(app), 'which app');
    assert.match(log, /no signing identity is in play/);
    assert.match(log, /ad-hoc signed and verified/);
    assert.match(log, /valid on disk/);
    assert.match(log, /satisfies its Designated Requirement/);
    assert.doesNotMatch(log, /--validated/, 'only the last lines of what codesign said');
  });

  it('does nothing, and says why, when a real identity is in play', async () => {
    const cases = [
      ['CSC_LINK', { CSC_LINK: 'a-certificate' }, undefined],
      ['CSC_NAME', { CSC_NAME: 'an-identity' }, undefined],
      ['build.mac.identity', {}, 'an-identity'],
    ];
    for (const [setting, env, identity] of cases) {
      const f = fakes();
      await afterPack(packed({ identity }), { ...f, env });

      assert.deepEqual(f.calls, [], setting);
      assert.equal(f.lines.length, 1, setting);
      assert.match(f.lines[0], /skipped/);
      assert.ok(f.lines[0].includes(setting), f.lines[0]);
    }
  });

  it('does nothing, and says why, for a build that is not a Mac app', async () => {
    for (const platform of ['linux', 'win32']) {
      const f = fakes();
      await afterPack(packed({ platform }), f);

      assert.deepEqual(f.calls, [], platform);
      assert.equal(f.lines.length, 1, platform);
      assert.match(f.lines[0], /skipped/);
      assert.ok(f.lines[0].includes(platform), f.lines[0]);
    }
  });

  it('reads the environment of the build when it is not given one', async () => {
    const before = process.env.CSC_NAME;
    process.env.CSC_NAME = 'an-identity';
    try {
      const f = fakes();
      await afterPack(packed(), { run: f.run, log: f.log });

      assert.deepEqual(f.calls, []);
      assert.match(f.lines[0], /CSC_NAME/);
    } finally {
      if (before === undefined) delete process.env.CSC_NAME;
      else process.env.CSC_NAME = before;
    }
  });

  it('fails the build when the app cannot be signed, and does not go on to say it was', async () => {
    const f = fakes({ failOn: [1] });

    await assert.rejects(afterPack(packed(), f), /codesign said no, call 1/);
    assert.equal(f.calls.length, 1, 'no check of a signature that was not made');
    assert.doesNotMatch(f.lines.join('\n'), /verified/);
  });

  it('fails the build when the signature does not check out, and does not say it did', async () => {
    const f = fakes({ failOn: [2] });

    await assert.rejects(afterPack(packed(), f), /codesign said no, call 2/);
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.lines.join('\n'), /verified/);
  });

});

describe('the codesign the hook really runs', () => {
  /**
   * Puts a codesign of our own at the front of PATH until the test is over: a shell script that
   * writes down each call (an argument to a line, and a line of `--` after them) and then does
   * what `body` says. Returns what reads the calls back. The real one, where there is one, is
   * further along PATH and never reached.
   */
  function standInForCodesign(t, body) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-after-pack-'));
    const log = path.join(folder, 'calls.txt');
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nprintf '%s\\n' '--' >> '${log}'\n${body}\n`;
    fs.writeFileSync(path.join(folder, 'codesign'), script, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${folder}${path.delimiter}${savedPath}`;
    t.after(() => {
      process.env.PATH = savedPath;
      fs.rmSync(folder, { recursive: true, force: true });
    });
    return () => {
      const calls = [];
      let call = [];
      for (const line of fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []) {
        if (line === '--') {
          calls.push(call);
          call = [];
        } else if (line !== '') {
          call.push(line);
        }
      }
      return calls;
    };
  }

  const skip = process.platform === 'win32' && 'the stand-in for codesign is a shell script';
  const lastArgument = 'for last; do :; done';
  const appOutDir = path.join(os.tmpdir(), 'focusdesk-after-pack-app', 'mac-x64');

  it('is run with the app as one argument, and what it says of the signature is logged', { skip }, async (t) => {
    const callsMade = standInForCodesign(
      t,
      `case "$1" in --verify) ${lastArgument}
echo "$last: valid on disk" >&2
echo "$last: satisfies its Designated Requirement" >&2;; esac`,
    );
    const lines = [];

    await afterPack(packed({ productFilename: 'Focus Desk', appOutDir }), {
      env: {},
      log: (line) => lines.push(line),
    });

    const app = path.join(appOutDir, 'Focus Desk.app');
    assert.deepEqual(callsMade(), [
      ['--force', '--deep', '--sign', '-', app],
      ['--verify', '--deep', '--strict', '--verbose=2', app],
    ]);
    const log = lines.join('\n');
    assert.match(log, /ad-hoc signed and verified/);
    assert.match(log, /Focus Desk\.app: valid on disk/);
    assert.match(log, /satisfies its Designated Requirement/);
  });

  it('fails the build, saying what it said, when it will not sign; and does not go on to check', { skip }, async (t) => {
    const callsMade = standInForCodesign(t, 'echo "no usable thing to sign here" >&2\nexit 1');

    await assert.rejects(
      afterPack(packed({ appOutDir }), { env: {}, log: () => {} }),
      (error) =>
        /exited with status 1/.test(error.message) &&
        /no usable thing to sign here/.test(error.message) &&
        /--force --deep --sign - /.test(error.message),
    );
    assert.equal(callsMade().length, 1);
  });

  it('fails the build, saying what it said, when the signature it made does not verify', { skip }, async (t) => {
    const callsMade = standInForCodesign(
      t,
      'case "$1" in --verify) echo "a sealed resource is missing or invalid" >&2; exit 1;; esac',
    );
    const lines = [];

    await assert.rejects(
      afterPack(packed({ appOutDir }), { env: {}, log: (line) => lines.push(line) }),
      /exited with status 1:\na sealed resource is missing or invalid/,
    );
    assert.equal(callsMade().length, 2);
    assert.doesNotMatch(lines.join('\n'), /verified/);
  });

  it('fails the build, and says what is wrong, when there is no codesign at all', async (t) => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-after-pack-'));
    const savedPath = process.env.PATH;
    process.env.PATH = empty;
    t.after(() => {
      process.env.PATH = savedPath;
      fs.rmSync(empty, { recursive: true, force: true });
    });

    await assert.rejects(
      afterPack(packed({ appOutDir }), { env: {}, log: () => {} }),
      /codesign was not found.*built on a Mac/,
    );
  });
});

describe('the hook in the build configuration', () => {
  it('is named by build.afterPack, as a .cjs file that is there, from desktop/ where electron-builder runs', () => {
    // A path that starts with a dot is resolved from where electron-builder is run, which is
    // desktop/ for every script here. .cjs, because a .js file in a "type": "module" package is
    // imported as a module, and this is required.
    assert.equal(build.afterPack, './scripts/after-pack.cjs');
    assert.equal(path.extname(build.afterPack), '.cjs');
    assert.ok(fs.existsSync(path.resolve(desktop, build.afterPack)));
  });

  it('exports the hook as afterPack, the name electron-builder looks for first', () => {
    assert.equal(typeof afterPack, 'function');
  });

  it('is not packed into the app: build.files lists what goes in, and it is not on the list', () => {
    const listed = (file) =>
      build.files.some(
        (pattern) =>
          pattern === file || (pattern.endsWith('/**/*') && file.startsWith(pattern.slice(0, -4))),
      );

    assert.ok(listed('main.mjs'), 'asking the list works');
    assert.equal(listed('scripts/after-pack.cjs'), false);
    assert.equal(listed('test/after-pack.test.mjs'), false);
    // And no pattern takes in everything, which would put it there anyway.
    const everything = ['*', '**', '**/*', 'scripts/*', 'scripts/**', 'scripts/**/*'];
    assert.deepEqual(
      build.files.filter((pattern) => everything.includes(pattern)),
      [],
    );
  });

  it('builds the Windows installer for x64, and says so, and not for whatever machine builds it', () => {
    // With no arch, electron-builder builds for the machine it runs on: an ARM64-only installer
    // from an Apple silicon Mac or an arm64 runner, which most Windows PCs cannot run.
    assert.deepEqual(build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  });

  it('names the disk images and the installer by platform and chip, so no two can be mistaken for each other', () => {
    // Set by the config, so ${arch} is in the name for x64 too: left to its own pattern,
    // electron-builder leaves the default chip (x64) out of the name.
    assert.equal(build.dmg.artifactName, '${productName}-${version}-mac-${arch}.${ext}');
    assert.equal(build.nsis.artifactName, '${productName}-${version}-windows-${arch}-setup.${ext}');
  });
});
