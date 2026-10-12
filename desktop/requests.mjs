/**
 * What the app should read again because a window has just finished a request to the server:
 * the rule, on its own, so it can be tested without a window to make requests from. The
 * windows talk to the server directly, and the menu bar has its own picture of what is on the
 * clock and what the settings are; this is how it finds out that picture is out of date,
 * rather than waiting for its next poll.
 */

/** A request that only reads changes nothing. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Which part of the server's state a request that changes something can change: the settings
 * (away detection goes by them), and the block on the clock (a block started, paused, resumed,
 * finished or discarded, which a question answered in a window can do as well: Pause, for a
 * meeting that has started).
 */
const WATCHED = [
  { prefix: '/api/settings', reread: 'settings' },
  { prefix: '/api/sessions', reread: 'live' },
  { prefix: '/api/prompts', reread: 'live' },
];

/**
 * What a finished request means for the menu bar: `settings` when the settings may have changed,
 * and `live` when the block on the clock, or what is waiting for an answer, may have. A request
 * that was refused changed nothing, and one that only reads never does. Only requests to the
 * app's own server count, compared as parsed addresses and on whole path segments: /api/sessions
 * and what is under it, and not /api/sessionsX.
 *
 * @param {{ method?: string, statusCode?: number, url?: string }} details As Electron gives them
 *   to webRequest.onCompleted.
 * @param {string} serverUrl The address the app is served from.
 * @returns {{ settings: boolean, live: boolean }}
 */
export function rereadAfter(details, serverUrl) {
  const nothing = { settings: false, live: false };
  try {
    const { method, statusCode, url } = details ?? {};
    if (READS.has(String(method).toUpperCase()) || !(statusCode < 400)) return nothing;
    const address = new URL(url);
    if (address.origin !== new URL(serverUrl).origin) return nothing;
    const found = WATCHED.find(
      ({ prefix }) => address.pathname === prefix || address.pathname.startsWith(`${prefix}/`),
    );
    return found
      ? { settings: found.reread === 'settings', live: found.reread === 'live' }
      : nothing;
  } catch {
    // An address that does not parse is not one of the app's.
    return nothing;
  }
}
