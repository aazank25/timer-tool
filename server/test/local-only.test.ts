import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppOptions, RunningServer } from '../src/app.js';
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
async function serve(options?: AppOptions) {
  const { createApp } = await import('../src/app.js');
  const server = createApp(options).listen(0, '127.0.0.1');
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

  it('refuses before the body is read', async () => {
    // Not JSON: were the body parser first, it would answer, with an error of its own.
    const parsed = await api.send({
      method: 'POST',
      path: '/api/projects',
      headers: { host: 'evil.com', 'content-type': 'application/json' },
      body: '{not json',
    });
    assertRefused(parsed, 'a body that is not JSON');
  });
});

describe('what every answer says about itself', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  /** The page loads from this server only, sends to it only, and is never framed. */
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  it('is on the shell, a file of the bundle, the API and a refusal alike', async () => {
    const asked: Sent[] = [
      { path: '/' },
      { path: '/projects' },
      { path: '/assets/app.js' },
      { path: '/api/settings' },
      { method: 'POST', path: '/api/projects', body: { name: 'Headers' } },
      { path: '/api/settings', headers: { host: 'evil.com' } },
      { path: '/api/settings', headers: { 'sec-fetch-site': 'cross-site' } },
      { method: 'POST', path: '/api/projects', headers: { origin: 'https://evil.com' }, body: {} },
    ];
    for (const sent of asked) {
      const what = JSON.stringify(sent);
      const res = await api.send(sent);
      assert.equal(res.headers['content-security-policy'], policy, what);
      // The old way of saying it is not to be framed, for whatever does not read the policy.
      assert.equal(res.headers['x-frame-options'], 'DENY', what);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', what);
    }
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

  it('takes a write from a page this server served, at the address it is sent to', async () => {
    // Origin and Host as a browser sends them from a page opened at that address.
    const pages = [
      { host: `127.0.0.1:${api.port}`, origin: `http://127.0.0.1:${api.port}` },
      { host: `localhost:${api.port}`, origin: `http://localhost:${api.port}` },
      { host: `[::1]:${api.port}`, origin: `http://[::1]:${api.port}` },
      { host: `localhost:${api.port}`, origin: `http://LOCALHOST:${api.port}` },
    ];
    for (const [i, headers] of pages.entries()) {
      const res = await create(`Project ${i}`, headers);
      assert.equal(res.status, 201, JSON.stringify(headers));
    }
    assert.deepEqual(await projectNames(), pages.map((_, i) => `Project ${i}`).sort());
  });

  it("refuses a write from another program's page on this computer, loopback or not", async () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://localhost',
      `http://localhost:${api.port + 1}`,
      // The right port by another name: a page at localhost, sending to 127.0.0.1.
      `http://localhost:${api.port}`,
      `http://[::1]:${api.port}`,
    ]) {
      assertRefused(await create('Taken over', { origin }), origin);
    }
    assert.deepEqual(await projectNames(), []);
  });

  it("takes the dev server's Origin against this server's own Host only while developing", async () => {
    // What a proxy that puts this server's address in the Host sends on (Vite's changeOrigin).
    // The repo's dev server passes the browser's Host on instead: see the app's own requests.
    const { config } = await import('../src/lib/config.js');
    for (const [i, origin] of config.devOrigins.entries()) {
      const res = await create(`Dev ${i}`, { origin });
      if (config.isProd) assertRefused(res, origin);
      else assert.equal(res.status, 201, origin);
    }
    assert.equal((await projectNames()).length, config.isProd ? 0 : config.devOrigins.length);
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

    // A page on another port of this machine is same-site: another program's, not the app's.
    for (const value of ['same-site', 'Same-Site', 'same-origin, same-site']) {
      assertRefused(await create('Taken over', { 'sec-fetch-site': value }), value);
    }
    assert.deepEqual(await projectNames(), []);

    // The app's own pages are same-origin; none is what a browser says for a typed address.
    for (const [i, value] of ['same-origin', 'none'].entries()) {
      const res = await create(`Project ${i}`, { 'sec-fetch-site': value });
      assert.equal(res.status, 201, value);
    }
    assert.equal((await projectNames()).length, 2);
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

});

