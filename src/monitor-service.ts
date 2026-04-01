import dotenv from 'dotenv';
import path from 'path';
import { startMonitorService } from './monitor/index.js';
import { logger } from './utils/logger.js';
import { extractErrorDetails } from './utils/error.js';

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : process.env.NODE_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

async function bootstrap() {
  try {
    await startMonitorService();

    // Keep the process running - monitoring loops are already started via intervals
    logger.info('[Monitor Service] Running. Waiting for shutdown signal...');

    // Wait indefinitely until interrupted
    await new Promise(() => {});
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    logger.error({ ...details }, '[Monitor Service] Fatal error');
    process.exit(1);
  }
}

bootstrap();
