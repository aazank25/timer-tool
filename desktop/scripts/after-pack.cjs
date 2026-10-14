/**
 * electron-builder's `afterPack` hook (`build.afterPack` in package.json). On a macOS build with
 * no signing identity in play it signs the app "ad hoc", so that a copy somebody else downloads
 * can be opened. Before that, on every platform, it sets Electron's fuses (see Fuses, below). It
 * is .cjs because the package is `"type": "module"`, and electron-builder would load a .js hook
 * as a module; a .cjs file it simply requires.
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
 * Fuses. Electron has switches built into its binary, its fuses, which turn off what the app has
 * no use for and anything else on the computer could put to use (see FUSES). They are set in every
 * app, whoever signs it (this hook, electron-builder, or nobody), and before anything does:
 * setting one changes the binary, and a signature made before that would no longer match it. Each
 * is read back once it is set. The build fails if one reads otherwise, or if they cannot be set at
 * all: an app is not handed over without the fuses it was meant to have.
 *
 * Where. electron-builder 25.1.8 calls the hook in PlatformPackager.doPack, once the app is
 * assembled (app.asar, and the hash of it that Electron checks, included) and before its own
 * signing step (doSignAfterPack), and makes the disk image after both: the image holds the app as
 * signed here.
 *
 * How. The fuses with @electron/fuses, in the .app (the framework inside it), the .exe, or the
 * Linux executable. Then, for an ad-hoc signature, `codesign --force --deep --sign - <the .app>`,
 * then `codesign --verify --deep --strict --verbose=2 <the .app>`. Anything that goes wrong in
 * either throws, and that fails the build, codesign not being there included (which is what
 * building a Mac app on another system gets: codesign comes with macOS). An app that could not be
 * signed is not handed over as if it were.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * Electron's fuses as the app ships with them, by their names in @electron/fuses (true is on).
 * Those not named are left as Electron has them.
 *
 *   RunAsNode                              off. ELECTRON_RUN_AS_NODE=1 would turn the app into a
 *                                          plain Node.js for whoever starts it so. Nothing in the
 *                                          app forks a child process, which is what needs it.
 *   EnableNodeOptionsEnvironmentVariable   off. NODE_OPTIONS and NODE_EXTRA_CA_CERTS would let
 *                                          whatever starts the app set Node's options in it.
 *   EnableNodeCliInspectArguments          on. The smoke test (scripts/smoke.mjs) drives the
 *                                          packaged app with Playwright, which starts it with
 *                                          --inspect=0 and works it through the inspector.
 *   OnlyLoadAppFromAsar                    on. The app is loaded from app.asar and nowhere else,
 *                                          not from an app folder put beside it.
 *   EnableEmbeddedAsarIntegrityValidation  on, where Electron can check it (see fusesFor):
 *                                          app.asar has to match the hash electron-builder made
 *                                          of it, or the app does not start.
 *   GrantFileProtocolExtraPrivileges       off. The app loads nothing from file://.
 *   EnableCookieEncryption                 off, as Electron has it. The app keeps no cookies. On a
 *                                          Mac the key would be kept in the Keychain, for an app
 *                                          signed ad hoc, whose signature every build changes, so
 *                                          macOS would ask for the login password after every
 *                                          update to let the new copy read it.
 */
const FUSES = Object.freeze({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: true,
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  GrantFileProtocolExtraPrivileges: false,
  EnableCookieEncryption: false,
});

/**
 * The fuses for an app for `platform` (electron-builder's `electronPlatformName`), built on
 * `host`: FUSES, with the check of app.asar on only where Electron makes it and finds the hash to
 * check against. That is a Mac app, whose hash is in its Info.plist, and a Windows app built on
 * Windows. electron-builder records a Windows app's hash under the file's path written the way the
 * machine that builds it writes paths, and Electron looks it up as resources\app.asar, so a
 * Windows app built on a Mac or on Linux would find none and refuse to start. Electron checks
 * nothing on Linux.
 *
 * @param {string} platform
 * @param {string} [host] The system the build runs on, as `process.platform` says it.
 * @returns {Record<string, boolean>}
 */
