import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  keepToServer,
  mayLoad,
  newToken,
  openOutside,
  permitted,
  sendWith,
  TOKEN_HEADER,
} from '../privacy.mjs';

const SERVER = 'http://127.0.0.1:41234';
const TOKEN = 'k3y-0f-th1s-launch_aaaaaaaaaaaaaaaaaaaaaaaaa';

/** Addresses that are not the app's server, however much they look like it. */
const ELSEWHERE = [
  'http://127.0.0.1:41235/api/settings',
  'http://127.0.0.1:4123/api/settings',
  'http://localhost:41234/api/settings',
  'http://[::1]:41234/api/settings',
  'https://127.0.0.1:41234/api/settings',
  'ws://127.0.0.1:41234/api/settings',
  'http://127.0.0.1:41234@elsewhere.example/api/settings',
  'http://elsewhere.example/http://127.0.0.1:41234/api/settings',
  'http://127.0.0.1.elsewhere.example:41234/api/settings',
  'https://example.com/',
];

/** Every permission Electron 38 asks a session's handlers about, by the name it gives them. */
const ELECTRON_PERMISSIONS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'keyboardLock',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'unknown',
  'usb',
  'window-management',
];
const ALLOWED = ['notifications', 'clipboard-sanitized-write'];

describe('the key to the server', () => {
  it('is 32 random bytes, written as 43 characters that can go in a header', () => {
    const token = newToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
  });

  it('is a different one each time, so no two launches share one', () => {
    const made = new Set(Array.from({ length: 200 }, () => newToken()));
    assert.equal(made.size, 200);
  });

  it('goes in the header the server reads, x-focusdesk-token', () => {
    assert.equal(TOKEN_HEADER, 'x-focusdesk-token');
  });
});

describe('what a request from a window is sent with', () => {
  const send = (url, requestHeaders) => sendWith({ url, requestHeaders }, SERVER, TOKEN);

  it('is the key, for a request to the app’s own server, page or API, on top of what the page sent', () => {
    assert.deepEqual(send(`${SERVER}/api/settings`, { Accept: 'application/json' }), {
      requestHeaders: { Accept: 'application/json', [TOKEN_HEADER]: TOKEN },
    });
    assert.deepEqual(send(`${SERVER}/?desktop=1`, {}), { requestHeaders: { [TOKEN_HEADER]: TOKEN } });
    assert.deepEqual(send(`${SERVER}/api/sessions?x=1#y`, undefined), {
      requestHeaders: { [TOKEN_HEADER]: TOKEN },
    });
    assert.deepEqual(send(`http://user:pass@127.0.0.1:41234/api/health`, {}), {
      requestHeaders: { [TOKEN_HEADER]: TOKEN },
    });
  });

  it('is the real key, however a page has spelled a header of that name: it cannot choose one', () => {
    const sent = send(`${SERVER}/api/settings`, {
      'X-FocusDesk-Token': 'made up',
      'x-focusdesk-token': 'made up too',
      'X-FOCUSDESK-TOKEN': 'and this',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(sent, {
      requestHeaders: { 'Content-Type': 'application/json', [TOKEN_HEADER]: TOKEN },
    });
  });

  it('is nothing more, and nothing changed, for a request to anywhere else, however much it looks like the server', () => {
    for (const url of ELSEWHERE) {
      const sent = send(url, { Accept: '*/*', Referer: `${SERVER}/` });
      // No headers in the answer: Electron sends the request as the page made it.
      assert.deepEqual(sent, {}, url);
      assert.ok(!JSON.stringify(sent).includes(TOKEN), url);
    }
  });

  it('is nothing more, and no error, for details that are not there or an address that does not parse', () => {
    assert.deepEqual(sendWith(undefined, SERVER, TOKEN), {});
    assert.deepEqual(sendWith(null, SERVER, TOKEN), {});
    assert.deepEqual(sendWith({}, SERVER, TOKEN), {});
    assert.deepEqual(send('not an address', { a: 'b' }), {});
    assert.deepEqual(send('', {}), {});
  });
});

describe('what a window may load', () => {
  it('is anything on the app’s own server', () => {
    for (const url of [
      `${SERVER}/`,
      SERVER,
      `${SERVER}/?desktop=1`,
      `${SERVER}/assets/index-abc.js`,
      `${SERVER}/api/sessions/active`,
    ]) {
      assert.equal(mayLoad(url, SERVER), true, url);
    }
  });

  it('is what a page makes itself and the developer tools’ own pages', () => {
    for (const url of [
      'data:image/png;base64,iVBORw0KGgo=',
      `blob:${SERVER}/0b1c2d3e-0000-4000-8000-000000000000`,
      'devtools://devtools/bundled/devtools_app.html',
      'chrome-extension://abcdefghijklmnop/manifest.json',
    ]) {
      assert.equal(mayLoad(url, SERVER), true, url);
    }
  });

  it('is nothing else: not another port, host or scheme, nor anything that only looks like the server', () => {
    for (const url of ELSEWHERE) assert.equal(mayLoad(url, SERVER), false, url);
  });

  it('is nothing from the disk or the browser’s own pages, and nothing that does not parse', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://gpu',
      'about:blank',
      'javascript:alert(1)',
      'ftp://example.com/x',
      'smb://203.0.113.5/share',
      'not an address',
      '',
      undefined,
    ]) {
      assert.equal(mayLoad(url, SERVER), false, String(url));
    }
  });
});

