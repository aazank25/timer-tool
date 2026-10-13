/**
 * Install the desktop app's dependencies, but only if they are not there already. The root
 * scripts (`npm run desktop`, `desktop:mac` and the rest) ran `npm ci` in desktop/ every time,
 * which deletes node_modules and installs all of it again: a minute or more, and a download of
 * Electron, to start an app that was installed a moment ago. This runs `npm ci` only when it
 * has to, and never `npm install`, which can rewrite the lockfile.
 *
 * It has to when node_modules is missing, and when it was not installed from the lockfile that
 * is there now. That is known by a note kept inside node_modules, written after an install that
 * worked: the hash of package-lock.json, and the platform it was made on (the optional
 * packages npm picks, a native build of esbuild among them, are the platform's). `npm ci`
 * clears node_modules before it starts, so an install that was cut short has no note, and is
 * done again; so is a node_modules that something else made.
 *
 *   node scripts/ensure-deps.mjs             install if need be
 *   node scripts/ensure-deps.mjs --dry-run   say whether it would, and install nothing
 *
 * It works from wherever it is run: the folder it installs in is the one it is in.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The note, inside node_modules: the one place that goes when node_modules does. */
export const NOTE_NAME = '.focusdesk-installed-from';

/**
 * What a good install of this folder is a note of: the hash of the lockfile and the platform.
 * Throws if there is no lockfile, which is a different thing to be told about than a missing install.
 */
export function wantedNote(desktop, { platform = process.platform, arch = process.arch } = {}) {
  const lockfile = fs.readFileSync(path.join(desktop, 'package-lock.json'));
  return `${crypto.createHash('sha256').update(lockfile).digest('hex')} ${platform}-${arch}\n`;
}

/**
 * Why `npm ci` has to run, or null when it does not. `wanted` is the note a good install would
 * have (see wantedNote), which is also what throws, first of all, for a folder with no lockfile.
 */
export function whyInstall(desktop, wanted = wantedNote(desktop)) {
  const modules = path.join(desktop, 'node_modules');
  if (!fs.existsSync(modules)) return 'node_modules is missing';
  let note;
  try {
    note = fs.readFileSync(path.join(modules, NOTE_NAME), 'utf8');
  } catch {
    return 'node_modules has no record of an install that finished';
  }
  if (note !== wanted) {
    return 'node_modules was installed from another package-lock.json, or on another platform';
  }
  return null;
}

/**
 * The packages whose install scripts the app needs: Electron's downloads Electron itself, and
 * esbuild's checks its binary for this platform. Every other install script is skipped, and the
 * one that matters is better-sqlite3's. It carries a prebuilt binary for every platform, which is
 * what it loads (its lib/<platform>-<arch>.js), but it also ships a binding.gyp, and for that npm
 * ci compiles it from source: npm honours the package's `gypfile: false` only when it reads the
 * package.json, and ci goes by the lockfile. Compiling needs Python and a C++ compiler (Xcode's
 * tools, Visual Studio) and fails where they are missing or too new, as on GitHub's Windows
 * machines, all for a build that nothing loads.
 */
export const INSTALL_SCRIPTS_NEEDED = ['electron', 'esbuild'];

/** npm in `desktop`, with its output shown. Resolves to its exit status. */
function npm(desktop, args) {
  const windows = process.platform === 'win32';
  const run = spawnSync(windows ? 'npm.cmd' : 'npm', args, {
    cwd: desktop,
    stdio: 'inherit',
    // npm is a .cmd file on Windows, which Node will only start through a shell.
    shell: windows,
  });
  if (run.error) {
    console.error(run.error.message);
    return 1;
  }
  return run.status ?? 1;
}

/** `npm ci` in `desktop` with no install scripts, then the ones it needs. Its exit status. */
function npmCi(desktop) {
  const status = npm(desktop, ['ci', '--ignore-scripts']);
  return status === 0 ? npm(desktop, ['rebuild', ...INSTALL_SCRIPTS_NEEDED]) : status;
}

/**
 * Make sure `desktop` has its dependencies. Returns the exit status: 0 when it does, or when
 * `dryRun` was asked for, and whatever `npm ci` exits with when that fails (nothing is noted
 * then, so the next run tries again).
 *
 * @param {object} what
 * @param {string} what.desktop The desktop folder.
 * @param {boolean} [what.dryRun] Only say what would be done.
 * @param {(desktop: string) => number} [what.install] Runs `npm ci` there; its exit status.
 * @param {(line: string) => void} [what.log]
 * @param {{ platform?: string, arch?: string }} [what.where] The platform it is being run on, which
 *   is the one it is run on unless a test says it is another.
 */
export function ensureDeps({ desktop, dryRun = false, install = npmCi, log = console.log, where }) {
  // Asked first, so that a folder with no lockfile is an error before anything is cleared or run.
  const wanted = wantedNote(desktop, where);
  const why = whyInstall(desktop, wanted);
  if (why === null) {
    log('The desktop dependencies are already installed from this package-lock.json.');
    return 0;
  }
  if (dryRun) {
    log(`Would run npm ci in ${desktop}: ${why}.`);
    return 0;
  }
  log(`Installing the desktop dependencies with npm ci: ${why}.`);
  const status = install(desktop);
  if (status !== 0) {
    log('npm ci did not finish, so nothing is recorded as installed and the next run will try again.');
    return status;
  }
  const modules = path.join(desktop, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, NOTE_NAME), wanted);
  return 0;
}

/** Whether this file is the script being run, by real paths (see isMain in dist-mac.mjs). */
function isMain() {
  const real = (place) => {
    try {
      return fs.realpathSync(place);
    } catch {
      return place;
    }
  };
  return !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => arg !== '--dry-run');
  if (unknown !== undefined) {
    console.error(`Unknown option: ${unknown}`);
    process.exit(1);
  }
  try {
    process.exit(ensureDeps({ desktop, dryRun: args.includes('--dry-run') }));
  } catch (err) {
    // No lockfile, or a folder that cannot be read: the message, and not a stack.
    console.error(`Cannot tell what is installed in ${desktop}: ${err.message}`);
    process.exit(1);
  }
}
