import { api, request, type Session } from './api';

/**
 * What starts a block: the body POST /api/sessions takes, taken from the client for it rather
 * than written out again, so what the quick-switch box sends can never drift from what the
 * server's switch route accepts (it takes this same body under `start`).
 */
export type StartBody = Parameters<typeof api.startSession>[0];

export interface SwitchResult {
  /** The block that was on the clock and has now been finished, or null when nothing was. */
  stopped: Session | null;
  started: Session;
}

export const quickSwitchApi = {
  /**
   * Finish the block on the clock, rated when a rating is given, and start another, all or
   * nothing: a start the server refuses leaves the block on the clock as it was.
   */
  switchBlock: (body: { start: StartBody; rating?: number | null }) =>
    request<SwitchResult>('POST', '/sessions/switch', body),
};
