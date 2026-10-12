import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { navigationScript, onServer, routeUrl, windowPlan } from '../window-route.mjs';

const SERVER = 'http://127.0.0.1:41234';

describe('whether an address is a page of the app', () => {
  it('is the same scheme, host and port, whatever comes after', () => {
    assert.equal(onServer(`${SERVER}/today?x=1#y`, SERVER), true);
    assert.equal(onServer(SERVER, SERVER), true);
    assert.equal(onServer(`${SERVER}/`, `${SERVER}/anything`), true);
  });

  it('is not another port, another host, another scheme, or an address that is only dressed as one', () => {
    for (const url of [
      'http://127.0.0.1:41235/',
      'http://127.0.0.1:4123/',
      'http://localhost:41234/',
      'https://127.0.0.1:41234/',
      'http://127.0.0.1:41234@elsewhere.example/',
      'http://elsewhere.example/http://127.0.0.1:41234/',
    ]) {
      assert.equal(onServer(url, SERVER), false, url);
    }
  });

  it('is not anything that does not parse, or is not a web page: a window with nothing in it, an error page', () => {
    for (const url of ['', 'about:blank', 'chrome-error://chromewebdata/', 'file:///x', 'not a url', undefined]) {
      assert.equal(onServer(url, SERVER), false, String(url));
    }
  });
});

describe('the address of a route', () => {
  it('is on the app, with the flag that says it is inside the desktop shell', () => {
    assert.equal(routeUrl('/', SERVER), `${SERVER}/?desktop=1`);
    assert.equal(routeUrl('/wrap-up', SERVER), `${SERVER}/wrap-up?desktop=1`);
    assert.equal(
      routeUrl('/wrap-up/week?week=2026-10-05', SERVER),
      `${SERVER}/wrap-up/week?week=2026-10-05&desktop=1`,
    );
    assert.equal(routeUrl('/?finish=12', SERVER), `${SERVER}/?finish=12&desktop=1`);
  });

  it('has the flag once and as 1, whatever the route says it is', () => {
    assert.equal(routeUrl('/today?desktop=0', SERVER), `${SERVER}/today?desktop=1`);
    assert.equal(routeUrl('/today?desktop=1&desktop=1', SERVER), `${SERVER}/today?desktop=1`);
  });

  it('takes a route without its slash, an empty one, a whole address on the app, and keeps a fragment', () => {
    assert.equal(routeUrl('today', SERVER), `${SERVER}/today?desktop=1`);
    assert.equal(routeUrl('', SERVER), `${SERVER}/?desktop=1`);
    assert.equal(routeUrl(`${SERVER}/review`, SERVER), `${SERVER}/review?desktop=1`);
    assert.equal(routeUrl('/review#top', SERVER), `${SERVER}/review?desktop=1#top`);
  });

  it('goes to the front page for anything that does not stay on the app', () => {
    const front = `${SERVER}/?desktop=1`;
    for (const route of [
      '//evil.example/x',
      '\\\\evil.example\\x',
      'http://other.example/',
      'https://127.0.0.1:41234/wrap-up',
      'http://localhost:41234/wrap-up',
      'http://127.0.0.1:41234@evil.example/',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'file:///etc/passwd',
    ]) {
      assert.equal(routeUrl(route, SERVER), front, route);
    }
  });

  it('goes to the front page, and does not throw, for something that is not an address at all', () => {
    const front = `${SERVER}/?desktop=1`;
    for (const route of ['http://[', 'http://', 'http://a b/', '%']) {
      assert.doesNotThrow(() => routeUrl(route, SERVER), route);
    }
    assert.equal(routeUrl('http://[', SERVER), front);
    assert.equal(routeUrl('http://', SERVER), front);
  });
});

