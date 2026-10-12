/**
 * Package the app as a disk image for the Mac it is built on, and only that one.
 *
 * electron-builder was set to make both an Apple silicon and an Intel image on every
 * `desktop:mac`, which is twice the work (and twice the download of Electron) for an image
 * nobody on this Mac can use. It is given the one chip explicitly, with the target named
 * (`--mac dmg --arm64`): left to the config, it would go on making both, because the config
 * lists the two. `npm run desktop:mac:all` (`dist:mac:all`, inside desktop/) is for making
 * both, to hand to someone else's Mac.
 *
 *   node scripts/dist-mac.mjs                 this Mac's chip
 *   node scripts/dist-mac.mjs --all           both chips
 *   node scripts/dist-mac.mjs --arch x64      the chip you name (arm64 or x64), whichever chip
 *                                             this Mac has; not with --all, which is both
 *   node scripts/dist-mac.mjs --dry-run       say what would be run, and run nothing
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHIPS = ['arm64', 'x64'];

/**
 * The chip of this Mac. It is the architecture Node runs as, except that an Intel build of
 * Node running under Rosetta on an Apple silicon Mac says x64 and the Mac is arm64.
 */
export function hostChip({ arch = process.arch, translated = false } = {}) {
  return arch === 'x64' && translated ? 'arm64' : arch;
}

/** What electron-builder is given to make the image for `chip`, or for both with `both`. */
export function builderArguments({ chip, both = false }) {
  if (both) return ['--mac', 'dmg', ...CHIPS.map((c) => `--${c}`)];
  if (!CHIPS.includes(chip)) {
    throw new Error(
      `A Mac app is built for arm64 or x64, and this is ${chip}. Say which with --arch arm64 or --arch x64.`,
    );
  }
  return ['--mac', 'dmg', `--${chip}`];
}

/** Whether this process is an Intel build being run on Apple silicon by Rosetta. */
function runsUnderRosetta() {
  if (process.platform !== 'darwin') return false;
  const answer = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
  return answer.status === 0 && answer.stdout.trim() === '1';
}

const NEEDS_A_CHIP = '--arch needs a chip: arm64 or x64.';

/**
 * The options a command line asks for. A chip that is asked for and not given is an error, and
 * not "this Mac's": that is what leaving --arch out means, and a typo must not quietly build
 * something other than what was typed. Nor can one chip be asked for along with both.
 */
export function parseOptions(argv) {
  const options = { both: false, dryRun: false, arch: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      options.both = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--arch') {
      // The next word is another option, or there is none: the chip is missing.
      const chip = argv[i + 1];
      if (chip === undefined || chip.startsWith('--')) throw new Error(NEEDS_A_CHIP);
      options.arch = chip;
      i++;
    } else if (arg.startsWith('--arch=')) {
      const chip = arg.slice('--arch='.length);
      if (chip === '') throw new Error(NEEDS_A_CHIP);
      options.arch = chip;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.both && options.arch !== null) {
    throw new Error('--all builds both chips, so there is no chip left for --arch to choose.');
  }
  return options;
}

/**
 * The command that installs what electron-builder needs, as it is typed from where this was run:
 * `npm ci` inside the desktop folder, and `npm --prefix <the way to it> ci` from anywhere else
 * (from the repo root, that is `npm --prefix desktop ci`, which inside desktop/ would look for a
 * folder of that name in it and find none).
 */
export function installCommand({ cwd, desktop }) {
  const there = path.relative(cwd, desktop);
  if (there === '') return 'npm ci';
  return `npm --prefix ${/\s/.test(there) ? `"${there}"` : there} ci`;
}

/** The real path of a place, or the path as given when it cannot be found (it may be about to be). */
function realPath(place) {
  try {
    return fs.realpathSync(place);
  } catch {
    return place;
  }
}

/**
 * Whether this file is the script being run, and not a module that a test imports. By the real
 * paths of both, because Node names the running module by its real path and the command line
 * names it by whatever path it was typed with: through a link (a symlinked checkout, or a
 * script reached by a link to it) the two differ, and a script that only runs when they are
 * equal quietly did nothing at all, and said it was done.
 */
export function isMain(entry = process.argv[1], url = import.meta.url) {
  if (!entry) return false;
  return realPath(entry) === realPath(fileURLToPath(url));
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktop = path.resolve(here, '..');
  let args;
  try {
    const options = parseOptions(process.argv.slice(2));
    args = builderArguments({
      chip: options.arch ?? hostChip({ translated: runsUnderRosetta() }),
      both: options.both,
    });
    if (options.dryRun) {
      console.log(`electron-builder ${args.join(' ')}`);
      return;
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let cli;
  try {
    cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
  } catch {
    const install = installCommand({ cwd: realPath(process.cwd()), desktop: realPath(desktop) });
    console.error(`electron-builder is not installed here. Run: ${install}`);
    process.exit(1);
  }
  console.log(`\n> electron-builder ${args.join(' ')}`);
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: desktop, stdio: 'inherit' });
  if (run.error) {
    console.error(run.error.message);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}

// Run as a script, and not when a test imports it for the functions above.
if (isMain()) main();
