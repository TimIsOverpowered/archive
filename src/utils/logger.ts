import pino from 'pino';
import { getTenantDisplayName } from '../config/loader';

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

/**
 * Creates a logger instance that automatically prefixes all messages with [TenantDisplayName]
 * and includes tenant as a structured field for filtering.
 */
export function loggerWithTenant(tenantId?: string): pino.Logger & Record<string, unknown> {
  if (!tenantId) return childLogger({}) as never;

  const displayName = getTenantDisplayName(tenantId);

  // Create base child logger with tenant context field (for structured filtering)
  const baseChildLogger: pino.Logger = childLogger({
    tenant: displayName,
  }) as unknown as pino.Logger;

  /**
   * Formats a log message to add [TenantDisplayName] prefix before component prefixes like [YouTube], [Twitch], etc.
   */
  function formatMessage(msg?: string): string {
    if (!msg || !displayName) return msg ?? '';

    const tenantPrefix = `[${displayName}]`;

    // Skip duplicate prefixes (already formatted with this tenant name)
    if (msg.startsWith(tenantPrefix)) return msg;

    let formattedMsg: string;

    // Check for component prefix pattern like [YouTube], [Twitch], etc.
    const match = msg.match(/^\[([^\]]+)\](.*)$/);
    if (match) {
      const [, componentName, messageBody] = match;
      formattedMsg = `${tenantPrefix} [${componentName}] ${messageBody.trim()}`.replace(/  +/g, ' ');
    } else {
      // No component prefix - just add tenant at start for readable log statements
      formattedMsg = `${tenantPrefix} ${msg}`;
    }

    return formattedMsg.trim();
  }

  const baseLog: pino.Logger = baseChildLogger as unknown as pino.Logger;

  if (!baseLog) {
    console.warn(`[loggerWithTenant] No logger found for tenant ${tenantId}`);
    return childLogger({}) as never;
  }

  // Create a wrapper object that intercepts log calls and formats messages before passing to base logger
  const wrappedLogger: Record<string, unknown> = { ...baseLog };

  type LogMethodFn = (...args: any[]) => void;

  function wrapLogMethod(methodName: string): LogMethodFn | undefined {
    if (!(methodName in baseLog)) return undefined;

    const originalMethod = (baseLog as unknown as Record<string, any>)[methodName];

    if (!originalMethod || typeof originalMethod !== 'function') {
      return undefined;
    }

    return (...args: any[]) => {
      const modifiedArgs = [...args] as any[];

      if (modifiedArgs.length > 0 && typeof modifiedArgs[0] === 'string') {
        const originalMsg = modifiedArgs[0];

        // Format messages that start with bracket notation or are readable log statements
        if (!originalMsg.match(/^\w+:/)) {
          modifiedArgs[0] = formatMessage(originalMsg);
        } else if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
          // If first arg looks like metadata, try formatting the second arg instead
          const msg2 = modifiedArgs[1];
          if (!msg2.match(/^\w+:/)) {
            modifiedArgs[1] = formatMessage(msg2);
          } else {
            (modifiedArgs as any)[0].tenantDisplayName = displayName || tenantId;
          }
        }
      } else if (modifiedArgs.length > 0 && typeof modifiedArgs[0] === 'object' && !Array.isArray(modifiedArgs[0]) && modifiedArgs[0] !== null) {
        const obj: Record<string, unknown> = modifiedArgs[0];

        // Case: First arg is an object with msg/message property - prefix that field if it's a readable log statement
        let messageField: string | undefined;
        for (const prop of ['msg', 'message']) {
          if (typeof obj[prop] === 'string') {
            const candidateMsg = obj[prop];

            // Skip system/metadata logs like "Request error" or structured messages with colons at start
            if (!candidateMsg.match(/^\w+:/)) {
              messageField = prop;
              break;
            }
          }
        }

        if (messageField) {
          const originalMsg = obj[messageField] as string;

          // For structured logs, only prefix messages that start with bracket notation to avoid cluttering normal system logs
          if (originalMsg.startsWith('[')) {
            modifiedArgs[0] = Object.assign({}, obj, { [messageField]: formatMessage(originalMsg) });
          } else {
            // Add tenant as context field for structured metadata logs without component prefix
            const objWithTenant: Record<string, unknown> = Object.assign({}, obj);

            if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
              // If there's a message in second arg that starts with brackets or is readable, format it
              const msg2 = modifiedArgs[1];
              if (!msg2.match(/^\w+:/) || msg2.startsWith('[')) {
                objWithTenant.message = formatMessage(msg2);
              } else {
                (objWithTenant as Record<string, unknown>).tenantDisplayName = displayName || tenantId;
              }
            }

            modifiedArgs[0] = objWithTenant;
          }
        } else if (!('msg' in obj) && !('message' in obj)) {
          // Case: Object doesn't have message field - add tenant as context and format second arg if it's a string message
          const metaObjWithTenant: Record<string, unknown> = Object.assign({}, obj);

          modifiedArgs[0] = metaObjWithTenant;

          // If there's a second arg that looks like a readable log statement (not metadata), format it
          if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
            const msg2 = modifiedArgs[1];

            // Format messages with bracket notation or without colon prefix at start
            if (!msg2.match(/^\w+:/) || msg2.startsWith('[')) {
              modifiedArgs[1] = formatMessage(msg2);
            } else {
              (metaObjWithTenant as Record<string, unknown>).tenantDisplayName = displayName || tenantId;
            }
          }
        }

        return originalMethod(...modifiedArgs) as never;
      }

      // Fallback - call with modified args if we got here through some other path
      return originalMethod(...modifiedArgs);
    };
  }

  try {
    const methodsToWrap: string[] = ['info', 'error', 'warn', 'debug', 'trace'];

    for (const method of methodsToWrap) {
      wrappedLogger[method] = wrapLogMethod(method);
    }
  } catch (_err: unknown) {
    // If wrapping fails for any reason, log a warning to console but don't break request processing
    const errStr = _err instanceof Error ? _err.message : String(_err);
    console.warn(`[loggerWithTenant] Failed to wrap logger methods for tenant ${tenantId}:`, errStr);
  }

  return wrappedLogger as never;
}
