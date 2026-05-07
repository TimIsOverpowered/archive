import type { LogFn } from 'pino';
import { configService } from '../config/tenant-config.js';
import { type AppLogger, getLogger } from './logger.js';
import { asJsonObject } from './object.js';

type WrappedLogFn = (msg: string | Record<string, unknown>, ...args: unknown[]) => void;

export function createAutoLogger(tenantId?: string | null): AppLogger {
  if (tenantId == null || tenantId === '') {
    return getLogger();
  }

  const config = configService.getSync(tenantId);
  const displayName = config?.displayName ?? tenantId;
  const childLog = getLogger().child({ tenantId: displayName });

  const prefix = (msg: string): string => {
    if (msg.match(/^\w+:/) || msg.startsWith(`[${displayName}]`)) {
      return msg;
    }
    return `[${displayName}] ${msg}`;
  };

  function wrapMethod(method: LogFn): WrappedLogFn {
    const bound = method.bind(childLog);

    return (firstArg, ...rest): void => {
      if (typeof firstArg === 'string') {
        bound(prefix(firstArg), ...rest);
        return;
      }

      const obj = asJsonObject(firstArg);
      if (obj) {
        if (typeof obj.msg === 'string') {
          obj.msg = prefix(obj.msg);
        } else if (typeof obj.message === 'string') {
          obj.message = prefix(obj.message);
        }

        if (typeof rest[0] === 'string') {
          bound(obj, prefix(rest[0]), ...rest.slice(1));
          return;
        }

        bound(obj, ...rest);
        return;
      }

      bound(firstArg, ...rest);
    };
  }

  const wrappedLog = Object.create(childLog) as AppLogger;

  const logLevels: (keyof AppLogger)[] = ['info', 'error', 'warn', 'debug', 'trace', 'fatal'] as (keyof AppLogger)[];

  for (const level of logLevels) {
    const original = childLog[level];

    if (typeof original === 'function') {
      Object.defineProperty(wrappedLog, level, {
        value: wrapMethod(original.bind(childLog) as LogFn),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return wrappedLog;
}
