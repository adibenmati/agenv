/**
 * Thrown by services; the Express error middleware renders it as `{ error: message }` with `status` — or as
 * `body` verbatim when the route's error shape is something else (e.g. git routes answer `{ ok: false, output }`).
 */
export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}
