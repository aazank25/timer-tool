import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isFileLoadingAllowed, resolveConfig } from 'vite';
import config from '../vite.config';

/**
 * What `npm run dev` hands out, and to whom. The dev server and the API's port can be reached by
 * every other program on this computer, and by any web page open in a browser on it, so the
 * rules that keep them out are in the Vite config. Starting Vite is more than a unit test should
 * do, so the rules are read from the config, as the config is given to Vite.
 */

const webDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(webDir, '..');
const server = config.server ?? {};

/** Whether `file` is `dir` itself or somewhere under it. */
function isUnder(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Vite's own answer to whether the dev server may hand out a file, for these server options: what
 * it allows and what it denies, as it is resolved and matched once the server runs, without
 * starting one. `file` is as Vite is asked it, written with / on every system.
 */
async function servedBy(fs: { allow: string[]; deny?: string[] }) {
  const resolved = await resolveConfig(
    {
      configFile: false,
      root: webDir,
      logLevel: 'silent',
      server: { fs: { strict: true, ...fs } },
    },
    'serve',
  );
  return (file: string) => isFileLoadingAllowed(resolved, file.split(path.sep).join('/'));
}

describe('the dev server', () => {
  it('serves this package and its dependencies, not the repo root and the database in it', () => {
    assert.equal(server.fs?.strict, true);
    const allowed = (server.fs?.allow ?? []).map((dir) => path.resolve(dir));
    // While developing, the database is data/ at the root of the repo, and it holds the calendar
    // addresses. Vite hands out any file under a directory it may serve.
    for (const kept of ['data', path.join('data', 'focusdesk.sqlite'), 'server', 'package.json']) {
      const file = path.join(repoRoot, kept);
      assert.deepEqual(
        allowed.filter((dir) => isUnder(dir, file)),
        [],
        `${kept} is inside what the dev server serves`,
      );
    }
    // What the page is made of still has to load.
    assert.ok(allowed.some((dir) => isUnder(dir, path.join(webDir, 'src', 'main.tsx'))));
    assert.ok(allowed.some((dir) => isUnder(dir, path.join(webDir, 'index.html'))));
    assert.ok(allowed.some((dir) => isUnder(dir, path.join(repoRoot, 'node_modules', 'react'))));
  });

  it('hands out no database, even by the link to the server, and keeps back what Vite does', async () => {
    // The dependencies are allowed, and node_modules/@focusdesk/server in them is a link to the
    // server's own folder, so everything in that folder is reachable by that path. The data folder
    // can be there as well: a relative FOCUSDESK_DATA_DIR is made inside the server's folder.
    const served = await servedBy({ allow: server.fs?.allow ?? [], deny: server.fs?.deny });
    const file = (...parts: string[]) => path.join(repoRoot, ...parts);
    const link = ['node_modules', '@focusdesk', 'server'];

    for (const kept of [
      // The database, what SQLite keeps beside it, and a backup of it.
      [...link, 'data', 'focusdesk.sqlite'],
      [...link, 'data', 'focusdesk.sqlite-wal'],
      [...link, 'data', 'focusdesk.sqlite-shm'],
      [...link, 'data', 'focusdesk.sqlite-journal'],
      [...link, 'data', 'focusdesk.backup-before-8-2026-01-01T00-00-00-000Z.sqlite'],
      // Under another name, or somewhere other than the data folder.
      [...link, 'old.db'],
      [...link, 'old.db-wal'],
      [...link, 'src', 'copy.sqlite'],
      ['server', 'data', 'focusdesk.sqlite'],
      ['data', 'focusdesk.sqlite'],
      // Anything at all in the server's data folder, at any depth.
      [...link, 'data', 'notes.txt'],
      [...link, 'data', 'exports', 'everything.json'],
      // What Vite keeps back unless told otherwise.
      ['web', '.env'],
      ['web', '.env.production'],
      ['node_modules', 'some-package', 'private.pem'],
      ['node_modules', 'some-package', 'certificate.crt'],
      [...link, '.git', 'config'],
    ]) {
      assert.equal(served(file(...kept)), false, `${kept.join('/')} is handed out`);
    }

    for (const open of [
      // The page, and what it is made of.
      ['web', 'src', 'main.tsx'],
      ['web', 'index.html'],
      ['node_modules', 'react', 'index.js'],
      ['node_modules', '.vite', 'deps', 'react.js'],
      ['node_modules', '@tanstack', 'react-query', 'build', 'modern', 'index.js'],
      // Named a little like what is kept back, and not it.
      ['web', 'src', 'data.ts'],
      ['web', 'src', 'database.ts'],
      ['node_modules', 'some-package', 'db.js'],
      ['node_modules', 'some-package', 'metadata', 'index.js'],
    ]) {
      assert.equal(served(file(...open)), true, `${open.join('/')} is not handed out`);
    }
  });

  it('keeps back all that Vite does by default: a list of its own replaces that one', async () => {
    const vite = await resolveConfig(
      { configFile: false, root: webDir, logLevel: 'silent' },
      'serve',
    );
    const missing = vite.server.fs.deny.filter((pattern) => !server.fs?.deny?.includes(pattern));
    assert.deepEqual(missing, [], 'what Vite denies by default, and this config does not');
  });

  it('is not put off by where the repo is kept: a folder called data, or odd characters', async () => {
    // The data folder is refused by name, and Vite matches the whole path of a file, so a pattern
    // for a folder called data that took no account of where it is would refuse every file of a
    // repo kept inside any folder of that name.
    for (const root of [
      '/data/work/focusdesk',
      '/home/me/Data/focusdesk',
      '/srv/[a]/(b)/{c}/focusdesk',
      '/home/me/my app!/@x+y/focusdesk',
    ]) {
      const served = await servedBy({
        allow: [`${root}/web`, `${root}/node_modules`],
        deny: server.fs?.deny,
      });
      assert.equal(served(`${root}/web/src/main.tsx`), true, root);
      assert.equal(served(`${root}/node_modules/react/index.js`), true, root);
      const link = `${root}/node_modules/@focusdesk/server`;
      assert.equal(served(`${link}/data/focusdesk.sqlite`), false, root);
      assert.equal(served(`${link}/data/notes.txt`), false, root);
      assert.equal(served(`${link}/old.db`), false, root);
    }

    // And why it is not the plain pattern: that refuses the page itself, where the repo is.
    const plain = await servedBy({ allow: ['/data/work/focusdesk/web'], deny: ['**/data/**'] });
    assert.equal(plain('/data/work/focusdesk/web/src/main.tsx'), false);
  });

  it('answers no page from another origin', () => {
    // Left alone, Vite answers a page on any localhost port, and every program on this computer
    // that serves web pages is one.
    assert.equal(server.cors, false);
  });

  it('says its pages are not to be framed', () => {
    // The API says this on every answer, and the page does not come from the API while developing.
    assert.equal(server.headers?.['X-Frame-Options'], 'DENY');
    assert.equal(server.headers?.['Content-Security-Policy'], "frame-ancestors 'none'");
  });

  it('proxies /api to the API on this computer, with the Host the browser used', () => {
    const proxy = server.proxy?.['/api'];
    assert.ok(proxy && typeof proxy === 'object', '/api is proxied');
    assert.match(String(proxy.target), /^http:\/\/127\.0\.0\.1:\d+$/);
    // Rewriting the Host to the API's own would hide a request for another site's name from the
    // API, which refuses every Host that is not a loopback one.
    assert.notEqual(proxy.changeOrigin, true);
  });
});
