import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { format } from 'node:util';
import Database from 'better-sqlite3';
import express from 'express';
import { freshDb } from './setup.js';

/**
 * What the server answers when a request goes wrong (errorMiddleware in lib/http.ts): a mistake
 * in the request is the request's status, said in a word; a fault of the server's own is a 500.
 * Neither says or logs what the request carried.
 */

interface Reply {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request with exactly these headers and this body, on a connection of its own. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, agent: false, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          const json = res.headers['content-type']?.includes('json') && text;
          resolve({ status: res.statusCode ?? 0, text, body: json ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** An app on a loopback port of its own: FocusDesk's, unless one is given. */
async function serve(app?: express.Express) {
  const { createApp } = await import('../src/app.js');
  const server = (app ?? createApp()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    send: (method: string, path: string, headers: Record<string, string>, body?: string | Buffer) =>
      send(port, method, path, headers, body),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** What was logged as an error while a test ran, written out as the console would write it. */
let logged: () => string;

beforeEach(() => {
  const error = mock.method(console, 'error', () => {});
  logged = () => error.mock.calls.map((call) => format(...call.arguments)).join('\n');
});

afterEach(() => {
  mock.restoreAll();
});

describe('a request the server cannot read', () => {
  let api: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    await freshDb();
    api = await serve();
  });

  after(() => api.close());

  const json = { 'content-type': 'application/json' };
  /** Made up for the test, to look for in what comes back and in what is logged. */
  const marker = 'hush-7f3a';

  it('is a 400 when its JSON does not parse, and its body is neither said nor logged', async () => {
    for (const body of [
      `{"x": ${marker}}`,
      `{"name": "${marker}"`,
      // Not an object or a list, which the parser refuses before it reads any further.
      `"${marker}"`,
      marker,
    ]) {
      const res = await api.send('POST', '/api/projects', json, body);
      assert.equal(res.status, 400, body);
      assert.deepEqual(res.body, { error: 'Bad Request' }, body);
    }
    assert.equal(logged(), '');
    assert.equal((await api.send('GET', '/api/projects', {})).body.length, 0);
  });

  it('is a 413 when its body is over the limit', async () => {
    const big = JSON.stringify({ name: 'Big', description: `${marker}${'x'.repeat(3_000_000)}` });
    const res = await api.send('POST', '/api/projects', json, big);
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: 'Payload Too Large' });
    assert.ok(!res.text.includes(marker));
    assert.equal(logged(), '');
  });

  it('is a 415 when its charset or its encoding is not one the server reads', async () => {
    const body = JSON.stringify({ name: marker });
    for (const headers of [
      { 'content-type': 'application/json; charset=iso-8859-1' },
      { ...json, 'content-encoding': 'br' },
    ]) {
      const res = await api.send('POST', '/api/projects', headers, body);
      assert.equal(res.status, 415, JSON.stringify(headers));
      assert.deepEqual(res.body, { error: 'Unsupported Media Type' }, JSON.stringify(headers));
    }
    assert.equal(logged(), '');
  });
});

describe('a request that names something that is not there', () => {
  it("is a 400 when SQLite's foreign keys catch it, said without SQLite's words", async () => {
    const { errorMiddleware } = await import('../src/lib/http.js');
    // A real one, from a database of the test's own.
    const conn = new Database(':memory:');
    conn.pragma('foreign_keys = ON');
    conn.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY);
               CREATE TABLE timers (project_id INTEGER REFERENCES projects(id));`);
    const app = express();
    app.post('/timers', () => {
      conn.prepare('INSERT INTO timers (project_id) VALUES (?)').run(99999);
    });
    app.use(errorMiddleware);
    const api = await serve(app);
    try {
      const res = await api.send('POST', '/timers', {});
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'That refers to something that does not exist' });
      assert.doesNotMatch(res.text, /FOREIGN KEY|constraint|timers|projects/i);
      assert.equal(logged(), '');
    } finally {
      await api.close();
      conn.close();
    }
  });

  it('is a 400 from a route that writes the reference without looking first', async () => {
    await freshDb();
    const api = await serve();
    try {
      const res = await api.send(
        'POST',
        '/api/timers',
        { 'content-type': 'application/json' },
        JSON.stringify({ projectId: 99999, title: 'Pinned', plannedMinutes: 25 }),
      );
      assert.equal(res.status, 400);
      assert.equal(typeof res.body.error, 'string');
      assert.deepEqual((await api.send('GET', '/api/timers', {})).body, []);
    } finally {
      await api.close();
    }
  });
});

describe('a fault of the server', () => {
  it('is still a 500, logged by where it came from and not by what it carried', async () => {
    const { errorMiddleware } = await import('../src/lib/http.js');
    const app = express();
    app.get('/fault', () => {
      // As the body parser's errors carry the body: something the log is not to have.
      throw Object.assign(new Error('Something broke'), { body: 'hush-7f3a', status: 'odd' });
    });
    app.get('/unavailable', () => {
      // A status, but not one that makes it the request's fault.
      throw Object.assign(new Error('Out of reach'), { status: 503 });
    });
    app.use(errorMiddleware);
    const api = await serve(app);
    try {
      const fault = await api.send('GET', '/fault', {});
      assert.equal(fault.status, 500);
      assert.deepEqual(fault.body, { error: 'Internal error', details: 'Something broke' });
      const unavailable = await api.send('GET', '/unavailable', {});
      assert.equal(unavailable.status, 500);

      const log = logged();
      assert.match(log, /^\[error\] Error: Something broke\n\s+at /);
      assert.match(log, /Out of reach/);
      assert.ok(!log.includes('hush-7f3a'), log);
    } finally {
      await api.close();
    }
  });
});
