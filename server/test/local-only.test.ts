import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { freshDb } from './setup.js';

/**
 * The server answers only the app itself (lib/local-only.ts): a request has to be addressed to a
 * loopback name, and a write must not come from a page of another site. Everything here is sent
 * with node:http or a raw socket, because fetch will not set the Host or the Origin that a page
 * on another site, or a DNS rebinding attack, would send.
 */

const dbMod = () => import('../src/db.js');

/**
 * A built client for the server to serve, so that the shell and the files of the bundle are
 * covered as well as the API. Set before anything imports config.ts, which reads it once.
 */
const webDist = fs.mkdtempSync(join(os.tmpdir(), 'focusdesk-web-'));
fs.mkdirSync(join(webDist, 'assets'));
fs.writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>FocusDesk shell</title>');
fs.writeFileSync(join(webDist, 'assets', 'app.js'), 'export const bundle = "the client bundle";');
process.env.FOCUSDESK_WEB_DIST = webDist;
after(() => fs.rmSync(webDist, { recursive: true, force: true }));

interface Sent {
  method?: string;
  path?: string;
  /** Set exactly as given, the Host and the Origin included. Names in lower case. */
  headers?: Record<string, string>;
  /** Sent as JSON, unless it is a string already. */
  body?: unknown;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function reply(status: number, headers: http.IncomingHttpHeaders, text: string): Reply {
  const json = headers['content-type']?.includes('json') && text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, headers, text, body: (json ? JSON.parse(text) : undefined) as any };
}

/** One request, with the headers as given. GET /api/settings from this machine, unless told. */
function send(
  port: number,
  { method = 'GET', path = '/api/settings', headers = {}, body }: Sent = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
    const json = typeof body === 'object' ? { 'content-type': 'application/json' } : {};
    const req = http.request(
      // A connection of its own, so that none is left open for the server's close to wait on.
      { host: '127.0.0.1', port, method, path, agent: false, headers: { ...json, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve(reply(res.statusCode ?? 0, res.headers, text)));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Exactly these lines and nothing else, for what http.request will not write: a request line
 * that is not a path, no Host, an empty one, two. Reads the answer until the server hangs up.
 */
function raw(port: number, lines: string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let received = '';
    socket.setEncoding('utf8');
    // A server that does not hang up fails the test, rather than leaving it to wait for ever.
    socket.setTimeout(5_000, () => socket.destroy(new Error('the server did not hang up')));
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const end = received.indexOf('\r\n\r\n');
      const [statusLine = '', ...headerLines] = received
        .slice(0, end < 0 ? undefined : end)
        .split('\r\n');
      const headers = Object.fromEntries(
        headerLines.map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }),
      );
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      resolve(reply(status, headers, end < 0 ? '' : received.slice(end + 4)));
    });
  });
}

