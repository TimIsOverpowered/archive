import { getLogger } from './logger.js';
import { Server } from '../constants.js';

export interface ShutdownResource {
  name: string;
  close: () => Promise<void>;
}

export function registerShutdownHandlers(resources: ShutdownResource[], timeoutMs = Server.SHUTDOWN_TIMEOUT_MS): void {
  const shutdown = async (signal: string) => {
    const logger = getLogger();
    logger.info({ signal }, 'Received shutdown signal');

    const timer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, timeoutMs);

    for (const { name, close } of resources) {
      try {
        await close();
        logger.info({ name }, 'Resource closed');
      } catch (err) {
        logger.error({ name, error: String(err) }, 'Error closing resource');
      }
    }

    clearTimeout(timer);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
