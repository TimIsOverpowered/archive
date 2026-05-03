/**
 * HTTP error class with status code and error code for consistent API error responses.
 * Use the factory functions (badRequest, notFound, etc.) instead of constructing directly.
 */
export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code ?? this.name.toUpperCase();
  }
}

/** Throws a 400 Bad Request HttpError. */
export function badRequest(message: string): never {
  throw new HttpError(400, message, 'BAD_REQUEST');
}

/** Throws a 404 Not Found HttpError. */
export function notFound(message: string): never {
  throw new HttpError(404, message, 'NOT_FOUND');
}

/** Throws a 503 Service Unavailable HttpError. */
export function serviceUnavailable(message: string): never {
  throw new HttpError(503, message, 'SERVICE_UNAVAILABLE');
}

/** Throws a 401 Unauthorized HttpError. */
export function unauthorized(message: string): never {
  throw new HttpError(401, message, 'UNAUTHORIZED');
}

/** Throws a 403 Forbidden HttpError. */
export function forbidden(message: string): never {
  throw new HttpError(403, message, 'FORBIDDEN');
}

/** Throws a 500 Internal Server Error HttpError. */
export function internalServerError(message: string): never {
  throw new HttpError(500, message, 'INTERNAL_SERVER_ERROR');
}
