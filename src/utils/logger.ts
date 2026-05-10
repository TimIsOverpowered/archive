import pino from 'pino';
import type { SerializedRequest, SerializedResponse } from 'pino';
import { getRequestId, getTenantId, getDisplayName } from './async-context.js';

export type AppLogger = pino.Logger<'metric'>;

let _logger: AppLogger | null = null;
let _loggerConfig: { level: string; isProduction: boolean } | null = null;

export function setLoggerConfig(opts: { level: string; isProduction: boolean }): void {
  _loggerConfig = opts;
  _logger = null;
}

export function setGlobalLogger(logger: AppLogger): void {
  _logger = logger;
}

export function createLogger(opts: { level: string; isProduction: boolean }): AppLogger {
  const pinoOpts: pino.LoggerOptions<'metric'> = {
    level: opts.level,
    customLevels: { metric: 35 },
    redact: ['headers.authorization', 'headers.cookie'],
    serializers: {
      req: (request: SerializedRequest) => ({
        method: request.method,
        url: request.url,
      }),
      res: (reply: SerializedResponse) => ({ statusCode: reply.statusCode }),
    },
    mixin: () => {
      const ctx = { reqId: getRequestId(), tenantId: getTenantId(), displayName: getDisplayName() };
      return Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null));
    },
  };

  if (opts.isProduction) {
    return pino(pinoOpts);
  }

  const transport = pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'mmmm dd yyyy HH:mm:ss',
      ignore: 'pid,hostname,tenant,reqId',
      singleLine: false,
    },
  });

  return pino(pinoOpts, transport);
}

export function getLogger(): AppLogger {
  if (!_logger) {
    _loggerConfig ??= { level: 'info', isProduction: false };
    _logger = createLogger(_loggerConfig);
  }
  return _logger;
}

export interface LogContext {
  reqId?: string;
  tenantId?: string;
  vodId?: number;
  userId?: string;
  [key: string]: unknown;
}

export function childLogger(context: LogContext): AppLogger {
  return getLogger().child(context);
}
