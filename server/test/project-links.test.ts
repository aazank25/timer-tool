import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { freshDb } from './setup.js';

/**
 * A project's link (notionUrl) is shown as "Open in Notion" and opened with a click, so it can
 * only be a web address: anything else would be run, in the page or by the computer. It is stored
 * as a browser reads it, so that what the page links and what the server accepts are one thing.
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
  'mailto:someone@example.com',
  'notion://www.notion.so/workspace/Project-0123456789abcdef',
  '//evil.example',
  'https://',
  'not an address at all',
];

/**
 * Addresses that are a web page's, written in ways a browser reads and a person might type or
 * paste: round it with a space or a line break, with a tab in it, in capitals, with the slashes
 * missing or the wrong way, or with a character it would not send. Each with the address it is.
 */
const WRITTEN_AS: [written: string, stored: string][] = [
  [' https://x.example', 'https://x.example/'],
  ['https://x.example ', 'https://x.example/'],
  ['\nhttps://x.example', 'https://x.example/'],
  ['\thttps://x.example\r\n', 'https://x.example/'],
  ['ht\ttps://x.example', 'https://x.example/'],
  ['https://x.exa\tmple', 'https://x.example/'],
  ['https://x.example/\npath', 'https://x.example/path'],
  ['https://x.example\u0000', 'https://x.example/'],
  ['https:evil.example', 'https://evil.example/'],
  ['https:/\\evil.example', 'https://evil.example/'],
  ['https:\\\\evil.example', 'https://evil.example/'],
  ['https:///evil.example', 'https://evil.example/'],
  ['HTTPS://X.EXAMPLE/Path?Q=1#Top', 'https://x.example/Path?Q=1#Top'],
  ['HTTP://intranet.example/wiki', 'http://intranet.example/wiki'],
  ['http://example.com/a b', 'http://example.com/a%20b'],
  // The first letter is a Cyrillic one, which a browser sends as punycode.
  ['https://\u{435}xample.com', 'https://xn--xample-2of.com/'],
  // Already as a browser writes it: unchanged.
  [
    'https://www.notion.so/workspace/Project-0123456789abcdef?pvs=4#top',
    'https://www.notion.so/workspace/Project-0123456789abcdef?pvs=4#top',
  ],
  ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/'],
  ['https://[::1]/', 'https://[::1]/'],
];

/**
 * What the page tests a link with before it shows it as one, read from the page itself
 * (web/src/pages/Projects.tsx), so that this holds the server to what the page really does.
 */
function pageLinkTest(): RegExp {
  const source = fs.readFileSync(
    new URL('../../web/src/pages/Projects.tsx', import.meta.url),
    'utf8',
  );
  const found = /const WEB_LINK = \/(.+)\/([a-z]*);/.exec(source);
  assert.ok(found?.[1] !== undefined, 'the page does not say what a web link is in WEB_LINK');
  return new RegExp(found[1], found[2]);
}

/**
 * What a refusal says about the link, under the field, for the person who typed it: it is shown
 * beside the link in the project's dialog, so it says what to do and not which rule was broken.
 */
const NOT_A_LINK = 'Use a link that starts with https:// or http://';
const TOO_LONG = 'That link is longer than 2000 characters';

