/**
 * Smoke test of a packaged FocusDesk, for CI (see .github/workflows/desktop.yml).
 *
 *   node desktop/scripts/smoke.mjs <FocusDesk.exe | FocusDesk.app | the binary> [electron flags]
 *
 * Starts the app on an empty data folder and checks, in this order, that the window opens, the
 * local server answers GET /api/health, every page in the sidebar draws with no page error and no
 * console error, the database file is there, and the app quits within 15 s of being told to. Exits
 * 0 when all of that holds, and 1 saying which did not. Flags after the path go to the app (on
 * Linux as root, --no-sandbox; Playwright adds that one itself there).
 *
 * Playwright is not a dependency of the repo. The workflow installs it on the side
 * (npm install --no-save --prefix <temp folder>) and sets NODE_PATH to that folder's node_modules,
 * so the lockfiles stay as they are. `import` ignores NODE_PATH and require() does not: hence
 * require.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [target, ...electronArgs] = process.argv.slice(2);
if (!target) {
  console.error('usage: node smoke.mjs <FocusDesk.exe | FocusDesk.app | the binary> [flags]');
  process.exit(2);
}

let _electron;
try {
  ({ _electron } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error(
    'smoke: cannot load Playwright. Run npm install --no-save --prefix <dir> playwright@1.64.0 ' +
      'and set NODE_PATH=<dir>/node_modules',
  );
  process.exit(2);
}

// A Mac app is a folder; the program is the one file in Contents/MacOS.
let exe = path.resolve(target);
if (exe.endsWith('.app') && fs.existsSync(exe)) {
  const inside = path.join(exe, 'Contents', 'MacOS');
  exe = path.join(inside, fs.readdirSync(inside)[0]);
}
if (!fs.existsSync(exe)) {
  console.error(`smoke: there is no app at ${exe}`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-smoke-'));
const dataDir = path.join(root, 'data');
const problems = new Set(); // page errors and console errors, as they happen
const output = []; // what the app itself printed, shown if something fails
let stage = 'starting';
let app;

const say = (what) => console.log(`smoke: ${(stage = what)}`);
const fail = (why) => {
  throw new Error(why);
};
/** Polls `probe` every 250 ms until it is truthy, or fails once `ms` have passed. */
async function until(what, ms, probe) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await probe()) return;
  fail(`${what} did not happen within ${ms / 1000} s`);
}

async function run() {
  say(`launching ${exe}`);
  app = await _electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${path.join(root, 'user')}`, ...electronArgs],
    env: { ...process.env, FOCUSDESK_TEST: '1', FOCUSDESK_DATA_DIR: dataDir },
    timeout: 60_000,
  });
  const proc = app.process();
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on('data', (chunk) => output.push(String(chunk)));
  }
  const watch = (page) => {
    page.on('pageerror', (err) => problems.add(`page error: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.add(`console error: ${msg.text()}`);
    });
  };
  app.windows().forEach(watch);
  app.on('window', watch);

  // The test hooks are the last thing the app sets up, so this is also "it finished starting".
  say('waiting for the main window');
  await until('the main window being shown', 60_000, () =>
    app.evaluate(() => globalThis.__focusdesk?.windowVisible?.()),
  );
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.reload(); // so that the listeners above see the page from its first script on

  say('GET /api/health');
  const serverUrl = await app.evaluate(() => globalThis.__focusdesk.serverUrl);
  const health = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (health.status !== 200) fail(`GET /api/health answered ${health.status}, not 200`);

  say('waiting for the sidebar');
  const links = page.locator('aside nav a[href]');
  await until('the sidebar drawing', 15_000, () => links.count());
  const tabs = await links.evaluateAll((as) =>
    as.map((a) => ({ name: a.title || a.textContent.trim(), href: a.getAttribute('href') })),
  );
  if (tabs.length < 6) fail(`the sidebar has ${tabs.length} links, and it should have 6`);
  for (const { name, href } of tabs) {
    say(`opening ${name} (${href})`);
    await page.click(`aside nav a[href="${href}"]`);
    await page.waitForURL((url) => url.pathname === href);
    await page.waitForFunction(() => document.querySelector('main')?.innerText.trim());
    await sleep(500); // its first requests answer, and what is wrong with it shows
    if (problems.size) fail(`${name} page: ${[...problems].join(' | ')}`);
  }

  say('looking for the database file');
  const db = path.join(dataDir, 'focusdesk.sqlite');
  if (!fs.existsSync(db)) fail(`there is no database file at ${db}`);

  say('quitting');
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve({ code })));
  // The quit is a tick away, so this call is answered before the app goes, and Playwright is not
  // left waiting on a process that has gone.
  await app.evaluate(({ app }) => void setTimeout(() => app.quit(), 0)).catch(() => {});
  const result = await Promise.race([exited, sleep(15_000, null, { ref: false })]);
  if (!result) fail('FocusDesk was still running 15 s after it was told to quit');
  console.log(`smoke: it quit (exit code ${result.code})`);
}

try {
  const tooLong = new Promise((_, reject) => {
    setTimeout(reject, 180_000, new Error('the whole test took longer than 3 minutes')).unref();
  });
  await Promise.race([run(), tooLong]);
  console.log('smoke: PASSED');
} catch (err) {
  console.error(`\nsmoke: FAILED while ${stage}: ${err.message}`);
  const tail = output.join('').trim().split('\n').slice(-15).join('\n');
  if (tail) console.error(`--- the last of what the app printed ---\n${tail}`);
  process.exitCode = 1;
} finally {
  const proc = app?.process();
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL'); // still running: it failed, or it would not quit
    const gone = new Promise((resolve) => proc.once('exit', resolve));
    await Promise.race([gone, sleep(5_000, null, { ref: false })]);
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A temp folder left behind is not a failure of the app.
  }
  // In case something of Playwright's holds the event loop open.
  setTimeout(() => process.exit(), 2_000).unref();
}
