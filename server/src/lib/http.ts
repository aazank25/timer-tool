import { STATUS_CODES } from 'node:http';
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

/**
 * The status of an error that says the request itself was wrong, the way the body parser's and
 * Express's own errors say it: JSON that does not parse (400), a body over the limit (413), a
 * charset or an encoding that is not read (415). Anything else is the server's own fault.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = status ?? statusCode;
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500
    ? code
    : undefined;
}

/** better-sqlite3's error for a row that points at a row that is not there. */
function isForeignKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
  );
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
  // Answered with its status and the name of it, and not logged, since nothing is wrong with the
  // server. Never with the error's own message: for JSON that does not parse, it quotes the body.
  const status = clientErrorStatus(err);
  if (status !== undefined) {
    res.status(status).json({ error: STATUS_CODES[status] ?? 'Bad Request' });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    res.status(409).json({ error: 'That already exists', details: msg });
    return;
  }
  // A write naming a project, a block or a task that is not there, or is no longer: the request's
  // mistake, which SQLite's foreign keys catch wherever a route did not look first.
  if (isForeignKeyError(err)) {
    res.status(400).json({ error: 'That refers to something that does not exist' });
    return;
  }
  // The stack, which says what went wrong and where, and not the error itself, which can carry
  // whatever it was handed: the body parser's holds the whole body it could not read.
  console.error('[error]', err instanceof Error ? (err.stack ?? msg) : msg);
  res.status(500).json({ error: 'Internal error', details: msg });
}
