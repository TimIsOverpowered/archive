import { z } from 'zod';

// Shared base schema (used by both API and workers)
export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  META_DATABASE_URL: z.string().min(1, 'META_DATABASE_URL is required'),
  ENCRYPTION_MASTER_KEY: z.string().refine((val) => {
    if (!val) return false;
    if (val.length !== 64) return false;
    return /^[0-9a-fA-F]+$/.test(val);
  }, 'ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DISABLE_REDIS_CACHE: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  PUPPETEER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  CONFIG_CACHE_TTL: z.coerce.number().int().positive().default(3600),
});

// API-specific schema (extends base + API-only fields)
export const ApiConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().min(1).max(65535).default(3030),
  HOST: z.string().default('0.0.0.0'),
  STATS_CACHE_TTL: z.coerce.number().int().positive().default(60),
});

// Workers-specific schema (extends base + workers-only fields)
export const WorkersConfigSchema = BaseConfigSchema.extend({
  CLEAR_QUEUES_ON_STARTUP: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  VOD_LIVE_CONCURRENCY: z.coerce.number().int().positive().default(50),
  VOD_STANDARD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  YOUTUBE_UPLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  CHAT_DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  MONITOR_CONCURRENCY: z.coerce.number().int().positive().default(10),
});

// Type exports
export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;

// Separate caches (Option B)
let apiConfigCache: ApiConfig | null = null;
let workersConfigCache: WorkersConfig | null = null;

// API config loader
export function loadApiConfig(): ApiConfig {
  if (apiConfigCache) return apiConfigCache;

  try {
    apiConfigCache = ApiConfigSchema.parse(process.env);
    return apiConfigCache;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
      throw new Error(`API config validation failed: ${errorMessages}`);
    }
    throw error;
  }
}

export function getApiConfig(): ApiConfig {
  return apiConfigCache || loadApiConfig();
}

// Workers config loader
export function loadWorkersConfig(): WorkersConfig {
  if (workersConfigCache) return workersConfigCache;

  try {
    workersConfigCache = WorkersConfigSchema.parse(process.env);
    return workersConfigCache;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
      throw new Error(`Workers config validation failed: ${errorMessages}`);
    }
    throw error;
  }
}

export function getWorkersConfig(): WorkersConfig {
  return workersConfigCache || loadWorkersConfig();
}

export function getConfigCacheTtl(): number {
  return getApiConfig().CONFIG_CACHE_TTL;
}

// Clear cache (used by both)
export function resetEnvConfig(): void {
  apiConfigCache = null;
  workersConfigCache = null;
}