/** The whole of a refusal that is about the link and nothing else. */
const aboutTheLink = (message: string) => ({
  formErrors: [],
  fieldErrors: { notionUrl: [message] },
});

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

  it('is refused in words that say what to do, under the link and nothing else', async () => {
    // Each of these is what the dialog shows next to the field, in place of "Invalid request".
    for (const notionUrl of [...NOT_WEB, '', '   ']) {
      const res = await api.call('POST', '/projects', { name: 'Linked', notionUrl });
      assert.equal(res.status, 400, JSON.stringify(notionUrl));
      assert.deepEqual(res.body.details, aboutTheLink(NOT_A_LINK), JSON.stringify(notionUrl));
    }
    const long = await api.call('POST', '/projects', {
      name: 'Linked',
      notionUrl: `https://x.example/${'a'.repeat(2000)}`,
    });
    assert.equal(long.status, 400);
    assert.deepEqual(long.body.details, aboutTheLink(TOO_LONG));
    assert.deepEqual((await api.call('GET', '/projects')).body, []);
  });

  it('is refused on a change as well, and the link that was there stays', async () => {
    const kept = 'https://www.notion.so/workspace/Project-0123456789abcdef';
    const project = (await api.call('POST', '/projects', { name: 'Linked', notionUrl: kept }))
      .body;
    for (const notionUrl of NOT_WEB) {
      const res = await api.call('PATCH', `/projects/${project.id}`, { notionUrl });
      assert.equal(res.status, 400, JSON.stringify(notionUrl));
      assert.deepEqual(res.body.details, aboutTheLink(NOT_A_LINK), JSON.stringify(notionUrl));
    }
    const [stored] = (await api.call('GET', '/projects')).body;
    assert.equal(stored.notionUrl, kept);
  });

  it('is named with the other field when a change is refused for both', async () => {
    // The dialog shows the link's reason beside it and the rest below, so each has to be there.
    const project = (await api.call('POST', '/projects', { name: 'Linked' })).body;
    const res = await api.call('PATCH', `/projects/${project.id}`, {
      name: 'x'.repeat(121),
      notionUrl: 'notion://www.notion.so/x',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body.details.fieldErrors).sort(), ['name', 'notionUrl']);
    assert.deepEqual(res.body.details.fieldErrors.notionUrl, [NOT_A_LINK]);
  });

  it('is taken as an https or http address, and cleared with null', async () => {
    const page = 'https://www.notion.so/workspace/Project-0123456789abcdef';
    const created = await api.call('POST', '/projects', { name: 'Linked', notionUrl: page });
    assert.equal(created.status, 201);
    assert.equal(created.body.notionUrl, page);

    const one = `/projects/${created.body.id}`;
    const plain = await api.call('PATCH', one, { notionUrl: 'HTTP://intranet.example/wiki' });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.notionUrl, 'http://intranet.example/wiki');

    // Leaving it out changes nothing; null takes it off.
    const renamed = await api.call('PATCH', one, { name: 'Renamed' });
    assert.equal(renamed.body.notionUrl, 'http://intranet.example/wiki');
    const cleared = await api.call('PATCH', one, { notionUrl: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.notionUrl, null);

    // And a project can be made without one.
    const bare = await api.call('POST', '/projects', { name: 'Bare', notionUrl: null });
    assert.equal(bare.status, 201);
    assert.equal(bare.body.notionUrl, null);
  });

  it('is stored as the address a browser reads, and the page links every one that is stored', async () => {
    const { db } = await import('../src/db.js');
    const isLink = pageLinkTest();
    for (const [i, [written, stored]] of WRITTEN_AS.entries()) {
      const what = JSON.stringify(written);
      const created = await api.call('POST', '/projects', {
        name: `Linked ${i}`,
        notionUrl: written,
      });
      assert.equal(created.status, 201, what);
      assert.equal(created.body.notionUrl, stored, what);

      // As it is kept, and as it is listed.
      const row = db
        .prepare('SELECT notion_url FROM projects WHERE id = ?')
        .get(created.body.id) as { notion_url: string };
      assert.equal(row.notion_url, stored, what);
      const listed = (await api.call('GET', '/projects')).body.find(
        (p: { id: number }) => p.id === created.body.id,
      );
      assert.equal(listed.notionUrl, stored, what);

      // Whatever is stored begins as a web address does, so the page shows it as a link.
      assert.match(row.notion_url, /^https?:\/\//, what);
      assert.ok(isLink.test(row.notion_url), `the page does not link ${what}`);
    }
  });

  it('is stored the same way on a change, and what is stored is already as it is stored', async () => {
    const isLink = pageLinkTest();
    const project = (
      await api.call('POST', '/projects', { name: 'Linked', notionUrl: 'https://first.example/' })
    ).body;
    const one = `/projects/${project.id}`;
    for (const [written, stored] of WRITTEN_AS) {
      const what = JSON.stringify(written);
      const changed = await api.call('PATCH', one, { notionUrl: written });
      assert.equal(changed.status, 200, what);
      assert.equal(changed.body.notionUrl, stored, what);
      assert.ok(isLink.test(changed.body.notionUrl), `the page does not link ${what}`);

      // Sent back as it was given out, it changes nothing: a form that saves what it was shown.
      const again = await api.call('PATCH', one, { notionUrl: changed.body.notionUrl });
      assert.equal(again.body.notionUrl, stored, what);
    }
  });

  it('is held to the length the server allows as it is stored, and not only as it is sent', async () => {
    const path = (length: number) => `https://x.example/${'\u{e9}'.repeat(length)}`;
    // Each of those is six characters once it is written as a browser sends it.
    assert.equal(new URL(path(1)).href.length - 'https://x.example/'.length, 6);

    const fits = await api.call('POST', '/projects', { name: 'Long', notionUrl: path(300) });
    assert.equal(fits.status, 201);
    assert.ok(fits.body.notionUrl.length <= 2000);

    // Short enough as it is typed, too long as it is stored.
    const typed = path(400);
    assert.ok(typed.length < 2000 && new URL(typed).href.length > 2000);
    const grows = await api.call('POST', '/projects', { name: 'Longer', notionUrl: typed });
    assert.equal(grows.status, 400);
    const kept = (await api.call('GET', '/projects')).body.map((p: { name: string }) => p.name);
    assert.deepEqual(kept, ['Long']);

    const tooLong = await api.call('POST', '/projects', {
      name: 'Longest',
      notionUrl: `https://x.example/${'a'.repeat(2000)}`,
    });
    assert.equal(tooLong.status, 400);
  });
});
