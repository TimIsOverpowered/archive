import { resetCacheState } from '../src/utils/cache-state.js';

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.META_DATABASE_URL = 'postgresql://localhost/test';
process.env.ENCRYPTION_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
process.env.PGBOUNCER_URL = 'postgresql://localhost/placeholder';
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.LOG_LEVEL = 'info';
process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
process.env.VOD_PATH = '/tmp/test-vods';
