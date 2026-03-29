import type { Logger } from 'pino';
import { getTenantDisplayName } from '../config/loader.js';
import { logger as baseLogger } from './logger.js';

/**
 * Creates a logger instance that automatically prefixes messages with [TenantDisplayName].
 * Output format: [March 29 2026 HH:mm:ss] LEVEL: [TenantName] message text here
 */
export function createAutoLogger(tenantId?: string | null): Logger & Record<string, unknown> {
  if (!tenantId || tenantId === 'null') {
    return baseLogger as never;
  }

  const displayName = getTenantDisplayName(tenantId);

  // Create base child logger with tenant field for structured filtering
  const childLog = baseLogger.child({ tenant: displayName });

  /** Wraps log methods to prepend [TenantName] prefix */
  function wrapMethod(methodName: string): ((...args: any[]) => void) | undefined {
    if (!(methodName in childLog)) return undefined;

    const original = (childLog as unknown as Record<string, any>)[methodName];
    if (!original || typeof original !== 'function') return undefined;

    const boundOriginal = original.bind(childLog);

    return (...args: any[]) => {
      // Skip prefixing for system/metadata logs or already prefixed messages
      if (typeof args[0] === 'string' && !args[0].match(/^\w+:/) && !args[0].startsWith(`[${displayName}]`)) {
        const msg = `[${displayName}] ${args[0]}`;
        return boundOriginal(msg, ...args.slice(1));
      }

      // Handle object logs with message property
      if (typeof args[0] === 'object' && !Array.isArray(args[0]) && args[0] !== null) {
        const obj = args[0];
        for (const key of ['msg', 'message']) {
          if (typeof obj[key] === 'string') {
            if (!obj[key].match(/^\w+:/) && !obj[key].startsWith(`[${displayName}]`)) {
              return boundOriginal({ ...obj, [key]: `[${displayName}] ${obj[key]}` }, ...args.slice(1));
            }
          }
        }

        // Handle second arg as message string
        if (args.length > 1 && typeof args[1] === 'string' && !args[1].match(/^\w+:/) && !args[1].startsWith(`[${displayName}]`)) {
          const newArgs = [...args];
          newArgs[1] = `[${displayName}] ${args[1]}`;
          return boundOriginal(...newArgs);
        }

        (obj as Record<string, unknown>).tenantDisplayName = displayName;
      }

      return boundOriginal(...args);
    };
  }

  try {
    const methods: string[] = ['info', 'error', 'warn', 'debug', 'trace'];
    const wrappedLog: Record<string, any> = { ...childLog };

    for (const method of methods) {
      wrappedLog[method] = wrapMethod(method);
    }

    return wrappedLog as never;
  } catch (_err) {
    // Fallback to unwrapped logger if wrapping fails
    const errStr = _err instanceof Error ? _err.message : String(_err);
    console.warn(`[createAutoLogger] Failed to wrap methods:`, errStr);

    return childLog as never;
  }
}
