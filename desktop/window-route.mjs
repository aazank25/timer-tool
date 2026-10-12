/**
 * Where the main window goes when it is asked to show a page of the app: which address a route
 * is, and whether getting there needs the page to be loaded at all. Nothing here touches
 * Electron (the window's address and whether it is loading are handed in, and what to do is
 * handed back), so every rule can be tested without a window.
 *
 * Loading an address replaces the page, and everything on it that was not saved: a note
 * half-typed in the wrap-up is gone with it. A page of the app that is already loaded is moved
 * about by the app's own router instead, which is what a click on its own sidebar does, so a
 * page is only loaded when there is not one of the app's to move.
 */

/**
 * Whether `url` is a page of the local app: the same origin as `serverUrl`, which is scheme,
 * host and port together. Compared as parsed addresses and never as text, because text that
 * begins with the app's address need not be on it ('http://127.0.0.1:5000@elsewhere.example/'
 * is the host elsewhere.example), and a different port is another app. Anything that does not
 * parse is not on it.
 */
export function onServer(url, serverUrl) {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The address of a page of the app, with the flag that tells the page it is inside this shell
 * (see IS_DESKTOP in web/src/App.tsx). A route that does not stay on the local server is not
 * one of the app's, and neither is one that is not an address at all: both go to the front page.
 */
export function routeUrl(route, serverUrl) {
  const base = new URL(serverUrl);
  let url;
  try {
    url = new URL(route, base);
  } catch {
    return routeUrl('/', serverUrl);
  }
  if (url.origin !== base.origin) return routeUrl('/', serverUrl);
  url.searchParams.set('desktop', '1');
  return url.toString();
}

/** A page's place in the app, whatever the flag: its path, its query without the flag, its fragment. */
function placeOf(url) {
  const copy = new URL(url);
  copy.searchParams.delete('desktop');
  return `${copy.pathname}${copy.search}${copy.hash}`;
}

/**
 * What to do to show `route` in a window that is on `currentUrl`:
 *   { action: 'show' }                  it is on that page already: only bring it forward
 *   { action: 'navigate', path, url }   move to `path` inside the page that is loaded, which
 *                                       keeps what is on it (`url` is the address to load if
 *                                       that could not be done)
 *   { action: 'load', url }             there is no page of the app to move (nothing loaded, a
 *                                       load still going on, or somewhere that is not the app):
 *                                       load the address
 *
 * @param {object} what
 * @param {string} what.currentUrl The address the window is on now: empty when it has none.
 * @param {boolean} what.loading Whether the window is still loading a page.
 * @param {string} what.route A route of the app, such as '/wrap-up' or '/wrap-up/week?week=2026-10-05'.
 * @param {string} what.serverUrl The address the app is served from.
 */
export function windowPlan({ currentUrl, loading, route, serverUrl }) {
  const url = routeUrl(route, serverUrl);
  // A page that is still loading is not there to be moved about in, and has nothing to lose.
  if (loading || !onServer(currentUrl, serverUrl)) return { action: 'load', url };
  if (placeOf(currentUrl) === placeOf(url)) return { action: 'show' };
  const target = new URL(url);
  return { action: 'navigate', path: `${target.pathname}${target.search}${target.hash}`, url };
}

/**
 * The script that moves a loaded page of the app to `path`, as one of the app's own links would:
 * a new entry in the history, and the popstate event that BrowserRouter listens for to find out
 * that the address has changed. The entry is shaped as the router shapes its own (an index that
 * goes on from the last one, and a key), so that Back and forward keep working, and the path goes
 * in as a string literal made by JSON, which is all that can be in it.
 *
 * The box that has the focus is told that it has lost it first, as a click on a link would have
 * done. A box that saves itself when the focus leaves it (the notes of the wrap-up) then saves
 * what was typed on its way out, where moving the page without a word took a note that had been
 * typed and not yet saved with it.
 */
export function navigationScript(path) {
  return `(() => {
  const focused = document.activeElement;
  if (focused && typeof focused.blur === 'function') focused.blur();
  const was = window.history.state;
  window.history.pushState(
    {
      usr: null,
      key: Math.random().toString(36).slice(2, 10),
      idx: (was && typeof was.idx === 'number' ? was.idx : 0) + 1,
    },
    '',
    ${JSON.stringify(path)},
  );
  window.dispatchEvent(new PopStateEvent('popstate'));
})()`;
}
