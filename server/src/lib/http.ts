import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string) => new HttpError(409, msg);

/**
 * Wrap a handler so its return value is sent as JSON and any thrown or
 * rejected error reaches the error middleware. A handler that has already
 * written to the response (or returns undefined) is left alone.
 */
export function handler(
  fn: (req: Request, res: Response) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res))
      .then((value) => {
        if (res.headersSent) return;
        if (value === undefined) {
          res.status(204).end();
          return;
        }
        res.json(value);
      })
      .catch(next);
  };
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('Invalid request', r.error.flatten());
  return r.data;
}

export function intParam(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${name}`);
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: err.flatten() });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    res.status(409).json({ error: 'That already exists', details: msg });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal error', details: msg });
}
