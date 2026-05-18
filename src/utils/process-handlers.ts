import { extractErrorDetails } from './error.js';
import { getLogger } from './logger.js';

export function registerProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    getLogger().error({ error: extractErrorDetails(reason) }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    getLogger().fatal({ error: extractErrorDetails(err) }, 'Uncaught exception');
    process.exit(1);
  });
}
