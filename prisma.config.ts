import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Streamer Database Config
 *
 * This config is used for running migrations on tenant-specific streamer databases.
 * Set one of the following environment variables before running Prisma CLI commands:
 *
 * - DATABASE_URL: Direct database connection string
 * - STREAMER_ID: Tenant name (requires META_DATABASE_URL to be set as well)
 *
 * Example:
 *   # Direct URL
 *   DATABASE_URL="postgresql://..." npx prisma migrate deploy
 *
 */

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
