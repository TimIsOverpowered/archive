import pino from 'pino';
import { getTenantDisplayName } from '../config/loader.js';
import { resolveCurrentDisplayName } from './async-context.js';

// Import base logger to reuse its configuration
const logLevel = process.env.LOG_LEVEL || 'info';

export const baseLogger = pino({
  level: logLevel,
  customLevels: {
    metric: 35, // Between info and warn
  },
  mixin: () => ({
    service: 'archive-api',
    env: process.env.NODE_ENV || 'development',
    tenant: resolveCurrentDisplayName() || undefined, // Auto-inject from async context
  }),
});

/**
 * Creates a logger instance that automatically prefixes all messages with [TenantDisplayName]
 * and includes tenant as a structured field for filtering.
 *
 * Tenant resolution priority (first found wins):
 * 1. Explicit options.tenantId parameter
 * 2. Async context from runWithTenantContext() calls
 * 3. Fallback to undefined if no tenant info available anywhere
 */
export function createAutoLogger(options?: { tenantId?: string | null; component?: string }): pino.Logger & Record<string, unknown> {
  // Determine display name with priority order: explicit param > async context > fallback

  let displayName: string | undefined = undefined;

  if (options?.tenantId && options.tenantId !== 'null') {
    // Priority 1: Explicit parameter provided - use it directly
    const cachedName = getTenantDisplayName(options.tenantId);
    displayName = cachedName || String(options.tenantId);
  } else {
    // Priority 2: Check async context (set by middleware or worker scope)
    const fromContext = resolveCurrentDisplayName();
    if (fromContext && fromContext !== 'null') {
      displayName = fromContext;
    }
  }

  // Create base child logger with tenant context field for structured filtering
  const childLogger = baseLogger.child({
    ...(displayName ? { tenant: displayName } : {}),
  });

  /**
   * Formats a log message to add [TenantDisplayName] prefix before component prefixes like [YouTube], [Twitch], etc.
   */
  function formatMessage(msg?: string): string | undefined {
    if (!msg || !displayName) return msg;

    const tenantPrefix = `[${displayName}]`;

    // Skip duplicate prefixes (already formatted with this tenant name)
    if (msg.startsWith(tenantPrefix)) return msg;

    let formattedMsg: string;

    // Check for component prefix pattern like [YouTube], [Twitch], etc.
    const match = msg.match(/^\[([^\]]+)\](.*)$/);

    if (match && options?.component) {
      // Has existing component - insert tenant before it
      const [, componentName, messageBody] = match;
      formattedMsg = `${tenantPrefix} [${componentName}] ${messageBody.trim()}`.replace(/  +/g, ' ');
    } else if (match) {
      // Has component prefix but no override - just add tenant at front
      const [, componentName, messageBody] = match;
      formattedMsg = `${tenantPrefix} [${componentName}] ${messageBody.trim()}`.replace(/  +/g, ' ');
    } else if (options?.component) {
      // No component in message but we have one specified - add both tenant and component prefixes
      const prefixedComponent = `[${displayName}] [${options.component}]`;
      formattedMsg = `${prefixedComponent} ${msg}`;
    } else {
      // Simple readable log statement with no brackets or explicit component - just prefix tenant name for clarity
      formattedMsg = `${tenantPrefix} ${msg}`;
    }

    return formattedMsg.trim();
  }

  /**
   * Wraps a pino logger method to intercept and format messages before passing through.
   */
  function wrapLogMethod(methodName: string): ((...args: any[]) => void) | undefined {
    if (!(methodName in childLogger)) return undefined;

    const originalMethod = (childLogger as unknown as Record<string, any>)[methodName];

    if (!originalMethod || typeof originalMethod !== 'function') {
      return undefined;
    }

    return (...args: any[]) => {
      const modifiedArgs = [...args] as any[];

      if (modifiedArgs.length > 0) {
        const firstArg = modifiedArgs[0];

        // Case A: First arg is a string message - format it directly unless it's metadata
        if (typeof firstArg === 'string') {
          const originalMsg = firstArg;

          // Skip system/metadata logs like "Request error" or structured messages with colons at start to avoid cluttering startup/shutdown output
          if (!originalMsg.match(/^\w+:/)) {
            modifiedArgs[0] = formatMessage(originalMsg);
          } else if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
            // If first arg looks like metadata, try formatting the second arg instead of cluttering system logs with tenant prefixes unnecessarily
            const msg2 = modifiedArgs[1];

            if (!msg2.match(/^\w+:/)) {
              modifiedArgs[1] = formatMessage(msg2);
            } else {
              // Both args are metadata - add structured field only, don't prefix text
              (modifiedArgs as any)[0].tenantDisplayName = displayName || undefined;
            }
          }

          // Case B: First arg is an object with msg/message property - format that field if readable log statement
        } else if (typeof firstArg === 'object' && !Array.isArray(firstArg) && firstArg !== null) {
          const obj: Record<string, unknown> = firstArg;

          let messageField: string | undefined;
          for (const prop of ['msg', 'message']) {
            if (typeof obj[prop] === 'string') {
              const candidateMsg = obj[prop];

              // Skip system/metadata logs to avoid cluttering normal startup/shutdown messages unnecessarily
              if (!candidateMsg.match(/^\w+:/)) {
                messageField = prop;
                break;
              }
            }
          }

          if (messageField) {
            const originalMsg = obj[messageField] as string;

            // Only prefix bracket notation for structured logs to keep system metadata clean
            if (originalMsg.startsWith('[')) {
              modifiedArgs[0] = Object.assign({}, obj, { [messageField]: formatMessage(originalMsg) });
            } else {
              const objWithTenant: Record<string, unknown> = Object.assign({}, obj);

              // Check second arg for readable messages that should be formatted
              if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
                const msg2 = modifiedArgs[1];

                if (!msg2.match(/^\w+:/) || msg2.startsWith('[')) {
                  objWithTenant.message = formatMessage(msg2);
                } else {
                  (objWithTenant as Record<string, unknown>).tenantDisplayName = displayName || undefined;
                }
              }

              modifiedArgs[0] = objWithTenant;
            }
          } else if (!('msg' in obj) && !('message' in obj)) {
            // Object doesn't have message field - add tenant as context and format second arg if readable
            const metaObjWithTenant: Record<string, unknown> = Object.assign({}, obj);

            modifiedArgs[0] = metaObjWithTenant;

            if (modifiedArgs.length > 1 && typeof modifiedArgs[1] === 'string') {
              const msg2 = modifiedArgs[1];

              // Format bracket notation or readable statements without colon prefix at start
              if (!msg2.match(/^\w+:/) || msg2.startsWith('[')) {
                modifiedArgs[1] = formatMessage(msg2);
              } else {
                (metaObjWithTenant as Record<string, unknown>).tenantDisplayName = displayName || undefined;
              }
            }
          }

          return originalMethod(...modifiedArgs) as never;
        }
      }

      // Fallback - call with modified args if we got here through some other path
      return originalMethod(...modifiedArgs);
    };
  }

  try {
    const methodsToWrap: string[] = ['info', 'error', 'warn', 'debug', 'trace'];

    const wrappedLogger: Record<string, unknown> = { ...childLogger };

    for (const method of methodsToWrap) {
      wrappedLogger[method] = wrapLogMethod(method);
    }

    return wrappedLogger as never;
  } catch (_err: unknown) {
    // If wrapping fails for any reason, log warning to console but don't break request processing or job execution
    const errStr = _err instanceof Error ? _err.message : String(_err);

    if (!displayName || displayName === 'null') {
      console.warn(`[createAutoLogger] Failed to wrap logger methods:`, errStr);
    } else {
      // Use base logger directly for error reporting when tenant context unavailable in wrapper itself
      const fallbackLog = childLogger;

      (fallbackLog as any).warn(
        {
          tenantDisplayName: displayName || undefined,
          component: options?.component,
          error: errStr,
        },
        '[createAutoLogger] Failed to wrap logger methods'
      );
    }

    return childLogger as never; // Return unwrapped but still functional logger with structured fields intact
  }
}

/**
 * Convenience function for getting current tenant display name from async context.
 * Returns null if no active tenant context exists (e.g., outside request/job scope).
 */
export function getCurrentTenantDisplayName(): string | undefined {
  const displayName = resolveCurrentDisplayName();
  return displayName && displayName !== 'null' ? displayName : undefined;
}
