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

export function getLogger(): pino.Logger {
  if (!_logger) {
    _loggerConfig ??= { level: 'info', isProduction: false };
    _logger = pino(
      {
        level: _loggerConfig.level,
        customLevels: { metric: 35 },
        mixin: () => {
          const ctx = { reqId: getRequestId(), tenantId: getTenantId(), displayName: getDisplayName() };
          return Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null));
        },
      },
      _loggerConfig.isProduction
        ? undefined
        : pretty({
            colorize: true,
            translateTime: 'mmmm dd yyyy HH:mm:ss',
            ignore: 'pid,hostname,tenant,reqId',
            singleLine: false,
          })
    ) as unknown as pino.Logger;
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
  return getLogger().child(context);
}
