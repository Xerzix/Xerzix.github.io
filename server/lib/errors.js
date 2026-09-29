// A single error type for everything the API reports to clients. Anything else that
// escapes a handler is treated as an internal error and never shown to the user.
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message = 'The request was not valid.', extra) => new HttpError(400, 'BAD_REQUEST', message, extra);
export const unauthorized = (message = 'Please sign in to continue.', code = 'UNAUTHENTICATED') => new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'We could not find that.', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message, code = 'CONFLICT', extra) => new HttpError(409, code, message, extra);
export const tooMany = (retryAfterS) => new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', { retryAfter: retryAfterS });
export const validation = (fields) => new HttpError(422, 'VALIDATION_FAILED', 'Some fields need attention.', { fields });