/** The API and the client bundle on a loopback port of its own, as every other test serves it. */
async function serve() {
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    send: (sent?: Sent) => send(port, sent),
    raw: (...lines: string[]) => raw(port, lines),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

type Api = Awaited<ReturnType<typeof serve>>;

/**
 * What a refusal is: a 403 that is JSON in the shape of every other error the app answers with,
 * and carries nothing that was asked for (close_behavior is one of the settings).
 */
function assertRefused(res: Reply, what: string) {
  assert.equal(res.status, 403, what);
  assert.match(res.headers['content-type'] ?? '', /^application\/json/, what);
  assert.deepEqual(Object.keys(res.body), ['error'], what);
  assert.equal(typeof res.body.error, 'string', what);
  assert.ok(!res.text.includes('close_behavior'), what);
}

describe('the Host a request is addressed to', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  const settings = (host: string) => api.send({ headers: { host } });

  it('answers 127.0.0.1, localhost and [::1], in any case, on any port or none', async () => {
    for (const host of [
      `127.0.0.1:${api.port}`,
      `localhost:${api.port}`,
      `[::1]:${api.port}`,
      `LOCALHOST:${api.port}`,
      // Only the name matters: the port need not be the server's, or be there at all.
      'LocalHost',
      'localhost:5173',
      '127.0.0.1:80',
      '127.0.0.1',
      '[::1]:65535',
      '[::1]',
    ]) {
      const res = await settings(host);
      assert.equal(res.status, 200, host);
      assert.equal(typeof res.body.close_behavior, 'string', host);
    }
  });

  it("refuses any other name with a 403 in the app's own error shape, and serves nothing", async () => {
    // An error the app already makes, to be the same shape as.
    const known = await api.send({ path: '/api/sessions/999999' });
    assert.equal(known.status, 404);
    assert.deepEqual(known.body, { error: 'Session not found' });

    for (const host of [
      'evil.com',
      `evil.com:${api.port}`,
      '127.0.0.1.evil.com',
      `127.0.0.1.evil.com:${api.port}`,
      'localhost.evil.com',
      `localhost.evil.com:${api.port}`,
      // Another name beside ours, or one that only starts or ends like it.
      'notlocalhost',
      'localhost-evil.com',
      'app.localhost',
      // A name dressed as a login, a path, a list.
      'localhost@evil.com',
      'evil.com@localhost',
      `localhost:${api.port}@evil.com`,
      'evil.com/localhost',
      'localhost, evil.com',
      'localhost evil.com',
    ]) {
      const res = await settings(host);
      assertRefused(res, host);
      assert.deepEqual(Object.keys(res.body), Object.keys(known.body), host);
    }
  });

  it('does not take the other spellings of loopback for loopback', async () => {
    for (const host of [
      // A trailing dot: the same name to a resolver, and not one anyone opens the app at.
      'localhost.',
      `localhost.:${api.port}`,
      // Other ways to write 127.0.0.1. A browser rewrites them before it sends anything, so
      // only a client that is not a browser would send these.
      '127.1',
      `127.1:${api.port}`,
      '2130706433',
      '0x7f.0.0.1',
      '0177.0.0.1',
      // The rest of 127/8, which the server does not listen on.
      '127.0.0.2',
      `127.0.0.2:${api.port}`,
      '127.255.255.254',
      // Which most systems send to this computer, and which browsers have let pages reach local
      // servers by.
      '0.0.0.0',
      `0.0.0.0:${api.port}`,
      // IPv6 any way but [::1].
      '::1',
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::2]',
      '[::1',
      '::1]',
      // A port that is not one.
      'localhost:',
      'localhost:http',
      'localhost:99999',
      'localhost:-1',
      'localhost:1e3',
      'localhost:80:80',
      'localhost: 80',
    ]) {
      assertRefused(await settings(host), host);
    }
  });

  it('refuses a request with no Host, an empty one, or more than one', async () => {
    const line = 'GET /api/settings HTTP/1.1';
    const ours = `Host: 127.0.0.1:${api.port}`;
    const cases: [string, string[]][] = [
      // HTTP/1.0 need not say where it is going, and Node lets it through to the app without.
      ['HTTP/1.0 and no Host', ['GET /api/settings HTTP/1.0']],
      ['an empty Host', [line, 'Host:', 'Connection: close']],
      // Node keeps the first of two, so which is first must not matter, nor whether they agree.
      ['two Hosts, ours first', [line, ours, 'Host: evil.com', 'Connection: close']],
      ['two Hosts, ours last', [line, 'Host: evil.com', ours, 'Connection: close']],
      ['the same Host twice', [line, ours, ours, 'Connection: close']],
    ];
    for (const [what, lines] of cases) assertRefused(await api.raw(...lines), what);
  });

  it('never has a Host-less HTTP/1.1 request reach the app: Node turns it away first', async () => {
    const res = await api.raw('GET /api/settings HTTP/1.1', 'Connection: close');
    assert.equal(res.status, 400);
    assert.ok(!res.text.includes('close_behavior'));
  });

  it('does not let a request line that names another site past a Host of 127.0.0.1', async () => {
    // Node hands the request line over as it came, so req.url is the whole address, and Express
    // routes on the path inside it and leaves Host as sent. Answered by the Host alone, this
    // would be a request for evil.com served as one for the app.
    const here = `127.0.0.1:${api.port}`;
    const cases: [string, string[]][] = [
      ['evil.com in the line', ['GET http://evil.com/api/settings HTTP/1.1', `Host: ${here}`]],
      [
        'evil.com and our port',
        [`GET http://evil.com:${api.port}/api/settings HTTP/1.1`, `Host: ${here}`],
      ],
      ['evil.com in the Host', [`GET http://${here}/api/settings HTTP/1.1`, 'Host: evil.com']],
      // Our own address both times is not what a client says to the server it is talking to
      // either, so it is not answered: a plain path is the only form there is.
      ['our address in both', [`GET http://${here}/api/settings HTTP/1.1`, `Host: ${here}`]],
      ['localhost in both', ['GET http://localhost/api/settings HTTP/1.1', 'Host: localhost']],
      ['no path at all', ['OPTIONS * HTTP/1.1', `Host: ${here}`]],
    ];
    for (const [what, lines] of cases) {
      assertRefused(await api.raw(...lines, 'Connection: close'), what);
    }
  });

  it('refuses a write that a page reaching the server by rebinding sends as its own', async () => {
    // The page's origin is its own name, now pointed at 127.0.0.1, so to the browser the request
    // is same-origin: it says so, and carries that name as the Host and as the Origin.
    const name = `rebind.evil.com:${api.port}`;
    const res = await api.send({
      method: 'POST',
      path: '/api/projects',
      headers: { host: name, origin: `http://${name}`, 'sec-fetch-site': 'same-origin' },
      body: { name: 'Taken over' },
    });
    assertRefused(res, name);
    assert.deepEqual((await api.send({ path: '/api/projects' })).body, []);
  });

  it('refuses before the body is read and before CORS answers', async () => {
    // Not JSON: were the body parser first, it would answer, with an error of its own.
    const parsed = await api.send({
      method: 'POST',
      path: '/api/projects',
      headers: { host: 'evil.com', 'content-type': 'application/json' },
      body: '{not json',
    });
    assertRefused(parsed, 'a body that is not JSON');

    // A dev origin that CORS would have named in its answer, and does not in the refusal.
    const cors = await api.send({ headers: { host: 'evil.com', origin: 'http://localhost:5173' } });
    assertRefused(cors, 'a dev origin');
    assert.equal(cors.headers['access-control-allow-origin'], undefined);
  });
});

