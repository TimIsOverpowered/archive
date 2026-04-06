import pino from 'pino';
import pretty from 'pino-pretty';

const logLevel = process.env.LOG_LEVEL || 'info';

// Pino logger with human-readable console output via pino-pretty stream.
// All logs go to stdout (colorized, formatted) - PM2 captures this for file logging.
export const logger = pino(
  {
    level: logLevel,
    customLevels: { metric: 35 }, // Between info and warn
  },
  pretty({
    colorize: true,
    translateTime: 'mmmm dd yyyy HH:mm:ss',
    ignore: 'pid,hostname,tenant',

    singleLine: false,
  })
);

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'metric';

export interface LogContext {
  reqId?: string;
  tenantId?: string;
  vodId?: number;
  userId?: string;
  [key: string]: unknown;
}

/** Creates a child logger with additional structured context fields. */
export function childLogger(context: LogContext) {
  return logger.child(context);
}
