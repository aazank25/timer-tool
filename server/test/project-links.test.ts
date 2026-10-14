import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { freshDb } from './setup.js';

/**
 * A project's link (notionUrl) is shown as "Open in Notion" and opened with a click, so it can
 * only be a web address: anything else would be run, in the page or by the computer.
 */

/** The API on a loopback port of its own, so the route's checks are what is tested. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    call: async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Addresses that are not a web page's, each in a way a browser would still read it. */
const NOT_WEB = [
  'javascript:alert(document.domain)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'file:///tmp/x.command',
  'FILE:///Users/Shared/x.command',
  'smb://198.51.100.7/share',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'ms-msdt:/id%20PCWDiagnostic',
  'x-apple.systempreferences:com.apple.preference.security',
  'ftp://example.com/file',
  'not an address at all',
];

describe("a project's link", () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  beforeEach(async () => {
    await freshDb();
  });

  after(() => api.close());

  it('is refused unless it is an http or https address, and nothing is written', async () => {
    for (const notionUrl of NOT_WEB) {
      const res = await api.call('POST', '/projects', { name: 'Linked', notionUrl });
      assert.equal(res.status, 400, JSON.stringify(notionUrl));
      assert.equal(res.body.error, 'Invalid request', JSON.stringify(notionUrl));
    }
    assert.deepEqual((await api.call('GET', '/projects')).body, []);
  });

  it('is refused on a change as well, and the link that was there stays', async () => {
    const kept = 'https://www.notion.so/workspace/Project-0123456789abcdef';
    const project = (await api.call('POST', '/projects', { name: 'Linked', notionUrl: kept }))
      .body;
    for (const notionUrl of NOT_WEB) {
      const res = await api.call('PATCH', `/projects/${project.id}`, { notionUrl });
      assert.equal(res.status, 400, JSON.stringify(notionUrl));
    }
    const [stored] = (await api.call('GET', '/projects')).body;
    assert.equal(stored.notionUrl, kept);
  });

  it('is taken as an https or http address, and cleared with null', async () => {
    const page = 'https://www.notion.so/workspace/Project-0123456789abcdef';
    const created = await api.call('POST', '/projects', { name: 'Linked', notionUrl: page });
    assert.equal(created.status, 201);
    assert.equal(created.body.notionUrl, page);

    const one = `/projects/${created.body.id}`;
    const plain = await api.call('PATCH', one, { notionUrl: 'HTTP://intranet.example/wiki' });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.notionUrl, 'HTTP://intranet.example/wiki');

    // Leaving it out changes nothing; null takes it off.
    const renamed = await api.call('PATCH', one, { name: 'Renamed' });
    assert.equal(renamed.body.notionUrl, 'HTTP://intranet.example/wiki');
    const cleared = await api.call('PATCH', one, { notionUrl: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.notionUrl, null);

    // And a project can be made without one.
    const bare = await api.call('POST', '/projects', { name: 'Bare', notionUrl: null });
    assert.equal(bare.status, 201);
    assert.equal(bare.body.notionUrl, null);
  });
});
