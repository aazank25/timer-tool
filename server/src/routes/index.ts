import { Router } from 'express';
import { handler } from '../lib/http.js';
import { readSources } from '../lib/calendar.js';
import { getSetting } from '../lib/settings.js';
import { calendarRouter } from './calendar.js';
import { planRouter } from './plan.js';
import { projectsRouter } from './projects.js';
import { sessionsRouter } from './sessions.js';
import { settingsRouter } from './settings.js';
import { statsRouter } from './stats.js';
import { timersRouter } from './timers.js';

export const apiRouter = Router();

apiRouter.get(
  '/health',
  handler(() => ({ ok: true, version: '0.1.0' })),
);

/** What is wired up, so the UI can show setup state rather than guess. */
apiRouter.get(
  '/integrations',
  handler(() => ({
    calendar: {
      kind: 'ics',
      configured: readSources().length > 0,
      sources: readSources().length,
      lastSyncedAt: getSetting('calendar_last_sync') ?? null,
    },
    notion: { kind: 'none', configured: false, note: 'Planned — see docs/PLAN.md phase 4' },
  })),
);

apiRouter.use('/projects', projectsRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/plan', planRouter);
apiRouter.use('/timers', timersRouter);
apiRouter.use('/stats', statsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/calendar', calendarRouter);
