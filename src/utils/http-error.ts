export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

export function unauthorized(message: string): never {
  throw new HttpError(401, message);
}

export function forbidden(message: string): never {
  throw new HttpError(403, message);
}

export function notFound(message: string): never {
  throw new HttpError(404, message);
}

export function serviceUnavailable(message: string): never {
  throw new HttpError(503, message);
}

export function internalServerError(message: string): never {
  throw new HttpError(500, message);
}