describe('what the window does to show a route', () => {
  const plan = (currentUrl, route, loading = false) =>
    windowPlan({ currentUrl, loading, route, serverUrl: SERVER });

  it('loads the address when there is no page of the app: nothing loaded, or something else', () => {
    const url = `${SERVER}/wrap-up?desktop=1`;
    for (const currentUrl of ['', 'about:blank', 'chrome-error://chromewebdata/', 'http://other.example/']) {
      assert.deepEqual(plan(currentUrl, '/wrap-up'), { action: 'load', url }, currentUrl);
    }
  });

  it('loads the address while a page is still loading, even if it is the app', () => {
    assert.deepEqual(plan(`${SERVER}/?desktop=1`, '/wrap-up', true), {
      action: 'load',
      url: `${SERVER}/wrap-up?desktop=1`,
    });
  });

  it('only brings the window forward when it is on that page already, with or without the flag', () => {
    assert.deepEqual(plan(`${SERVER}/wrap-up?desktop=1`, '/wrap-up'), { action: 'show' });
    // The sidebar goes from page to page without the flag, which the page remembers on its own.
    assert.deepEqual(plan(`${SERVER}/wrap-up`, '/wrap-up'), { action: 'show' });
    assert.deepEqual(plan(`${SERVER}/`, '/'), { action: 'show' });
    assert.deepEqual(plan(`${SERVER}/?desktop=1`, '/'), { action: 'show' });
  });

  it('compares the query as a set, and not as text: the same page whichever order it was written in', () => {
    assert.deepEqual(
      plan(`${SERVER}/wrap-up/week?desktop=1&week=2026-10-05`, '/wrap-up/week?week=2026-10-05'),
      { action: 'show' },
    );
  });

  it('moves inside the page for another route, which keeps what is typed on this one', () => {
    assert.deepEqual(plan(`${SERVER}/wrap-up?desktop=1`, '/wrap-up/week?week=2026-10-05'), {
      action: 'navigate',
      path: '/wrap-up/week?week=2026-10-05&desktop=1',
      url: `${SERVER}/wrap-up/week?week=2026-10-05&desktop=1`,
    });
    assert.deepEqual(plan(`${SERVER}/today`, '/wrap-up'), {
      action: 'navigate',
      path: '/wrap-up?desktop=1',
      url: `${SERVER}/wrap-up?desktop=1`,
    });
  });

  it('moves for the same path with another query, as the long block does to the Focus page', () => {
    assert.deepEqual(plan(`${SERVER}/?desktop=1`, '/?finish=12'), {
      action: 'navigate',
      path: '/?finish=12&desktop=1',
      url: `${SERVER}/?finish=12&desktop=1`,
    });
    assert.equal(plan(`${SERVER}/wrap-up?day=2026-10-11`, '/wrap-up').action, 'navigate');
    assert.equal(plan(`${SERVER}/wrap-up`, '/wrap-up?day=2026-10-11').action, 'navigate');
  });

  it('treats another fragment as another place', () => {
    assert.equal(plan(`${SERVER}/review#a`, '/review#b').action, 'navigate');
    assert.equal(plan(`${SERVER}/review#a`, '/review#a').action, 'show');
  });

  it('keeps to the app for a route that leaves it: the front page, and moving there when it is not there already', () => {
    assert.deepEqual(plan(`${SERVER}/`, '//evil.example/'), { action: 'show' });
    assert.deepEqual(plan(`${SERVER}/today`, '//evil.example/'), {
      action: 'navigate',
      path: '/?desktop=1',
      url: `${SERVER}/?desktop=1`,
    });
    assert.deepEqual(plan('', 'javascript:alert(1)'), {
      action: 'load',
      url: `${SERVER}/?desktop=1`,
    });
  });

  it('never gives a path that names a host: it can only stay where it is', () => {
    for (const route of ['/wrap-up', '//evil.example/x', 'http://other.example/y', '/a?b=c']) {
      const planned = plan(`${SERVER}/today`, route);
      if (planned.action === 'navigate') assert.match(planned.path, /^\/(?!\/)/, route);
    }
  });
});

describe('the script that moves a loaded page', () => {
  /**
   * Run it against a page that records what is done to it, in order. `focused` is what has the
   * focus: a box that records being blurred, unless 'nothing' (not even an element) or something
   * else is given.
   */
  function run(path, { state = null, focused = 'a box' } = {}) {
    const calls = [];
    const window = {
      history: {
        state,
        pushState: (...args) => calls.push(['pushState', ...args]),
      },
      dispatchEvent: (event) => calls.push(['dispatchEvent', event.type]),
    };
    const active =
      focused === 'a box'
        ? { blur: () => calls.push(['blur']) }
        : focused === 'nothing'
          ? undefined
          : focused;
    vm.runInNewContext(navigationScript(path), {
      window,
      document: { activeElement: active },
      PopStateEvent: class {
        constructor(type) {
          this.type = type;
        }
      },
      Math,
    });
    return calls;
  }

  it('tells the box that has the focus it is lost, then adds a history entry for the path, and then says the address has changed, in that order', () => {
    const calls = run('/wrap-up/week?week=2026-10-05&desktop=1', {
      state: { usr: null, key: 'abc', idx: 2 },
    });

    assert.deepEqual(
      calls.map((call) => call[0]),
      ['blur', 'pushState', 'dispatchEvent'],
    );
    const push = calls[1];
    assert.equal(push[2], '');
    assert.equal(push[3], '/wrap-up/week?week=2026-10-05&desktop=1');
    assert.deepEqual(calls[2], ['dispatchEvent', 'popstate']);
  });

  it('moves the page all the same when nothing has the focus, or what has it cannot be blurred', () => {
    for (const focused of [null, 'nothing', {}, { blur: 'not a function' }]) {
      const calls = run('/wrap-up', { focused });

      assert.deepEqual(
        calls.map((call) => call[0]),
        ['pushState', 'dispatchEvent'],
        JSON.stringify(focused),
      );
    }
  });

  it('shapes the entry as the router shapes its own: its index goes on from the last, and it has a key', () => {
    const push = run('/wrap-up', { state: { usr: null, key: 'abc', idx: 2 } })[1];
    const state = push[1];

    assert.equal(state.idx, 3);
    assert.equal(state.usr, null);
    assert.match(state.key, /^[a-z0-9]{1,8}$/);
  });

  it('starts the index at 1 when the page has no entry the router made', () => {
    for (const state of [null, undefined, {}, { idx: 'x' }]) {
      assert.equal(run('/wrap-up', { state })[1][1].idx, 1, JSON.stringify(state));
    }
  });

  it('puts the path in as a string and nothing else, whatever it holds', () => {
    const paths = ['/a"b', "/a'b", '/a\\b', '/a\nb', '/a</script>b', '/a`${1}`', '/a b'];
    for (const path of paths) {
      const push = run(path)[1];
      assert.equal(push[3], path, JSON.stringify(path));
    }
  });
});
