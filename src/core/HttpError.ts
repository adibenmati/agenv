/** Thrown by services; the Express error middleware renders it as `{ error: message }` with `status`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