describe('what a page may be allowed', () => {
  it('is to show notifications and to write to the clipboard, for a page of the app, by its address or its origin', () => {
    const pages = [`${SERVER}/settings?desktop=1`, `${SERVER}/`, SERVER, `${SERVER}/palette?desktop=1`];
    for (const permission of ALLOWED) {
      for (const at of pages) {
        assert.equal(permitted(permission, at, SERVER), true, `${permission} at ${at}`);
      }
    }
  });

  it('is nothing else, even for a page of the app', () => {
    for (const permission of ELECTRON_PERMISSIONS.filter((p) => !ALLOWED.includes(p))) {
      assert.equal(permitted(permission, `${SERVER}/`, SERVER), false, permission);
    }
    assert.equal(permitted('Notifications', `${SERVER}/`, SERVER), false);
    assert.equal(permitted(undefined, `${SERVER}/`, SERVER), false);
  });

  it('is not even those, for a page anywhere else or one that has no address of its own', () => {
    const pages = [...ELSEWHERE, 'devtools://devtools/', 'data:text/html,x', 'about:blank', 'null', ''];
    for (const permission of ALLOWED) {
      for (const at of [...pages, undefined]) {
        assert.equal(permitted(permission, at, SERVER), false, `${permission} at ${at}`);
      }
    }
  });
});

