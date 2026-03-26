import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level: logLevel,
  customLevels: {
    metric: 35, // Between info and warn
  },
  mixin: () => ({
    service: 'archive-api',
    env: process.env.NODE_ENV || 'development',
  }),
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      customLevels: {
        metric: '📊',
      },
    },
  },
});

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'metric';

export interface LogContext {
  reqId?: string;
  streamerId?: string;
  vodId?: string;
  userId?: string;
  [key: string]: unknown;
}

export function childLogger(context: LogContext) {
  return logger.child(context);
}
