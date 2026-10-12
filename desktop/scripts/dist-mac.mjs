/**
 * Package the app as a disk image for the Mac it is built on, and only that one.
 *
 * electron-builder was set to make both an Apple silicon and an Intel image on every
 * `desktop:mac`, which is twice the work (and twice the download of Electron) for an image
 * nobody on this Mac can use. It is given the one chip explicitly, with the target named
 * (`--mac dmg --arm64`): left to the config, it would go on making both, because the config
 * lists the two. `dist:mac:all` is for making both, to hand to someone else's Mac.
 *
 *   node scripts/dist-mac.mjs                 this Mac's chip
 *   node scripts/dist-mac.mjs --all           both chips
 *   node scripts/dist-mac.mjs --arch x64      one chip, whichever this Mac is
 *   node scripts/dist-mac.mjs --dry-run       say what would be run, and run nothing
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** The options a command line asks for. */
export function parseOptions(argv) {
  const options = { both: false, dryRun: false, arch: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.both = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--arch') options.arch = argv[++i] ?? null;
    else if (arg.startsWith('--arch=')) options.arch = arg.slice('--arch='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
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
    console.error('electron-builder is not installed here. Run: npm --prefix desktop ci');
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
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