describe('opening a link outside the app', () => {
  /** Electron's shell, as far as this goes: what it was asked to open. */
  function world({ fails = false } = {}) {
    const opened = [];
    const warned = [];
    const shell = {
      openExternal: (url) => {
        opened.push(url);
        return fails ? Promise.reject(new Error(`no program for ${url}`)) : Promise.resolve();
      },
    };
    return { opened, warned, deps: { shell, warn: (...args) => warned.push(args.join(' ')) } };
  }

  it('hands a web page to the system, as it was read', () => {
    const { opened, warned, deps } = world();
    assert.equal(openOutside('https://www.notion.so/Page-123?pvs=4#top', deps), true);
    assert.equal(openOutside('http://example.com/a b', deps), true);
    assert.equal(openOutside('HTTPS://EXAMPLE.COM/Path', deps), true);
    assert.deepEqual(opened, [
      'https://www.notion.so/Page-123?pvs=4#top',
      'http://example.com/a%20b',
      'https://example.com/Path',
    ]);
    assert.deepEqual(warned, []);
  });

  it('does not open an email address: the app has no such link, and the mail program acts on what follows the ?', () => {
    const { opened, warned, deps } = world();
    for (const url of [
      'mailto:someone@example.com',
      'mailto:someone@example.com?subject=Hi',
      // What the system's mail command reads as a file to attach, on some systems.
      'mailto:?attach=/etc/passwd',
      'mailto:someone@example.com?attach=/Users/Shared/notes.txt&subject=Hi',
      'MAILTO:someone@example.com',
      ' mailto:someone@example.com',
      'mail\tto:someone@example.com',
    ]) {
      assert.equal(openOutside(url, deps), false, url);
    }
    assert.deepEqual(opened, []);
    // The scheme is said, and nothing of the address, and what is said is no promise to open email.
    assert.equal(warned.length, 7);
    for (const line of warned) {
      assert.equal(line, '[focusdesk] did not open a mailto: link: only web links open');
    }
  });

  it('hands over what was checked: the scheme of the address as the system will read it', () => {
    const { opened, deps } = world();
    // Spaces and control characters round an address, and tabs and line breaks in it, are not
    // part of it, to a browser or to this.
    assert.equal(openOutside('  https://example.com/\n', deps), true);
    assert.equal(openOutside('ht\ttps://example.com/', deps), true);
    assert.deepEqual(opened, ['https://example.com/', 'https://example.com/']);
  });

  it('refuses every other kind of address, never asks the system, and logs the scheme and nothing of the address', () => {
    const { opened, warned, deps } = world();
    const refused = [
      'smb://203.0.113.5/share',
      'file:///Users/Shared/evil.app',
      'search-ms:query=x&crumb=location:%5C%5C203.0.113.5%5Cs',
      'ms-msdt:/id PCWDiagnostic /skip force',
      'ms-word:ofe|u|https://203.0.113.5/a.docx',
      'vnc://203.0.113.5',
      'ssh://user@203.0.113.5',
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      `blob:${SERVER}/0b1c2d3e`,
      'about:blank',
      'x-apple.systempreferences:com.apple.preference.security',
      'zoommtg://203.0.113.5/join?confno=1',
      'vscode://file/203.0.113.5',
      'ftp://203.0.113.5/x',
      'chrome://settings',
      'SMB://203.0.113.5/share',
      ' smb://203.0.113.5/share',
      '\u0000smb://203.0.113.5/share',
    ];
    for (const url of refused) assert.equal(openOutside(url, deps), false, url);
    assert.deepEqual(opened, []);
    assert.equal(warned.length, refused.length);
    for (const line of warned) {
      assert.match(line, /^\[focusdesk\] did not open a [a-z][a-z0-9+.-]*: link/);
      assert.doesNotMatch(line, /203\.0\.113\.5|share|evil|alert|query|PCW|confno/);
    }
    assert.match(warned[0], / smb: /);
    assert.match(warned[1], / file: /);
  });

  it('refuses what is not an address at all, and does not log it', () => {
    const { opened, warned, deps } = world();
    for (const url of ['not an address', '', '//203.0.113.5/share', undefined, null, 42]) {
      assert.equal(openOutside(url, deps), false, String(url));
    }
    assert.deepEqual(opened, []);
    for (const line of warned) {
      assert.equal(line, '[focusdesk] did not open a link that is not an address');
    }
  });

  it('logs a system that could not open it, by the scheme alone, and never throws', async () => {
    const { warned, deps } = world({ fails: true });
    assert.equal(openOutside('https://example.com/private/path', deps), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warned, ['[focusdesk] the system could not open a https: link']);
  });
});

/** The session both windows use, as far as this goes: what is handed to it, and asking what it says. */
function fakeSession() {
  const calls = [];
  const set = (name) => (handler) => {
    calls.push(name);
    session[name] = handler;
  };
  const session = {
    calls,
    webRequest: {
      onBeforeRequest: set('onBeforeRequest'),
      onBeforeSendHeaders: set('onBeforeSendHeaders'),
    },
    setPermissionRequestHandler: set('requestHandler'),
    setPermissionCheckHandler: set('checkHandler'),
    setDevicePermissionHandler: set('deviceHandler'),
  };
  return session;
}

/** What a webRequest listener answers for these details, and that it answers once. */
function answer(listener, details) {
  const answers = [];
  listener(details, (response) => answers.push(response));
  assert.equal(answers.length, 1, 'the listener answers every request once');
  return answers[0];
}

