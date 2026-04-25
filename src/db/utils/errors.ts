const PG_CONNECTION_ERROR_CODES = new Set(['57P01', '08006', '08007', '08001']);
const NODE_CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

/**
 * Detect connection errors from PostgreSQL and Node.js
 */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (
    code !== null &&
    code !== undefined &&
    (PG_CONNECTION_ERROR_CODES.has(code) || NODE_CONNECTION_ERROR_CODES.has(code))
  ) {
    return true;
  }

  if (!(error instanceof Error)) return false;

  const msg = error.message;
  const connPatterns = [
    /connection (terminated|lost|closed)/i,
    /socket (connection closed|closed by|network socket closed)/i,
    /client network socket closed/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /The socket has been closed/i,
  ];

  return connPatterns.some((pattern) => pattern.test(msg));
}
