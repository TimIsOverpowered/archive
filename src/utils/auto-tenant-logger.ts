import type { LogFn } from 'pino';
import { getTenantDisplayName } from '../config/loader.js';
import { type AppLogger, getLogger } from './logger.js';

// Define a specific call signature for the wrapper to satisfy ESLint
type InternalLogCall = (arg1: unknown, ...args: unknown[]) => void;

export function createAutoLogger(tenantId?: string | null): AppLogger {
  if (!tenantId) {
    return getLogger();
  }

  const displayName = getTenantDisplayName(tenantId);
  const childLog = getLogger().child({ tenantId: displayName });

  const prefix = (msg: string): string => {
    if (msg.match(/^\w+:/) || msg.startsWith(`[${displayName}]`)) {
      return msg;
    }
    return `[${displayName}] ${msg}`;
  };

  function wrapMethod(method: LogFn): LogFn {
    return (firstArg: unknown, ...rest: unknown[]): void => {
      // Cast the method to our explicit InternalLogCall signature.
      // This satisfies the 'no-unsafe-function-type' rule because it defines params/return.
      const log = method as InternalLogCall;

      if (typeof firstArg === 'string') {
        const msg = prefix(firstArg);
        return log.call(childLog, msg, ...rest);
      }

      if (typeof firstArg === 'object' && firstArg !== null) {
        const obj = { ...(firstArg as Record<string, unknown>) };

        if (typeof obj.msg === 'string') {
          obj.msg = prefix(obj.msg);
        } else if (typeof obj.message === 'string') {
          obj.message = prefix(obj.message);
        }

        const secondArg = rest[0];
        if (typeof secondArg === 'string') {
          const msg = prefix(secondArg);
          return log.call(childLog, obj, msg, ...rest.slice(1));
        }

        return log.call(childLog, obj, ...rest);
      }

      return log.call(childLog, firstArg, ...rest);
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
