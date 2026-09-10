/**
 * Assembles everything the packaged app needs:
 *   dist/server.mjs   the API and static host, bundled
 *   web/              the built client
 *   assets/, build/   tray and app icons
 *
 * The server is bundled with esbuild so the packaged app carries no
 * node_modules tree of its own — better-sqlite3 stays external because it is
 * a native module and must be the platform's own prebuilt binary.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');

const step = (msg) => console.log(`\n> ${msg}`);

step('icons');
execFileSync(process.execPath, [path.join(here, 'make-icons.mjs')], { stdio: 'inherit' });

step('client bundle');
const webDist = path.join(repo, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  execFileSync('npm', ['run', 'build', '-w', 'web'], { cwd: repo, stdio: 'inherit' });
}
const webTarget = path.join(desktop, 'web');
fs.rmSync(webTarget, { recursive: true, force: true });
fs.cpSync(webDist, webTarget, { recursive: true });
// Source maps are a third of the payload and are of no use inside a .app.
for (const file of fs.readdirSync(path.join(webTarget, 'assets'))) {
  if (file.endsWith('.map')) fs.rmSync(path.join(webTarget, 'assets', file));
}
console.log(`  copied ${path.relative(repo, webDist)} -> ${path.relative(repo, webTarget)}`);

step('server bundle');
const result = await esbuild.build({
  entryPoints: [path.join(repo, 'server', 'src', 'app.ts')],
  outfile: path.join(desktop, 'dist', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Native module: must resolve to the platform's own prebuilt binary at runtime.
  external: ['better-sqlite3'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  metafile: true,
  banner: {
    // Some bundled CommonJS dependencies reach for require(); give them one.
    js: [
      "import { createRequire as __focusdeskCreateRequire } from 'node:module';",
      'const require = __focusdeskCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`  dist/server.mjs - ${(bytes / 1024).toFixed(0)} kB`);

step('done');
console.log('  next: npm run dist:mac   (or dist:win / dist:linux)');
