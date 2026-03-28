import dotenv from 'dotenv';
import path from 'path';
import { startMonitorService } from './monitor/index.js';

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : process.env.NODE_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

async function bootstrap() {
  try {
    await startMonitorService();

    // Keep the process running - monitoring loops are already started via intervals
    console.info('[Monitor Service] Running. Waiting for shutdown signal...');

    // Wait indefinitely until interrupted
    await new Promise(() => {});
  } catch (error: any) {
    console.error('[Monitor Service] Fatal error:', error);
    process.exit(1);
  }
}

bootstrap();
