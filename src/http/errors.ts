import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../core/HttpError";

/** Lets a route handler be `async` (or throw): any failure goes to the error middleware instead of hanging the request. */
export function wrap(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); }
  };
}

/**
 * Renders failures the way the API always has: `{ error: message }` with the status — or the exact `body` an
 * HttpError carries for routes whose error shape differs. Errors from Express's own parsers (a malformed JSON body)
 * keep their 400 but now answer in JSON rather than an HTML stack trace.
 */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) { next(err); return; }
  if (err instanceof HttpError) {
    res.status(err.status).json(err.body !== undefined ? err.body : { error: err.message });
    return;
  }
  const status = Number(err && (err.status || err.statusCode));
  if (status >= 400 && status < 600) { res.status(status).json({ error: err.message || "Error" }); return; }
  res.status(500).json({ error: err && err.message ? err.message : "Internal error" });
};
