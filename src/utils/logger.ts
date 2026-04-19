import pino from 'pino';
import pretty from 'pino-pretty';

const logLevel = process.env.LOG_LEVEL || 'info';
const isProduction = process.env.NODE_ENV === 'production';

export type AppLogger = typeof logger;

export const logger = pino(
  {
    level: logLevel,
    customLevels: { metric: 35 },
  },
  isProduction
    ? undefined
    : pretty({
        colorize: true,
        translateTime: 'mmmm dd yyyy HH:mm:ss',
        ignore: 'pid,hostname,tenant',
        singleLine: false,
      })
);

interface LogContext {
  reqId?: string;
  tenantId?: string;
  vodId?: number;
  userId?: string;
  [key: string]: unknown;
}

export function childLogger(context: LogContext) {
  return logger.child(context);
}