describe('reads from other sites', () => {
  let api: Api;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  const sessions = (headers: Record<string, string>, method = 'GET', path = '/api/sessions') =>
    api.send({ method, path, headers });

  it('refuses a read of the API that the browser says another site asked for', async () => {
    // An image, a script tag or a no-cors fetch on another site's page. The page cannot read the
    // answer, but the server would do the work, and whether it loads tells the page the app is
    // there.
    for (const value of ['cross-site', 'Cross-Site', 'CROSS-SITE', 'same-origin, cross-site']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const res = await sessions({ 'sec-fetch-site': value }, method);
        // A HEAD is answered without a body, so only its status can be looked at.
        if (method === 'HEAD') assert.equal(res.status, 403, `${method} ${value}`);
        else assertRefused(res, `${method} ${value}`);
      }
    }
    // A page on another port of this computer is same-site: another program's, not the app's.
    for (const value of ['same-site', 'Same-Site', 'same-origin, same-site']) {
      assertRefused(await sessions({ 'sec-fetch-site': value }), value);
    }
    // Express routes the API in any case, so it is refused in any case.
    for (const path of ['/api', '/api/', '/api/health', '/API/sessions', '/Api/health']) {
      assertRefused(await sessions({ 'sec-fetch-site': 'cross-site' }, 'GET', path), path);
    }
  });

  it("answers a read from the app's own page, a typed address, and a client that is not a browser", async () => {
    const ours: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      {},
    ];
    for (const headers of ours) {
      const res = await sessions(headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.ok(Array.isArray(res.body), JSON.stringify(headers));
    }
  });

  it('still opens the app from a link on another site: the shell and its files are no secret', async () => {
    const link = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    for (const [path, expected] of [
      ['/', 'FocusDesk shell'],
      ['/projects', 'FocusDesk shell'],
      ['/assets/app.js', 'the client bundle'],
      // A route that only starts like the API is the app's.
      ['/apiary', 'FocusDesk shell'],
    ] as const) {
      const res = await api.send({ path, headers: link });
      assert.equal(res.status, 200, path);
      assert.ok(res.text.includes(expected), path);
    }
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
    // web/vite.config.ts proxies /api and passes on the Host the browser used, with the Origin
    // and Sec-Fetch-Site it sent to the dev page. To the browser that page is the same origin, and
    // here its Origin is the Host's, so it is the app's own page by the same rule as ours.
    for (const [i, dev] of ['localhost:5173', '127.0.0.1:5173'].entries()) {
      const headers = {
        host: dev,
        origin: `http://${dev}`,
        referer: `http://${dev}/projects`,
        'sec-fetch-site': 'same-origin',
      };
      const body = { name: `From dev ${i}` };
      const created = await api.send({ method: 'POST', path: '/api/projects', headers, body });
      assert.equal(created.status, 201, dev);
      assert.equal((await api.send({ path: '/api/projects', headers })).status, 200, dev);
    }
  });

  it(
    "are answered through a proxy that puts this server's address in the Host, while developing",
    { skip: process.env.NODE_ENV === 'production' && 'the dev server is trusted in development' },
    async () => {
      // A proxy set to change the Host to the API's own address (Vite's changeOrigin) leaves the
      // dev page's Origin against a Host it does not match. The dev server's origins are taken
      // for that while developing (config.devOrigins).
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
    },
  );

  it("need no CORS, so it lets no origin read an answer, the dev server's included", async () => {
    // In development as in production. The dev page asks its own origin, which proxies /api, so
    // a page on another origin that asks this server directly is not the app, whatever its port.
    const { config } = await import('../src/lib/config.js');
    for (const origin of [...config.devOrigins, 'http://localhost:3000', 'https://evil.com']) {
      const read = await api.send({ path: '/api/settings', headers: { origin } });
      assert.equal(read.status, 200, origin);
      assert.equal(read.headers['access-control-allow-origin'], undefined, origin);

      const preflight = await api.send({
        method: 'OPTIONS',
        path: '/api/projects',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(preflight.headers['access-control-allow-origin'], undefined, origin);
      assert.equal(preflight.headers['access-control-allow-headers'], undefined, origin);

      // And what a browser adds from such a page: another port is same-site, and refused.
      const browser = await api.send({
        path: '/api/settings',
        headers: { origin, 'sec-fetch-site': 'same-site' },
      });
      assertRefused(browser, origin);
    }
  });

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

describe('the token the server is started with', () => {
  /** Made the way the desktop app makes one: new for this run, and in no file anywhere. */
  const token = randomBytes(32).toString('base64url');
  const carrying = (value: string) => ({ 'x-focusdesk-token': value });

  let api: Api;
  /** Every answer the server gave in this block, to look for the token in. */
  const answers: Reply[] = [];

  before(async () => {
    await freshDb();
    api = await serve({ token });
  });

  beforeEach(async () => {
    await freshDb();
  });

  after(() => api.close());

  async function sent(what: Sent) {
    const res = await api.send(what);
    answers.push(res);
    return res;
  }

  /** The names of the projects, asked for with the token. */
  const projectNames = async () => {
    const { body } = await sent({ path: '/api/projects', headers: carrying(token) });
    return (body as { name: string }[]).map((project) => project.name).sort();
  };

  it('is asked of every request for the API, whatever its method, and refused without it', async () => {
    const wrong: Record<string, string>[] = [
      // None at all, or one that is empty.
      {},
      carrying(''),
      // As long as the token, and wrong in its last character only.
      carrying(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`),
      carrying(token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase()),
      // Shorter and longer: the token with one character too few or too many.
      carrying(token.slice(0, -1)),
      carrying(`${token}A`),
      carrying(token.slice(0, 16)),
      // The token in another header, or in the query, is not the token in its header.
      { authorization: `Bearer ${token}` },
      { 'x-focusdesk-tokens': token },
    ];
    const paths = ['/api/health', '/api/settings', '/api/projects', '/api', '/API/health'];
    for (const headers of wrong) {
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
        for (const path of paths) {
          const what = `${method} ${path} ${JSON.stringify(headers)}`;
          const body = method === 'POST' || method === 'PATCH' ? { name: 'Taken over' } : undefined;
          assertRefused(await sent({ method, path, headers, body }), what);
        }
      }
      // A HEAD is answered without a body, so only its status can be looked at.
      const head = await sent({ method: 'HEAD', path: '/api/health', headers });
      assert.equal(head.status, 403, `HEAD ${JSON.stringify(headers)}`);
    }
    const query = await sent({ path: `/api/settings?token=${token}` });
    assertRefused(query, 'the token in the query');
    assert.deepEqual(await projectNames(), []);
  });

  it('is refused when it is sent twice, which comes to the server as one value', async () => {
    const here = `Host: 127.0.0.1:${api.port}`;
    const twice = await api.raw(
      'GET /api/settings HTTP/1.1',
      here,
      `X-FocusDesk-Token: ${token}`,
      `X-FocusDesk-Token: ${token}`,
      'Connection: close',
    );
    answers.push(twice);
    assertRefused(twice, 'the token twice');
  });

  it('answers the app, which sends it, for reads and writes alike', async () => {
    const headers = carrying(token);
    const settings = await sent({ path: '/api/settings', headers });
    assert.equal(settings.status, 200);
    assert.equal(typeof settings.body.close_behavior, 'string');
    assert.equal((await sent({ path: '/api/health', headers })).status, 200);
    assert.equal((await sent({ method: 'HEAD', path: '/api/health', headers })).status, 200);

    const created = await sent({
      method: 'POST',
      path: '/api/projects',
      headers,
      body: { name: 'With the token' },
    });
    assert.equal(created.status, 201);
    const renamed = await sent({
      method: 'PATCH',
      path: `/api/projects/${created.body.id}`,
      headers,
      body: { name: 'Still with it' },
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await projectNames(), ['Still with it']);

    // The name of a header is not case sensitive, so neither is it here.
    const shouted = await api.raw(
      'GET /api/health HTTP/1.1',
      `Host: 127.0.0.1:${api.port}`,
      `X-FOCUSDESK-TOKEN: ${token}`,
      'Connection: close',
    );
    answers.push(shouted);
    assert.equal(shouted.status, 200);
  });

  it('is asked before the body is read', async () => {
    // Not JSON: were the body parser first, it would answer, with an error of its own.
    const res = await sent({
      method: 'POST',
      path: '/api/projects',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assertRefused(res, 'a body that is not JSON');
  });

  it('does not let anything else past the other checks', async () => {
    const headers = carrying(token);
    // Another name, another site's page, another site's write: each is still refused.
    assertRefused(
      await sent({ path: '/api/settings', headers: { ...headers, host: 'evil.com' } }),
      'Host evil.com',
    );
    const crossSite = { ...headers, 'sec-fetch-site': 'cross-site' };
    assertRefused(
      await sent({ path: '/api/sessions', headers: crossSite }),
      'a read from another site',
    );
    assertRefused(
      await sent({
        method: 'POST',
        path: '/api/projects',
        headers: { ...headers, origin: 'https://evil.com' },
        body: { name: 'Taken over' },
      }),
      'a write from another site',
    );
    assert.deepEqual(await projectNames(), []);
  });

  it('is not asked of the shell or its files, which are the same for everyone', async () => {
    for (const [path, expected] of [
      ['/', 'FocusDesk shell'],
      ['/?desktop=1', 'FocusDesk shell'],
      ['/projects', 'FocusDesk shell'],
      ['/assets/app.js', 'the client bundle'],
    ] as const) {
      const res = await sent({ path });
      assert.equal(res.status, 200, path);
      assert.ok(res.text.includes(expected), path);
    }
  });

  it('is never said back, in an answer or in a refusal', async () => {
    const headers = carrying(token);
    const asked: Sent[] = [
      { path: '/api/settings' },
      { path: '/api/settings', headers: carrying(token.slice(1)) },
      { path: `/api/settings?token=${token}` },
      { path: '/api/settings', headers },
      { path: '/api/sessions/999999', headers },
      { method: 'POST', path: '/api/projects', headers, body: { name: '' } },
      { method: 'POST', path: '/api/projects', headers, body: '{not json' },
      { path: '/api/settings', headers: { ...headers, host: 'evil.com' } },
      { path: '/api/settings', headers: { ...headers, 'sec-fetch-site': 'cross-site' } },
      { path: '/' },
    ];
    for (const what of asked) await sent(what);
    // And everything the tests above were answered.
    assert.ok(answers.length >= asked.length);
    for (const res of answers) {
      assert.ok(!res.text.includes(token), `${res.status} ${res.text.slice(0, 80)}`);
      assert.ok(!JSON.stringify(res.headers).includes(token), JSON.stringify(res.headers));
    }
  });

  it('asks for nothing when the server is started without one, or with an empty one', async () => {
    for (const [i, options] of [undefined, {}, { token: undefined }, { token: '' }].entries()) {
      const open = await serve(options);
      try {
        const what = `${i}: ${JSON.stringify(options)}`;
        assert.equal((await open.send({ path: '/api/health' })).status, 200, what);
        // Whatever a request carries is not asked about.
        const carried = await open.send({ path: '/api/settings', headers: carrying('anything') });
        assert.equal(carried.status, 200, what);
        const created = await open.send({
          method: 'POST',
          path: '/api/projects',
          body: { name: `Open ${i}` },
        });
        assert.equal(created.status, 201, what);
      } finally {
        await open.close();
      }
    }
  });

  it('will not start with a token that is not a string, rather than run with none', async () => {
    const { createApp } = await import('../src/app.js');
    for (const wrong of [null, 0, 42, true, ['a token'], { token }, Buffer.from(token)]) {
      assert.throws(
        () => createApp({ token: wrong as unknown as string }),
        TypeError,
        JSON.stringify(wrong),
      );
    }
  });

  it('is taken by startServer, as the desktop app starts the server', async () => {
    const { startServer } = await import('../src/app.js');
    const running = await startServer({ port: 0, host: '127.0.0.1', calendarSyncMs: 0, token });
    try {
      const health = (headers?: Record<string, string>) =>
        fetch(`${running.url}/api/health`, { headers });
      const refused = await health();
      assert.equal(refused.status, 403);
      assert.ok(!(await refused.text()).includes(token));
      assert.equal((await health(carrying(token))).status, 200);
      assert.equal((await health(carrying(`${token}A`))).status, 403);
      const created = await fetch(`${running.url}/api/projects`, {
        method: 'POST',
        headers: { ...carrying(token), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'From main' }),
      });
      assert.equal(created.status, 201);
      // And the shell the window loads, without it.
      assert.equal((await fetch(`${running.url}/?desktop=1`)).status, 200);
    } finally {
      await running.close();
    }
  });
});

describe('the address the server listens on', () => {
  before(async () => {
    await freshDb();
  });

  it('is loopback, and nothing else is taken', async () => {
    const { startServer } = await import('../src/app.js');
    for (const host of [
      // Every address, in either family.
      '0.0.0.0',
      '::',
      // An address on a network, and a name that is one.
      '192.168.1.5',
      '10.0.0.2',
      'example.com',
      // Loopback by a spelling the server does not answer to, or the rest of 127/8.
      '127.0.0.2',
      'LOCALHOST',
      'localhost.',
      '[::1]',
      // Which Node would take as every address.
      '',
    ]) {
      await assert.rejects(
        startServer({ port: 0, host, calendarSyncMs: 0 }),
        /^Error: FocusDesk listens on loopback only/,
        JSON.stringify(host),
      );
    }
  });

  it('is 127.0.0.1 unless it is told otherwise, and may be localhost', async () => {
    const { startServer } = await import('../src/app.js');
    for (const host of [undefined, '127.0.0.1', 'localhost']) {
      const running = await startServer({ port: 0, host, calendarSyncMs: 0 });
      try {
        if (host === undefined) assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.equal((await fetch(`${running.url}/api/health`)).status, 200, String(host));
      } finally {
        await running.close();
      }
    }
  });

  it('may be ::1, where the computer has IPv6', async () => {
    const { startServer } = await import('../src/app.js');
    try {
      const running = await startServer({ port: 0, host: '::1', calendarSyncMs: 0 });
      await running.close();
    } catch (err) {
      // Taken, and then not to be had here: not refused for being somewhere else.
      const { code } = err as NodeJS.ErrnoException;
      assert.ok(code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL', String(err));
    }
  });

  /**
   * Every server made while it is on, and what each says its address is: the real one, or what
   * `reported` makes of it. The system cannot be told to bind somewhere it should not, so it is
   * the answer that is changed, and the server really listens on 127.0.0.1. Restoring puts the
   * answer back, and shuts any server still listening, so that a start that was not refused does
   * not hold the run open.
   */
  function watchBindings(reported: (bound: AddressInfo) => unknown = (bound) => bound) {
    const servers: http.Server[] = [];
    const real = net.Server.prototype.address;
    const stub = mock.method(net.Server.prototype, 'address', function (this: http.Server) {
      if (!servers.includes(this)) servers.push(this);
      const bound = real.call(this);
      return bound !== null && typeof bound === 'object' ? reported(bound) : bound;
    });
    return {
      servers,
      restore: () => {
        stub.mock.restore();
        for (const server of servers) {
          if (!server.listening) continue;
          server.close();
          server.closeAllConnections();
        }
      },
    };
  }

  /** A resolver that answers `name` with `address`, and anything else as it always did. */
  function resolverWhere(name: string, address: string) {
    const real = dns.lookup as (...args: unknown[]) => void;
    return (hostname: string, ...rest: unknown[]) => {
      if (hostname !== name) return real(hostname, ...rest);
      // dns.lookup(hostname[, options], callback)
      const callback = rest[rest.length - 1] as (...answer: unknown[]) => void;
      const options = (rest.length > 1 ? rest[0] : {}) as dns.LookupOptions;
      const family = net.isIPv6(address) ? 6 : 4;
      process.nextTick(() =>
        options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
      );
    };
  }

  it('is checked once it is bound: localhost is only as good as the resolver that answers for it', async () => {
    // A hosts file or a resolver that puts `localhost` on 0.0.0.0 has listen() take every
    // interface, and the name is on the list of what is allowed.
    const { startServer } = await import('../src/app.js');
    const watching = watchBindings();
    const resolving = mock.method(dns, 'lookup', resolverWhere('localhost', '0.0.0.0'));
    let running: RunningServer | undefined;
    try {
      await assert.rejects(
        async () => {
          running = await startServer({ port: 0, host: 'localhost', calendarSyncMs: 0 });
        },
        /^Error: FocusDesk listens on loopback only: .*0\.0\.0\.0/,
      );
      // The server that was made is shut, not left to answer whoever finds it.
      assert.ok(watching.servers.length > 0, 'the stub did not see the server');
      for (const server of watching.servers) assert.equal(server.listening, false);
    } finally {
      resolving.mock.restore();
      await running?.close();
      watching.restore();
    }
  });

  it('takes localhost when the resolver puts it on loopback', async () => {
    const { startServer } = await import('../src/app.js');
    for (const address of ['127.0.0.1', '127.0.0.2', '::1']) {
      const resolving = mock.method(dns, 'lookup', resolverWhere('localhost', address));
      try {
        const running = await startServer({ port: 0, host: 'localhost', calendarSyncMs: 0 });
        await running.close();
      } catch (err) {
        // An address of a kind this computer has none of is not one to listen on, which is not
        // the server being kept off loopback. 127.0.0.1 is always to be had.
        const { code } = err as NodeJS.ErrnoException;
        assert.ok(
          address !== '127.0.0.1' && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL'),
          `${address}: ${err}`,
        );
      } finally {
        resolving.mock.restore();
      }
    }
  });

  it('reads the address it was bound to: all of loopback is taken, and nothing else', async () => {
    const { startServer } = await import('../src/app.js');
    const loopback = [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      '::1',
      // An IPv4 address on a socket that is IPv6, as the system writes it.
      '::ffff:127.0.0.1',
      '::ffff:127.9.9.9',
      '::ffff:7f00:1',
    ];
    const elsewhere = [
      // Every address, in either family and in the mapped spelling.
      '0.0.0.0',
      '::',
      '::ffff:0.0.0.0',
      // The addresses either side of 127/8, and ones on a network.
      '126.255.255.255',
      '128.0.0.1',
      '10.0.0.2',
      '192.168.1.5',
      '::ffff:10.0.0.2',
      '::ffff:192.168.1.5',
      // IPv6 that is not ::1, and the old IPv4-compatible spelling of 127.0.0.1.
      '::2',
      'fe80::1',
      '2001:db8::1',
      '::127.0.0.1',
      // Not an address.
      '',
      'localhost',
    ];
    const cases = [
      ...loopback.map((address) => ({ address, taken: true })),
      ...elsewhere.map((address) => ({ address, taken: false })),
    ];
    for (const { address, taken } of cases) {
      const watching = watchBindings((bound) => ({ ...bound, address }));
      let running: RunningServer | undefined;
      try {
        const start = async () => {
          running = await startServer({ port: 0, host: '127.0.0.1', calendarSyncMs: 0 });
        };
        if (taken) {
          await start();
        } else {
          await assert.rejects(start, /^Error: FocusDesk listens on loopback only/, address);
          for (const server of watching.servers) assert.equal(server.listening, false, address);
        }
      } finally {
        await running?.close();
        watching.restore();
      }
    }
  });

  it('is refused when the system gives no address to read, or one that is not a network address', async () => {
    const { startServer } = await import('../src/app.js');
    // A pipe's name, and nothing at all, as a server that is not listening answers.
    for (const answer of ['/tmp/focusdesk.sock', null]) {
      const watching = watchBindings(() => answer);
      let running: RunningServer | undefined;
      try {
        await assert.rejects(
          async () => {
            running = await startServer({ port: 0, host: '127.0.0.1', calendarSyncMs: 0 });
          },
          /^Error: FocusDesk listens on loopback only/,
          String(answer),
        );
        for (const server of watching.servers) {
          assert.equal(server.listening, false, String(answer));
        }
      } finally {
        await running?.close();
        watching.restore();
      }
    }
  });

  it('is not moved off loopback by FOCUSDESK_HOST either', () => {
    // As `npm start` and `npm run dev` start the server, in a process of its own: it says why it
    // will not start, and it never listens.
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'focusdesk-host-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FOCUSDESK_HOST: '0.0.0.0',
        FOCUSDESK_PORT: '0',
        FOCUSDESK_DATA_DIR: dir,
        FOCUSDESK_CALENDAR_SYNC_MS: '0',
      };
      // Not a test of the test runner's, whatever it is run by.
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: dirname(dirname(fileURLToPath(import.meta.url))),
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /FocusDesk listens on loopback only/);
      assert.doesNotMatch(run.stdout, /api ready/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