function fusesFor(platform, host = process.platform) {
  const checked =
    platform === 'darwin' || platform === 'mas' || (platform === 'win32' && host === 'win32');
  return { ...FUSES, EnableEmbeddedAsarIntegrityValidation: checked };
}

/**
 * Where the fuses are in an app electron-builder has packed: the .app on a Mac (@electron/fuses
 * finds Electron's framework inside it), the .exe on Windows, and the executable on Linux
 * (build.linux.executableName).
 */
function electronBinary({ appOutDir, packager, electronPlatformName: platform }) {
  const name = packager.appInfo.productFilename;
  if (platform === 'darwin' || platform === 'mas') return path.join(appOutDir, `${name}.app`);
  if (platform === 'win32') return path.join(appOutDir, `${name}.exe`);
  return path.join(appOutDir, packager.executableName);
}

/**
 * Set `fuses` (as FUSES has them) in the Electron binary at `binary`, read them back, and return
 * what the binary then says of every fuse it has, by name: 'on', 'off' or 'removed'. Throws, and
 * changes nothing, when a name is not a fuse, when the binary has no fuses, and when Electron has
 * removed one of them (what it did is then fixed, and the setting is to go); and throws when one
 * reads back other than it was set.
 *
 * @electron/fuses is a module, and is a devDependency of desktop/: it is loaded only here, when
 * there is an app to set fuses in, so the tests, which run with the root install alone, never
 * need it.
 */
async function setFuses(binary, fuses) {
  let lib;
  try {
    lib = await import('@electron/fuses');
  } catch (err) {
    throw new Error(
      `@electron/fuses could not be loaded (${err.message}). It is installed with the rest of desktop/: npm ci there.`,
    );
  }
  const { flipFuses, getCurrentFuseWire, FuseState, FuseV1Options, FuseVersion } = lib;
  const config = { version: FuseVersion.V1 };
  for (const [name, on] of Object.entries(fuses)) {
    if (typeof FuseV1Options[name] !== 'number') throw new Error(`There is no fuse named ${name}`);
    config[FuseV1Options[name]] = on;
  }
  // @electron/fuses writes over a removed fuse with a warning, and it would then read as set.
  const before = await getCurrentFuseWire(binary);
  for (const name of Object.keys(fuses)) {
    if (before[FuseV1Options[name]] === FuseState.REMOVED) {
      throw new Error(`Electron has removed the fuse ${name} (in ${binary}): take it out of FUSES`);
    }
  }
  await flipFuses(binary, config);

  const wire = await getCurrentFuseWire(binary);
  const word = {
    [FuseState.ENABLE]: 'on',
    [FuseState.DISABLE]: 'off',
    [FuseState.REMOVED]: 'removed',
  };
  const states = {};
  for (let i = 0; i in wire; i++) {
    states[FuseV1Options[i] ?? `fuse ${i}`] = word[wire[i]] ?? `unknown (${wire[i]})`;
  }
  for (const [name, on] of Object.entries(fuses)) {
    const wanted = on ? 'on' : 'off';
    if (states[name] !== wanted) {
      throw new Error(
        `The fuse ${name} reads ${states[name] ?? 'missing'} in ${binary}, after it was set ${wanted}`,
      );
    }
  }
  return states;
}

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
 * argument is for the tests, which cannot run codesign or change an Electron binary, and must not
 * read the environment of whoever runs them.
 */
async function afterPack(
  context,
  {
    env = process.env,
    run = codesign,
    clear = clearDetritus,
    fuse = setFuses,
    log = console.log,
  } = {},
) {
  // First, on every platform: a signature, here or electron-builder's, has to be made after them.
  const binary = electronBinary(context);
  const states = await fuse(binary, fusesFor(context.electronPlatformName));
  log(`  • fuses set  ${binary}`);
  for (const [name, state] of Object.entries(states)) log(`      ${name} ${state}`);

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

module.exports = { afterPack, decideAdHocSigning, electronBinary, FUSES, fusesFor, setFuses };
