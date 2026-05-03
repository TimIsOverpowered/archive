import { getLogger } from '../../utils/logger.js';

const PG_CONNECTION_ERROR_CODES = new Set([
  // Class 08: Connection Exception
  '08000', // connection does not exist
  '08001', // client unable to establish connection
  '08002', // connection failure (during connection attempt)
  '08003', // connection already established
  '08004', // connection failure (during operation)
  '08006', // connection does not exist (for pg_cancel_request)
  '08007', // transaction resolution unknown
  '08P01', // protocol violation
  // Class 57: Operator Intervention
  '57014', // canceling statement for other session
  '57P01', // administrator shutdown
  '57P02', // administrator cancel for all
  '57P03', // administrator cancel for the current session
]);
const NODE_CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Detect connection errors from PostgreSQL and Node.js.
 * Falls back to regex matching as a last resort with a warn log
 * so developers can observe hits and add the proper code later.
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

  if (connPatterns.some((pattern) => pattern.test(msg))) {
    getLogger().warn(
      { code, message: msg },
      '[isConnectionError] matched by regex — consider adding code to PG_CONNECTION_ERROR_CODES'
    );
    return true;
  }

  return false;
}
