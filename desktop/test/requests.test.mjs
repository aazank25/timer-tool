import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rereadAfter } from '../requests.mjs';

const SERVER = 'http://127.0.0.1:41234';
const NOTHING = { settings: false, live: false };
const SETTINGS = { settings: true, live: false };
const LIVE = { settings: false, live: true };

const after = (method, path, statusCode = 200, origin = SERVER) =>
  rereadAfter({ method, statusCode, url: `${origin}${path}` }, SERVER);

describe('what a finished request means for the menu bar', () => {
  it('is that the settings may have changed, for a save of them', () => {
    assert.deepEqual(after('PATCH', '/api/settings'), SETTINGS);
    assert.deepEqual(after('PATCH', '/api/settings', 204), SETTINGS);
  });

  it('is that the block on the clock may have changed, for anything done to a block', () => {
    assert.deepEqual(after('POST', '/api/sessions', 201), LIVE);
    assert.deepEqual(after('POST', '/api/sessions/12/pause'), LIVE);
    assert.deepEqual(after('POST', '/api/sessions/12/resume'), LIVE);
    assert.deepEqual(after('POST', '/api/sessions/12/complete'), LIVE);
    assert.deepEqual(after('POST', '/api/sessions/switch', 201), LIVE);
    assert.deepEqual(after('PATCH', '/api/sessions/12'), LIVE);
    assert.deepEqual(after('DELETE', '/api/sessions/12', 204), LIVE);
  });

  it('is the same for answering a question, which can pause or resume a block', () => {
    assert.deepEqual(after('POST', '/api/prompts/act'), LIVE);
  });

  it('is nothing for a request that only reads, whichever way it is written', () => {
    assert.deepEqual(after('GET', '/api/sessions/active'), NOTHING);
    assert.deepEqual(after('GET', '/api/settings'), NOTHING);
    assert.deepEqual(after('GET', '/api/prompts'), NOTHING);
    assert.deepEqual(after('get', '/api/sessions'), NOTHING);
    assert.deepEqual(after('HEAD', '/api/sessions'), NOTHING);
    assert.deepEqual(after('OPTIONS', '/api/sessions'), NOTHING);
  });

  it('is nothing for a request that was refused, which changed nothing', () => {
    for (const statusCode of [400, 404, 409, 500]) {
      assert.deepEqual(after('POST', '/api/sessions/12/pause', statusCode), NOTHING, String(statusCode));
      assert.deepEqual(after('PATCH', '/api/settings', statusCode), NOTHING, String(statusCode));
    }
    assert.deepEqual(rereadAfter({ method: 'POST', url: `${SERVER}/api/sessions` }, SERVER), NOTHING);
  });

  it('is nothing for the rest of the API: tasks, projects, the plan, the calendar', () => {
    for (const path of ['/api/tasks', '/api/tasks/3', '/api/projects', '/api/plan', '/api/timers', '/api/calendar/sync', '/api/wrapup/day/2026-10-12/done', '/api/health']) {
      assert.deepEqual(after('POST', path), NOTHING, path);
    }
  });

  it('goes by whole path segments, with or without a query, and not by how a path begins', () => {
    assert.deepEqual(after('POST', '/api/sessionsX'), NOTHING);
    assert.deepEqual(after('POST', '/api/sessions-old/1'), NOTHING);
    assert.deepEqual(after('PATCH', '/api/settingsX'), NOTHING);
    assert.deepEqual(after('POST', '/x/api/sessions'), NOTHING);
    assert.deepEqual(after('POST', '/api/sessions?x=1'), LIVE);
    assert.deepEqual(after('PATCH', '/api/settings?x=1'), SETTINGS);
  });

  it('is nothing for a request to anything but the app’s own server', () => {
    assert.deepEqual(after('POST', '/api/sessions', 200, 'http://127.0.0.1:41235'), NOTHING);
    assert.deepEqual(after('POST', '/api/sessions', 200, 'http://localhost:41234'), NOTHING);
    assert.deepEqual(after('POST', '/api/sessions', 200, 'https://example.com'), NOTHING);
    assert.deepEqual(
      rereadAfter({ method: 'POST', statusCode: 200, url: 'http://127.0.0.1:41234@elsewhere.example/api/sessions' }, SERVER),
      NOTHING,
    );
  });

  it('is nothing, and no error, for details that are not there or an address that does not parse', () => {
    assert.deepEqual(rereadAfter(undefined, SERVER), NOTHING);
    assert.deepEqual(rereadAfter(null, SERVER), NOTHING);
    assert.deepEqual(rereadAfter({}, SERVER), NOTHING);
    assert.deepEqual(rereadAfter({ method: 'POST', statusCode: 200, url: 'not a url' }, SERVER), NOTHING);
    assert.deepEqual(rereadAfter({ method: 'POST', statusCode: 200 }, SERVER), NOTHING);
  });
});
