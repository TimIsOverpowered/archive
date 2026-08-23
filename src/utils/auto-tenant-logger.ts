import type { LogFn } from 'pino';
import { configService } from '../config/tenant-config.ts';
import { type AppLogger, getLogger } from './logger.ts';
import { asJsonObject } from './object.ts';

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
    const bound: (...args: unknown[]) => void = method.bind(childLog);

    return (firstArg: string | Record<string, unknown>, ...rest: unknown[]): void => {
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

        const secondArg = rest[0];
        if (typeof secondArg === 'string') {
          bound(obj, prefix(secondArg), ...rest.slice(1));
          return;
        }

        bound(obj, ...rest);
        return;
      }

      bound(firstArg, ...rest);
    };
  }

  const wrappedLog = Object.create(childLog) as AppLogger;

  const logLevels = ['info', 'error', 'warn', 'debug', 'trace', 'fatal'] as const;

  for (const level of logLevels) {
    const bound = childLog[level].bind(childLog);

    Object.defineProperty(wrappedLog, level, {
      value: wrapMethod(bound),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return wrappedLog;
}
