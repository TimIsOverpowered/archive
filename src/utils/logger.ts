import pino from 'pino';
import pretty from 'pino-pretty';
import { getRequestId, getTenantId, getDisplayName } from './async-context.js';

export type AppLogger = pino.Logger;

let _logger: pino.Logger | null = null;
let _loggerConfig: { level: string; isProduction: boolean } | null = null;

export function setLoggerConfig(opts: { level: string; isProduction: boolean }): void {
  _loggerConfig = opts;
  _logger = null;
}

export function setGlobalLogger(logger: pino.Logger): void {
  _logger = logger;
}

export function createLogger(opts: { level: string; isProduction: boolean }): pino.Logger {
  return pino(
    {
      level: opts.level,
      customLevels: { metric: 35 },
      redact: ['headers.authorization', 'headers.cookie'],
      serializers: {
        req: (request: pino.SerializedRequest) => ({
          method: request.method,
          url: request.url,
        }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      },
      mixin: () => {
        const ctx = { reqId: getRequestId(), tenantId: getTenantId(), displayName: getDisplayName() };
        return Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null));
      },
    },
    opts.isProduction
      ? undefined
      : pretty({
          colorize: true,
          translateTime: 'mmmm dd yyyy HH:mm:ss',
          ignore: 'pid,hostname,tenant,reqId',
          singleLine: false,
        })
  ) as unknown as pino.Logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _loggerConfig ??= { level: 'info', isProduction: false };
    _logger = createLogger(_loggerConfig);
  }
  return _logger;
}

interface LogContext {
  reqId?: string;
  tenantId?: string;
  vodId?: number;
  userId?: string;
  [key: string]: unknown;
}

export function childLogger(context: LogContext) {
  return new Proxy<AppLogger>({} as AppLogger, {
    get(_target, key: string | symbol) {
      const logger = getLogger();
      const child = logger.child(context);
      const childAny = child as unknown as Record<string, unknown>;
      const val = childAny[key as string];
      if (typeof val === 'function') {
        return (val as (...args: unknown[]) => unknown).bind(child);
      }
      return val;
    },
  });
}