describe('the session both windows use', () => {
  const session = fakeSession();
  keepToServer(session, { serverUrl: SERVER, token: TOKEN });

  it('is given a listener for requests and for their headers, and the three permission handlers, once each', () => {
    assert.deepEqual(session.calls, [
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'requestHandler',
      'checkHandler',
      'deviceHandler',
    ]);
  });

  it('cancels a request for anywhere else, and lets the server’s and the page’s own go', () => {
    const cancel = (url) => answer(session.onBeforeRequest, { url, method: 'GET' }).cancel;
    assert.equal(cancel(`${SERVER}/api/settings`), false);
    assert.equal(cancel(`${SERVER}/?desktop=1`), false);
    assert.equal(cancel('data:image/png;base64,AAAA'), false);
    assert.equal(cancel('devtools://devtools/bundled/devtools_app.html'), false);
    for (const url of [...ELSEWHERE, 'http://127.0.0.1:48301/', 'file:///etc/hosts', 'nonsense']) {
      assert.equal(cancel(url), true, url);
    }
    assert.equal(answer(session.onBeforeRequest, undefined).cancel, true);
  });

  it('sends the key on a request to the server, and leaves every other request as it is', () => {
    const toServer = answer(session.onBeforeSendHeaders, {
      url: `${SERVER}/api/sessions/active`,
      requestHeaders: { Accept: '*/*' },
    });
    assert.deepEqual(toServer, { requestHeaders: { Accept: '*/*', [TOKEN_HEADER]: TOKEN } });
    for (const url of ELSEWHERE) {
      const response = answer(session.onBeforeSendHeaders, { url, requestHeaders: { Accept: '*/*' } });
      assert.deepEqual(response, {}, url);
    }
  });

  it('grants a page of the app notifications and writing to the clipboard when it asks, and nothing else', () => {
    const ask = (permission, requestingUrl) => {
      const answers = [];
      session.requestHandler({ id: 1 }, permission, (granted) => answers.push(granted), {
        requestingUrl,
        isMainFrame: true,
      });
      assert.equal(answers.length, 1, `${permission} is answered once`);
      return answers[0];
    };
    for (const permission of ELECTRON_PERMISSIONS) {
      assert.equal(ask(permission, `${SERVER}/settings?desktop=1`), ALLOWED.includes(permission), permission);
    }
    assert.equal(ask('notifications', 'https://example.com/'), false);
    assert.equal(ask('clipboard-sanitized-write', 'http://127.0.0.1:41235/'), false);
    assert.equal(ask('openExternal', `${SERVER}/`), false);
    // Details that are not there are no page of the app.
    const answers = [];
    session.requestHandler(null, 'notifications', (granted) => answers.push(granted), undefined);
    assert.deepEqual(answers, [false]);
  });

  it('says a page of the app has notifications and clipboard writing, by its origin, and nothing else', () => {
    const has = (permission, origin) => session.checkHandler(null, permission, origin, { isMainFrame: true });
    for (const permission of ELECTRON_PERMISSIONS) {
      // Electron gives the origin as an address, with its slash.
      assert.equal(has(permission, `${SERVER}/`), ALLOWED.includes(permission), permission);
    }
    assert.equal(has('notifications', SERVER), true);
    assert.equal(has('notifications', 'http://localhost:41234/'), false);
    assert.equal(has('clipboard-sanitized-write', ''), false);
    assert.equal(has('notifications', undefined), false);
  });

  it('lets no page have any device', () => {
    for (const deviceType of ['hid', 'serial', 'usb']) {
      assert.equal(session.deviceHandler({ deviceType, origin: SERVER, device: {} }), false);
    }
  });

  it('keeps to the server and the key it was given, whatever another session is given', () => {
    const other = fakeSession();
    keepToServer(other, { serverUrl: 'http://127.0.0.1:50000', token: 'another' });
    assert.equal(answer(session.onBeforeRequest, { url: 'http://127.0.0.1:50000/' }).cancel, true);
    assert.deepEqual(
      answer(session.onBeforeSendHeaders, { url: `${SERVER}/api/x`, requestHeaders: {} }),
      { requestHeaders: { [TOKEN_HEADER]: TOKEN } },
    );
  });
});

describe('the module', () => {
  it('imports nothing of Electron, so that it can be tested without it', () => {
    const source = fs.readFileSync(new URL('../privacy.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'electron'|require\('electron'\)/);
  });
});
