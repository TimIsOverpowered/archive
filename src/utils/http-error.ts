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

export function badRequest(message: string): never {
  throw new HttpError(400, message, 'BAD_REQUEST');
}

export function notFound(message: string): never {
  throw new HttpError(404, message, 'NOT_FOUND');
}

export function serviceUnavailable(message: string): never {
  throw new HttpError(503, message, 'SERVICE_UNAVAILABLE');
}

export function internalServerError(message: string): never {
  throw new HttpError(500, message, 'INTERNAL_SERVER_ERROR');
}
