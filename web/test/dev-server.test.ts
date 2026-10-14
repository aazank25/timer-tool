import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
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