describe('the client bundle', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  it('is served to the app itself: the shell, a file of it, and the shell for a route', async () => {
    for (const [path, expected] of [
      ['/', 'FocusDesk shell'],
      ['/assets/app.js', 'the client bundle'],
      ['/projects', 'FocusDesk shell'],
    ] as const) {
      const res = await api.send({ path });
      assert.equal(res.status, 200, path);
      assert.ok(res.text.includes(expected), path);
    }
  });

  it('is not served to a request for any other name: not the shell, and not a file of it', async () => {
    for (const host of ['evil.com', `127.0.0.1.evil.com:${api.port}`, 'localhost.', '0.0.0.0']) {
      for (const path of ['/', '/projects', '/assets/app.js', '/index.html']) {
        const res = await api.send({ path, headers: { host } });
        assertRefused(res, `${host} ${path}`);
        assert.ok(!/FocusDesk shell|the client bundle/.test(res.text), `${host} ${path}`);
      }
    }
  });
});

describe('writes from other sites', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  beforeEach(async () => {
    await freshDb();
  });

  after(() => api.close());

  const create = (name: string, headers: Record<string, string> = {}) =>
    api.send({ method: 'POST', path: '/api/projects', headers, body: { name } });

  /** The names of the projects, by the API, as the person would see them. */
  const projectNames = async () => {
    const { body } = await api.send({ path: '/api/projects' });
    return (body as { name: string }[]).map((project) => project.name).sort();
  };

  /** A block as it is stored: every column, and every one of its segments. */
  async function storedBlock(id: number) {
    const { db } = await dbMod();
    return {
      block: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
      segments: db
        .prepare('SELECT * FROM session_segments WHERE session_id = ? ORDER BY id')
        .all(id),
    };
  }

  it('refuses a POST that says it is from another site, and writes nothing', async () => {
    const res = await create('Taken over', { origin: 'https://evil.com' });
    assertRefused(res, 'https://evil.com');
    assert.deepEqual(await projectNames(), []);

    // The same request, from the app: it was the Origin that was refused, not the request.
    assert.equal((await create('Kept')).status, 201);
    assert.deepEqual(await projectNames(), ['Kept']);
  });

  it('refuses an Origin that is not plain http on a loopback name, and writes nothing', async () => {
    for (const origin of [
      'https://evil.com',
      'http://evil.com',
      'http://evil.com:5173',
      // What a page with no origin of its own sends.
      'null',
      // Names that only start like ours.
      'http://127.0.0.1.evil.com',
      'http://localhost.evil.com',
      'http://localhost.evil.com:5173',
      'http://localhost@evil.com',
      'http://evil.com@localhost',
      'http://localhost:5173@evil.com',
      // Our names, but not over plain http.
      'https://localhost:5173',
      `https://127.0.0.1:${api.port}`,
      'file://',
      'app://localhost',
      // Our names, but not as a browser writes an origin: a path, no scheme, a dot, a spelling.
      'http://localhost:5173/',
      'http://localhost:5173/path',
      'localhost:5173',
      '//localhost',
      'http://localhost.',
      'http://127.1',
      'http://127.0.0.2',
      'http://0.0.0.0:5173',
      'http://[::1',
      // Two Origin lines come to the server as one, joined with a comma.
      'http://localhost:5173, https://evil.com',
      '',
    ]) {
      assertRefused(await create('Taken over', { origin }), JSON.stringify(origin));
    }
    assert.deepEqual(await projectNames(), []);
  });

  it('takes a write whose Origin is a loopback http address, on any port', async () => {
    const origins = [
      `http://127.0.0.1:${api.port}`,
      `http://localhost:${api.port}`,
      `http://[::1]:${api.port}`,
      // The Vite dev server, opened by either name (config.devOrigins), and any other port.
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://localhost',
      'http://LOCALHOST:5173',
    ];
    for (const [i, origin] of origins.entries()) {
      const res = await create(`Project ${i}`, { origin });
      assert.equal(res.status, 201, origin);
    }
    assert.deepEqual(await projectNames(), origins.map((_, i) => `Project ${i}`).sort());
  });

  it('takes a write with no Origin at all, as Node clients send it', async () => {
    assert.equal((await create('Plain')).status, 201);
    assert.deepEqual(await projectNames(), ['Plain']);
  });

  it('refuses Sec-Fetch-Site: cross-site whatever else is said, and takes the rest', async () => {
    const crossSite: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'Cross-Site' },
      { 'sec-fetch-site': 'same-origin, cross-site' },
      // A loopback Origin does not make up for it.
      { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' },
      { origin: `http://127.0.0.1:${api.port}`, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of crossSite) {
      assertRefused(await create('Taken over', headers), JSON.stringify(headers));
    }
    assert.deepEqual(await projectNames(), []);

    // A page on another port of this machine is same-site, and the app's own is same-origin.
    for (const [i, value] of ['same-origin', 'same-site', 'none'].entries()) {
      const res = await create(`Project ${i}`, { 'sec-fetch-site': value });
      assert.equal(res.status, 201, value);
    }
    assert.equal((await projectNames()).length, 3);
  });

  it('refuses a write that has no body to refuse, and leaves the block as it was', async () => {
    const started = await api.send({
      method: 'POST',
      path: '/api/sessions',
      body: { title: 'Deep work' },
    });
    const live = started.body;
    assert.equal(live.status, 'running');
    const before = await storedBlock(live.id);

    // Nothing here has a body, or one that the server would read: this is what a form on another
    // site can send, and a route that takes no body needs nothing more than its address.
    const forms: Pick<Sent, 'headers' | 'body'>[] = [
      { headers: { origin: 'https://evil.com' } },
      { headers: { origin: 'null' } },
      { headers: { 'sec-fetch-site': 'cross-site' } },
      {
        headers: { origin: 'https://evil.com', 'content-type': 'text/plain' },
        body: 'a plain text body',
      },
      {
        headers: {
          origin: 'https://evil.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'a=b',
      },
    ];
    for (const action of ['pause', 'complete', 'abandon']) {
      for (const form of forms) {
        const what = `${action} ${JSON.stringify(form)}`;
        const path = `/api/sessions/${live.id}/${action}`;
        assertRefused(await api.send({ method: 'POST', path, ...form }), what);
        assert.deepEqual(await storedBlock(live.id), before, what);
      }
    }
    assert.equal((await api.send({ path: `/api/sessions/${live.id}` })).body.status, 'running');

    // From the app's own page the same request goes through, so it was the Origin that stopped it.
    const paused = await api.send({
      method: 'POST',
      path: `/api/sessions/${live.id}/pause`,
      headers: { origin: `http://127.0.0.1:${api.port}` },
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
  });

  it('refuses a PATCH, a DELETE or a PUT from another site as well, and changes nothing', async () => {
    const project = (await create('Keep me')).body;
    const evil = { origin: 'https://evil.com' };
    const one = `/api/projects/${project.id}`;

    const patch = await api.send({
      method: 'PATCH',
      path: one,
      headers: evil,
      body: { name: 'Taken over' },
    });
    assertRefused(patch, 'PATCH');
    const hard = await api.send({ method: 'DELETE', path: `${one}?hard=true`, headers: evil });
    assertRefused(hard, 'DELETE');
    // Refused before it is routed, so a path that is nowhere is a 403 and not a 404.
    const put = await api.send({ method: 'PUT', path: '/api/nowhere', headers: evil, body: {} });
    assertRefused(put, 'PUT');

    assert.deepEqual(await projectNames(), ['Keep me']);
  });

  it('does not ask a read where it came from: CORS has that, and the Host check', async () => {
    const foreign = { origin: 'https://evil.com', 'sec-fetch-site': 'cross-site' };

    const get = await api.send({ headers: foreign });
    assert.equal(get.status, 200);
    // Not let in by CORS either, which is what stops a page from reading the answer.
    assert.equal(get.headers['access-control-allow-origin'], undefined);
    assert.equal((await api.send({ method: 'HEAD', headers: foreign })).status, 200);
    const preflight = await api.send({
      method: 'OPTIONS',
      path: '/api/projects',
      headers: foreign,
    });
    assert.notEqual(preflight.status, 403);
  });
});

describe("the app's own requests", () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  beforeEach(async () => {
    await freshDb();
  });

  after(() => api.close());

  it('are answered from the page the server itself serves, in a browser or a window', async () => {
    // What Chromium sends for fetch('/api/projects', { method: 'POST' }) from the page at
    // http://127.0.0.1:PORT/projects, which is how web/src/api.ts calls the server.
    const origin = `http://127.0.0.1:${api.port}`;
    const headers = {
      host: `127.0.0.1:${api.port}`,
      origin,
      referer: `${origin}/projects`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    };
    const body = { name: 'From the page' };
    const created = await api.send({ method: 'POST', path: '/api/projects', headers, body });
    assert.equal(created.status, 201);
    assert.equal((await api.send({ path: '/api/projects', headers })).status, 200);
  });

  it('are answered through the Vite dev server, which proxies /api', async () => {
    // web/vite.config.ts proxies /api with changeOrigin, which rewrites the Host to the API's own
    // address. The Origin and Sec-Fetch-Site that the browser sent to the dev page go through as
    // they were, and to the browser that page is the same origin.
    const headers = {
      host: `127.0.0.1:${api.port}`,
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/projects',
      'sec-fetch-site': 'same-origin',
    };
    const body = { name: 'From dev' };
    const created = await api.send({ method: 'POST', path: '/api/projects', headers, body });
    assert.equal(created.status, 201);
    assert.equal((await api.send({ path: '/api/projects', headers })).status, 200);
  });

  it(
    'are answered when the dev origin asks CORS first',
    { skip: process.env.NODE_ENV === 'production' && 'CORS is not mounted in production' },
    async () => {
      const origin = 'http://localhost:5173';
      const preflight = await api.send({
        method: 'OPTIONS',
        path: '/api/projects',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], origin);
    },
  );

  it('are answered when they come from Node, as the desktop main process sends them', async () => {
    // apiJson in desktop/main.mjs: Node's fetch to the address startServer gives back. It sends
    // no Origin and no Sec-Fetch-Site, and the menu bar's pause is a write with no body.
    const { startServer } = await import('../src/app.js');
    const running = await startServer({ port: 0, host: '127.0.0.1', calendarSyncMs: 0 });
    try {
      const post = (path: string, body?: unknown) =>
        fetch(`${running.url}/api${path}`, {
          method: 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      assert.equal((await post('/projects', { name: 'From main' })).status, 201);
      const started = await post('/sessions', { title: 'Deep work' });
      assert.equal(started.status, 201);
      const { id } = (await started.json()) as { id: number };

      assert.equal((await post(`/sessions/${id}/pause`)).status, 200);
      assert.equal((await post(`/sessions/${id}/resume`)).status, 200);
      assert.equal((await fetch(`${running.url}/api/health`)).status, 200);
      assert.equal((await fetch(`${running.url}/api/settings`)).status, 200);
      // And the shell the window loads, with the query the desktop app puts on it.
      assert.equal((await fetch(`${running.url}/?desktop=1`)).status, 200);
    } finally {
      await running.close();
    }
  });
});
