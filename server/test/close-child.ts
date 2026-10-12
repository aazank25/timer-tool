/**
 * Run by calendar-sync.test.ts in a process of its own, to see whether the background sync lets
 * a process end. It is not a test itself.
 *
 *   close-child.ts timer <data dir>             starts the timer and then does nothing at all
 *   close-child.ts close <data dir> <feed url>  starts a server whose sync is set on a feed, and
 *                                               closes it when told to on its standard input
 *
 * It says `ready` when it is set up, and `closed` once the server has closed.
 */
export {};

const [mode, dataDir, feedUrl] = process.argv.slice(2);
process.env.FOCUSDESK_DATA_DIR = dataDir;
process.env.TZ = 'UTC';

if (mode === 'timer') {
  const { startCalendarSync } = await import('../src/lib/calendar.js');
  // Started and never stopped: whether the process can end is up to the timer alone.
  startCalendarSync({ everyMs: 60_000 });
  console.log('ready');
} else if (mode === 'close') {
  const { startServer } = await import('../src/app.js');
  const { setSettings } = await import('../src/lib/settings.js');
  const running = await startServer({ port: 0, calendarSyncMs: 100 });
  setSettings({
    calendar_sources: JSON.stringify([
      { id: 'cal_child', label: 'Slow', url: feedUrl, enabled: true },
    ]),
  });
  console.log('ready');
  process.stdin.once('data', () => {
    // Nothing is left to read, so nothing of this is what keeps the process going.
    process.stdin.destroy();
    void running.close().then(() => console.log('closed'));
  });
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
