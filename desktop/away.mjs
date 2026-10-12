/**
 * Away detection: notice that you left the machine while a block was running, and say so to
 * the server, which asks you what to do about the time. Nothing here is decided for you and
 * nothing here touches Electron: the events come in as calls, the clock and the idle time
 * are handed in, and the report goes out through a function, so every rule can be tested
 * without a screen to lock.
 *
 * A stretch away begins at any one of:
 *   - the screen locking,
 *   - the system going to sleep,
 *   - another user taking over the Mac (fast user switching),
 *   - the machine having had no input for `away_minutes`, in which case it began at the last
 *     input, `idle time` ago, so nothing has to be watched for in the meantime.
 *
 * It ends when none of them is true any more: at unlock, at wake-up or when the user comes
 * back only if the screen is not still locked, and for being idle at the first input, when
 * it ended at that input. Locking, sleeping, waking and unlocking is one stretch, from the
 * earliest start to the last return, and not three.
 *
 * When it ends it is reported if it was at least `away_minutes` long and a focus block was
 * running at the moment it began. A block that was paused, a break, and no block at all are
 * not something you were away from, so they are not reported. The server is told the block
 * and the two instants; what it answers is its own business. A report that fails is logged
 * and dropped: this runs inside Electron's event loop, and a question that cannot be asked
 * is not worth taking the app down over.
 */

/**
 * Idle time is a whole number of seconds read a moment after it was true, so a reading can
 * be a second off the real gap since the stretch began. A return is only believed when input
 * came this much after the stretch started.
 */
const SLACK_MS = 2_000;

/**
 * @param {object} deps
 * @param {() => number} [deps.now] The time, as epoch milliseconds.
 * @param {() => number} deps.getIdleSeconds Seconds since the last keyboard or pointer input.
 * @param {() => ({ id: number, kind: string, status: string } | null | undefined)} deps.getLive
 *   The block on the clock, if there is one.
 * @param {() => ({ away_minutes?: string | number } | null | undefined)} deps.getSettings
 *   The settings as last read. Away detection is off until they have been.
 * @param {(stretch: { sessionId: number, startedAt: string, endedAt: string }) => Promise<unknown> | unknown} deps.report
 *   Tell the server. May reject.
 * @param {(...args: unknown[]) => void} [deps.log]
 */
export function createAwayTracker({
  now = Date.now,
  getIdleSeconds,
  getLive,
  getSettings,
  report,
  log = () => {},
}) {
  /** What is keeping you away now. Any one is enough, and the stretch ends when none is left. */
  const cause = { locked: false, suspended: false, switched: false, idle: false };
  /** The stretch under way: when it began, and the focus block that was running as it did. */
  let stretch = null;
  /** The latest moment something that kept you away stopped: where the stretch ends. */
  let returnedAt = null;

  const isAway = () => cause.locked || cause.suspended || cause.switched || cause.idle;

  /** The threshold in minutes, or 0 for off. Not knowing the settings is as good as off. */
  function awayMinutes() {
    try {
      const minutes = Number(getSettings()?.away_minutes);
      return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    } catch (err) {
      log('[away] could not read the settings', err);
      return 0;
    }
  }

  /** The block that is running at this moment if it is a focus block: the one an absence is held against. */
  function runningFocusBlock() {
    try {
      const live = getLive();
      return live && live.kind === 'focus' && live.status === 'running' ? live.id : null;
    } catch (err) {
      log('[away] could not read the block on the clock', err);
      return null;
    }
  }

  /** Away from `at`. Already away, it is the same stretch and keeps the earlier start. */
  function begin(at) {
    if (stretch) {
      stretch.start = Math.min(stretch.start, at);
      return;
    }
    stretch = { start: at, sessionId: runningFocusBlock() };
    returnedAt = null;
  }

  /** One thing that kept you away has stopped, at `at`. If it was the last, the stretch is over. */
  function clear(name, at) {
    cause[name] = false;
    returnedAt = returnedAt == null ? at : Math.max(returnedAt, at);
    return isAway() ? Promise.resolve() : finish();
  }

  async function finish() {
    const done = stretch;
    const returned = returnedAt;
    stretch = null;
    returnedAt = null;
    if (!done || returned == null) return;

    const minutes = awayMinutes();
    // Not later than now: two clocks are never quite alike, and the server refuses the future.
    const end = Math.min(returned, now());
    if (!(minutes > 0) || done.sessionId == null || end - done.start < minutes * 60_000) return;

    try {
      await report({
        sessionId: done.sessionId,
        startedAt: new Date(done.start).toISOString(),
        endedAt: new Date(end).toISOString(),
      });
    } catch (err) {
      // A block that has gone (404) or a stretch the server will not take (400) is not an
      // error to the person, and neither is a hiccup worth a second try: the time stays counted.
      log('[away] the server did not take the report', err);
    }
  }

  /** Readings of the idle time that cannot be read, or are not numbers, count as none. */
  function idleMilliseconds() {
    try {
      const seconds = Number(getIdleSeconds());
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    } catch (err) {
      log('[away] could not read the idle time', err);
      return 0;
    }
  }

  return {
    /** The screen locked. */
    onLock(at = now()) {
      cause.locked = true;
      begin(at);
    },

    /** The screen was unlocked. Resolves once any report has been sent. */
    onUnlock(at = now()) {
      return clear('locked', at);
    },

    /** The system is going to sleep. */
    onSuspend(at = now()) {
      cause.suspended = true;
      begin(at);
    },

    /** The system woke up. It is only the end of the stretch if the screen is not locked as well. */
    onResume(at = now()) {
      return clear('suspended', at);
    },

    /** Another user's session took over (fast user switching on a Mac). */
    onResignActive(at = now()) {
      cause.switched = true;
      begin(at);
    },

    /** This user's session is back. */
    onBecomeActive(at = now()) {
      return clear('switched', at);
    },

    /**
     * Look at the idle time, which is what the poll is for: it starts a stretch when there has
     * been no input for `away_minutes`, and ends one when there has been input since.
     */
    async tick() {
      const idle = idleMilliseconds();
      const t = now();
      if (cause.idle) {
        // Input has come in since the stretch began if the machine has been idle for less
        // time than that, and the last input is then where the stretch ended.
        if (idle < t - stretch.start - SLACK_MS) await clear('idle', t - idle);
        return;
      }
      // Already away for some other reason: whatever the idle time is, nothing new has begun.
      if (stretch) return;
      const minutes = awayMinutes();
      if (minutes > 0 && idle >= minutes * 60_000) {
        cause.idle = true;
        begin(t - idle);
      }
    },

    /** What it thinks is going on, as plain data. */
    state() {
      return {
        away: stretch !== null,
        since: stretch?.start ?? null,
        sessionId: stretch?.sessionId ?? null,
        locked: cause.locked,
        suspended: cause.suspended,
        switched: cause.switched,
        idle: cause.idle,
      };
    },
  };
}
