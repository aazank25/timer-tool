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
 * The first three begin at the last input as well, and not at the event: a Mac that locks or
 * sleeps by itself after five minutes of nobody touching it was away for those five minutes
 * too, and a threshold of ten has to be able to count them. Nothing is held against a time
 * before the last return, though: that was reported already, or was somebody at the machine.
 *
 * It ends at an unlock, whatever else was keeping you away: somebody who has just unlocked
 * the screen is awake and in their own session, and a wake-up or a switch back that was never
 * seen must not leave the stretch open for ever. At wake-up, or when the user comes back, it
 * ends only if nothing else still keeps you away, which in practice is the screen being
 * locked. Being idle ends at the first input, and it ended at that input. Locking, sleeping,
 * waking and unlocking is one stretch, from the earliest start to the last return, and not
 * three.
 *
 * An event can be missed, and a stretch must not stay open because of it (the next lock and
 * unlock would then report hours that were somebody's work, against a block long finished). So
 * the poll looks for the return as well: a stretch that a lock, a sleep or a switch began, with
 * input seen since it began and the screen not locked (`isLocked`, which asks the system and
 * not the events), is somebody who is back, and it ended at the last input. Input on a locked
 * screen is only a password being typed, and does not end it. No stretch is longer than
 * MAX_STRETCH_HOURS either: one that reaches that is ended there and reported up to there, and
 * one that an event ends later is reported up to there too. The rest of such an absence is not
 * reported (the server would only merge it into the same question), and nothing new is begun
 * until the machine has been touched again.
 *
 * When it ends it is reported if it was at least `away_minutes` long and a focus block was
 * running at the moment it began. A block that was paused, a break, and no block at all are
 * not something you were away from, so they are not reported. The block is asked for when the
 * stretch begins, and not read from what the menu bar last saw, which can be seconds old: a
 * block stopped in the window a moment before the screen locked is not one you were away from.
 * The server is told the block and the two instants; what it answers is its own business. A
 * report that fails is logged and dropped: this runs inside Electron's event loop, and a
 * question that cannot be asked is not worth taking the app down over.
 */

/**
 * Idle time is a whole number of seconds read a moment after it was true, so a reading can
 * be a second off the real gap since the stretch began. A return is only believed when input
 * came this much after the stretch started.
 */
const SLACK_MS = 2_000;

/** No stretch is longer than this, as one report: see the end of the description above. */
export const MAX_STRETCH_HOURS = 12;
const MAX_STRETCH_MS = MAX_STRETCH_HOURS * 60 * 60_000;

/**
 * @param {object} deps
 * @param {() => number} [deps.now] The time, as epoch milliseconds.
 * @param {() => number} deps.getIdleSeconds Seconds since the last keyboard or pointer input.
 * @param {() => ({ id: number, kind: string, status: string } | null | undefined | Promise<{ id: number, kind: string, status: string } | null | undefined>)} deps.getLive
 *   The block on the clock, if there is one, as it is at this moment. It is called once as each
 *   stretch begins, and may answer later (asking the server), which the stretch waits for before
 *   it decides anything.
 * @param {() => ({ away_minutes?: string | number } | null | undefined)} deps.getSettings
 *   The settings as last read. Away detection is off until they have been.
 * @param {() => boolean} [deps.isLocked] Whether the system says the screen is locked right now.
 *   Without it the answer is yes, and a stretch that a lock, a sleep or a switch began is ended
 *   by the events and by the length it is allowed, and by nothing else.
 * @param {(stretch: { sessionId: number, startedAt: string, endedAt: string }) => Promise<unknown> | unknown} deps.report
 *   Tell the server. May reject.
 * @param {(...args: unknown[]) => void} [deps.log]
 */
export function createAwayTracker({
  now = Date.now,
  getIdleSeconds,
  getLive,
  getSettings,
  isLocked = () => true,
  report,
  log = () => {},
}) {
  /** What is keeping you away now. Any one is enough, and the stretch ends when none is left. */
  const cause = { locked: false, suspended: false, switched: false, idle: false };
  /**
   * The stretch under way: when it began, and the focus block that was running as it did (null
   * until it is known, and for good if none was). `reading` is the question that finds it out.
   */
  let stretch = null;
  /** The latest moment something that kept you away stopped: where the stretch ends. */
  let returnedAt = null;
  /** Where the last stretch ended. Nothing begins before it. */
  let lastReturn = null;
  /**
   * Set when a stretch was cut short at its length: the moment it was cut. Nothing new begins
   * until the machine has been touched after that, since until then it is the same absence.
   */
  let cutAt = null;

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
  const focusBlockId = (live) =>
    live && live.kind === 'focus' && live.status === 'running' ? live.id : null;

  /**
   * Find out which block the stretch is held against, now. The question is asked here and then,
   * and not when the stretch is over, because the answer is about the moment it began; and it
   * is asked anew each time because what the menu bar knew can be five seconds old. An answer
   * that comes later is waited for by whoever needs it (`reading`); one that is there at once
   * is in place when this returns, so nothing depends on the order things happen in.
   */
  function readBlock(s) {
    const fail = (err) => log('[away] could not read the block on the clock', err);
    try {
      const live = getLive();
      if (live && typeof live.then === 'function') {
        return live.then((answer) => {
          s.sessionId = focusBlockId(answer);
        }, fail);
      }
      s.sessionId = focusBlockId(live);
    } catch (err) {
      fail(err);
    }
    return Promise.resolve();
  }

  /** The time before which nothing is held against you: the end of the last stretch, and never later than now. */
  const floor = (t) => (lastReturn === null ? -Infinity : Math.min(lastReturn, t));

  /**
   * The idle time in milliseconds, and whether it could be read at all. Readings that cannot be
   * read, or are not numbers, count as none: but "touched just now" and "no idea" are different
   * things to whoever asks whether somebody is back.
   */
  function readIdle() {
    try {
      const seconds = Number(getIdleSeconds());
      if (Number.isFinite(seconds)) return { known: true, ms: seconds > 0 ? seconds * 1000 : 0 };
    } catch (err) {
      log('[away] could not read the idle time', err);
    }
    return { known: false, ms: 0 };
  }

  /** Whether the system says the screen is locked. Unable to say is yes: nobody is let off by a failure. */
  function screenIsLocked() {
    try {
      return !!isLocked();
    } catch (err) {
      log('[away] could not tell if the screen is locked', err);
      return true;
    }
  }

  /**
   * Away from `at`, for this reason. The stretch begins at the last input if that was before
   * `at`, and never before the last return. Already away, it is the same stretch and keeps the
   * earlier start. Resolves once it is known which block it is held against.
   */
  function begin(name, at) {
    const t = now();
    const lastInput = t - readIdle().ms;
    if (cutAt !== null) {
      // Untouched since a stretch was cut at its length: still the same absence, and it has
      // been reported as far as it will be. Touched since: somebody was there, and this is a new one.
      if (lastInput <= cutAt) return Promise.resolve();
      cutAt = null;
    }
    const from = Math.max(Math.min(at, lastInput), floor(t));
    cause[name] = true;
    if (stretch) {
      stretch.start = Math.min(stretch.start, from);
      return stretch.reading;
    }
    const s = { start: from, sessionId: null, reading: null };
    stretch = s;
    returnedAt = null;
    s.reading = readBlock(s);
    return s.reading;
  }

  /** Some of what kept you away has stopped, at `at`. If that was the last of it, the stretch is over. */
  function clear(names, at) {
    for (const name of names) cause[name] = false;
    returnedAt = returnedAt == null ? at : Math.max(returnedAt, at);
    return isAway() ? Promise.resolve() : finish();
  }

  async function finish() {
    const done = stretch;
    const returned = returnedAt;
    stretch = null;
    returnedAt = null;
    if (returned == null) return;
    lastReturn = lastReturn == null ? returned : Math.max(lastReturn, returned);
    if (!done) return;

    // Which block it was held against may still be on its way.
    await done.reading;
    const minutes = awayMinutes();
    // Not later than now: two clocks are never quite alike, and the server refuses the future.
    // And not longer than a stretch is allowed to be.
    const end = Math.min(returned, now(), done.start + MAX_STRETCH_MS);
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

  /** The stretch has reached the length it is allowed: it is over, there, and is reported up to there. */
  function cut() {
    const at = stretch.start + MAX_STRETCH_MS;
    for (const name of Object.keys(cause)) cause[name] = false;
    returnedAt = at;
    cutAt = at;
    return finish();
  }

  return {
    /** The screen locked. Resolves once it is known which block it is held against. */
    onLock(at = now()) {
      return begin('locked', at);
    },

    /**
     * The screen was unlocked, which is somebody at the machine, so the end of everything that
     * kept you away (the machine cannot be asleep, nor another user's session on top of this
     * one). Resolves once any report has been sent.
     */
    onUnlock(at = now()) {
      return clear(['locked', 'suspended', 'switched', 'idle'], at);
    },

    /** The system is going to sleep. */
    onSuspend(at = now()) {
      return begin('suspended', at);
    },

    /** The system woke up. It is only the end of the stretch if the screen is not locked as well. */
    onResume(at = now()) {
      return clear(['suspended'], at);
    },

    /** Another user's session took over (fast user switching on a Mac). */
    onResignActive(at = now()) {
      return begin('switched', at);
    },

    /** This user's session is back, which it cannot be while the machine sleeps. */
    onBecomeActive(at = now()) {
      return clear(['switched', 'suspended'], at);
    },

    /**
     * Look at the idle time, which is what the poll is for: it starts a stretch when there has
     * been no input for `away_minutes`, and ends one when there has been input since. It also
     * ends one that an event should have ended and did not, and one that has gone on too long.
     */
    async tick() {
      const { known, ms: idle } = readIdle();
      const t = now();
      if (stretch) {
        if (t - stretch.start >= MAX_STRETCH_MS) {
          await cut();
          return;
        }
        // Input has come in since the stretch began if the machine has been idle for less
        // time than that, and the last input is then where the stretch ended.
        if (idle >= t - stretch.start - SLACK_MS) return;
        const back = [];
        // Being idle is over at the first input, which is what an idle time that cannot be read
        // is taken for. A lock, a sleep or a switch is over only if the system agrees that the
        // screen is not locked (a person typing a password is at the lock screen, not back),
        // and an idle time that cannot be read says nothing about whether anyone is there.
        if (cause.idle) back.push('idle');
        if (known && !screenIsLocked()) back.push('locked', 'suspended', 'switched');
        if (back.length) await clear(back, t - idle);
        return;
      }

      const minutes = awayMinutes();
      if (minutes > 0 && idle >= minutes * 60_000) await begin('idle', t - idle);
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
