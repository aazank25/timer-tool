import { Router } from 'express';
import { z } from 'zod';
import { handler, parse } from '../lib/http.js';
import { actOnPrompt, listPrompts } from '../lib/prompts.js';

export const promptsRouter = Router();

/** Everything that needs your attention, oldest first. */
promptsRouter.get(
  '/',
  handler(() => listPrompts()),
);

// Prompt ids carry a calendar event's id, which can be long.
const actSchema = z.object({
  id: z.string().min(1).max(1000),
  action: z.string().min(1).max(60),
});

/** Answer one, and get the list back as it stands afterwards. */
promptsRouter.post(
  '/act',
  handler((req) => {
    const body = parse(actSchema, req.body);
    return { prompts: actOnPrompt(body.id, body.action) };
  }),
);
