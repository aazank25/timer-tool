/**
 * electron-builder's `afterPack` hook (`build.afterPack` in package.json). On a macOS build with
 * no signing identity in play it signs the app "ad hoc", so that a copy somebody else downloads
 * can be opened. It is .cjs because the package is `"type": "module"`, and electron-builder would
 * load a .js hook as a module; a .cjs file it simply requires.
 *
 * Why. Packaging changes what Electron's own signature covers (the executable is renamed,
 * Info.plist is rewritten, app.asar is added), and with no identity to sign with electron-builder
 * skips signing ("skipped macOS application code signing") and leaves the app carrying a
 * signature that no longer matches it. Apple silicon Macs will not run that. For a disk image
 * that was downloaded (it carries the quarantine flag) the message is "FocusDesk is damaged and
 * can't be opened", and there is no way past it. An ad-hoc signature (`codesign --sign -`: no
 * certificate, no Apple account) makes the signature match again, and the message becomes the
 * usual "Apple could not verify ...", which System Settings > Privacy & Security > Open Anyway
 * gets past. It does not make Gatekeeper trust the app (that takes a Developer ID certificate and
 * notarization), and it does not turn on the hardened runtime.
 *
 * When. On a macOS build, unless a real identity is in play, that is, unless any of
 *
 *   CSC_LINK            a certificate for electron-builder to import,
 *   CSC_NAME            the name of an identity in the keychain,
 *   build.mac.identity  the same, in package.json,
 *
 * is set (blank is not set). Then electron-builder signs the app itself and this stays out of its
 * way. That is all it looks at, on purpose. When none of the three is set, electron-builder still
 * searches the keychain for a certificate (CSC_IDENTITY_AUTO_DISCOVERY=false stops that). If it
 * finds one it signs the app with that, over this signature: it signs with `codesign --force`, so
 * an ad-hoc signature made first costs a second and is gone. If it finds none it logs "skipped
 * macOS application code signing" and carries on, and the ad-hoc signature is what the app is
 * left with. `build.mac.identity: null` is electron-builder's "do not sign", which names no
 * identity, so it does not turn this off: an app that would otherwise go out unsigned is what
 * this is for.
 *
 * Where. electron-builder 25.1.8 calls the hook in PlatformPackager.doPack, once the app is
 * assembled and before its own signing step (doSignAfterPack), and makes the disk image after
 * both: the image holds the app as signed here.
 *
 * How. `codesign --force --deep --sign - <the .app>`, then
 * `codesign --verify --deep --strict --verbose=2 <the .app>`. Anything that goes wrong in either
 * throws, and that fails the build, codesign not being there included (which is what building a
 * Mac app on another system gets: codesign comes with macOS). An app that could not be signed is
 * not handed over as if it were.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** A setting that is there and not blank: electron-builder reads a blank CSC_NAME as not set, too. */
const given = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Whether the app is signed ad hoc, and the reason either way, which is what the build log says.
 * It reads nothing but what it is given.
 *
 * `platform` is electron-builder's `electronPlatformName`: 'darwin' for a Mac app. 'mas', the App
 * Store build, is not, and is always signed for real. `env` is the environment the build runs
 * in, and `identity` is `build.mac.identity`.
 *
 * @param {{ platform: string, env?: Record<string, string | undefined>, identity?: string | null }} what
 * @returns {{ sign: boolean, reason: string }}
 */
function decideAdHocSigning({ platform, env = {}, identity }) {
  if (platform !== 'darwin') {
    return {
      sign: false,
      reason: `this is a ${platform} build, and only a macOS app is signed this way`,
    };
  }
  if (given(env.CSC_LINK)) {
    return {
      sign: false,
      reason: 'CSC_LINK is set, so electron-builder signs the app with that certificate',
    };
  }
  if (given(env.CSC_NAME)) {
    return {
      sign: false,
      reason: 'CSC_NAME is set, so electron-builder signs the app with that identity',
    };
  }
  if (given(identity)) {
    return {
      sign: false,
      reason: 'build.mac.identity is set, so electron-builder signs the app with that identity',
    };
  }
  return {
    sign: true,
    reason: 'no signing identity is in play (CSC_LINK, CSC_NAME and build.mac.identity are not set)',
  };
}

/** An argument as it would be typed: quoted when it has a space in it. */
const typed = (arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg);

/**
 * Clear the app's extended attributes before it is signed: `codesign --strict` refuses a bundle in
 * which any file carries Finder information or a resource fork ("detritus not allowed"), which a
 * file copied about on a Mac can. Best effort, and quiet: if xattr cannot run, the check after
 * signing says what is wrong.
 */
function clearDetritus(app) {
  spawnSync('xattr', ['-cr', app], { stdio: 'ignore' });
}

/** Run codesign and return what it said. When it does not succeed, throw, saying what it said. */
function codesign(args) {
  const done = spawnSync('codesign', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (done.error) {
    throw new Error(
      done.error.code === 'ENOENT'
        ? 'codesign was not found. It comes with macOS and a Mac app is signed with it, so a Mac app has to be built on a Mac.'
        : `codesign could not be run: ${done.error.message}`,
    );
  }
  const said = `${done.stdout}${done.stderr}`.trim();
  if (done.status !== 0) {
    const how =
      done.status === null ? `was stopped by ${done.signal}` : `exited with status ${done.status}`;
    throw new Error(`codesign ${args.map(typed).join(' ')} ${how}:\n${said}`);
  }
  return said;
}

/**
 * The hook. electron-builder passes the context of one packed app and nothing else; the second
 * argument is for the tests, which cannot run codesign and must not read the environment of
 * whoever runs them.
 */
async function afterPack(
  context,
  { env = process.env, run = codesign, clear = clearDetritus, log = console.log } = {},
) {
  const { sign, reason } = decideAdHocSigning({
    platform: context.electronPlatformName,
    env,
    identity: context.packager?.platformSpecificBuildOptions?.identity,
  });
  if (!sign) {
    log(`  • ad-hoc signing skipped: ${reason}`);
    return;
  }

  // The app is where electron-builder's own signing step looks for it, too.
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  log(`  • ad-hoc signing  ${app}: ${reason}`);
  clear(app);
  run(['--force', '--deep', '--sign', '-', app]);
  const verdict = run(['--verify', '--deep', '--strict', '--verbose=2', app]);
  log(`  • ad-hoc signed and verified  ${app}`);
  // The last lines of what codesign said: "valid on disk", "satisfies its Designated Requirement".
  for (const line of verdict.split('\n').filter((it) => it.trim() !== '').slice(-2)) {
    log(`      ${line.trim()}`);
  }
}

module.exports = { afterPack, decideAdHocSigning };
