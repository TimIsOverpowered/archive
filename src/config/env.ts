import { z } from 'zod';

function envBool(defaultsTo: boolean) {
  return z.preprocess(
    (val) => (defaultsTo ? String(val).toLowerCase() !== 'false' : String(val).toLowerCase() === 'true'),
    z.boolean()
  );
}

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
  DISCORD_ALERT_WEBHOOK_URL: z.string().url().optional(),
  REDIS_CHAT_COMPRESSION: z.enum(['brotli', 'gzip', 'none']).default('brotli'),
  REDIS_COMPRESSION_LEVEL: z.coerce.number().int().min(0).max(11).default(6),
  DISABLE_REDIS_CACHE: envBool(false).default(false),
  FLARESOLVERR_CONCURRENCY: z.coerce.number().int().positive().default(3),
  CONFIG_CACHE_TTL: z.coerce.number().int().positive().default(3600),
  PGBOUNCER_URL: z.string().min(1, 'PGBOUNCER_URL is required'),
  DISCORD_ALERTS_ENABLED: envBool(true).default(true),
  FLARESOLVERR_BASE_URL: z.string().url().default('http://localhost:8191'),
  FLARESOLVERR_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FLARESOLVERR_SESSION_TTL: z.coerce.number().int().positive().default(3600),
});

// API-specific schema (extends base + API-only fields)
export const ApiConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().min(1).max(65535).default(3030),
  HOST: z.string().default('0.0.0.0'),
  STATS_CACHE_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_VODS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHAT: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ADMIN_GET: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_BLOCK_DURATION: z.coerce.number().int().positive().default(60),
  CHAT_CURSOR_TTL: z.coerce.number().int().positive().default(259200),
  CHAT_OFFSET_TTL: z.coerce.number().int().positive().default(259200),
  CHAT_BUCKET_SIZE_TTL: z.coerce.number().int().positive().default(2592000),
  HEALTH_TOKEN: z.string().optional(),
});

// Workers-specific schema (extends base + workers-only fields)
export const WorkersConfigSchema = BaseConfigSchema.extend({
  CLEAR_QUEUES_ON_STARTUP: envBool(false).default(false),
  VOD_STANDARD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  YOUTUBE_UPLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  CHAT_DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  MONITOR_CONCURRENCY: z.coerce.number().int().positive().default(10),
  YOUTUBE_CLIENT_ID: z.string().min(1, 'YOUTUBE_CLIENT_ID is required'),
  YOUTUBE_CLIENT_SECRET: z.string().min(1, 'YOUTUBE_CLIENT_SECRET is required'),
});

// Type exports
export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;

// Separate caches (Option B)
let apiConfigCache: ApiConfig | null = null;
let workersConfigCache: WorkersConfig | null = null;
let baseConfigCache: BaseConfig | null = null;

// API config loader
export function loadApiConfig(): ApiConfig {
  if (apiConfigCache) return apiConfigCache;

  try {
    apiConfigCache = ApiConfigSchema.parse(process.env);
    return apiConfigCache;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
      throw new Error(`API config validation failed:\n${errorMessages}`);
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
      const errorMessages = error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
      throw new Error(`Workers config validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

export function getWorkersConfig(): WorkersConfig {
  return workersConfigCache || loadWorkersConfig();
}

export function getBaseConfig(): BaseConfig {
  if (apiConfigCache) return apiConfigCache;
  if (workersConfigCache) return workersConfigCache;
  if (baseConfigCache) return baseConfigCache;
  baseConfigCache = BaseConfigSchema.parse(process.env);
  return baseConfigCache;
}

// --- Lazy accessor helpers (consolidated from env-accessors.ts) ---

// ENCRYPTION_MASTER_KEY read directly (works even when full config can't load)
let _keyBuffer: Buffer | null = null;

export function getEncryptionKeyBuffer(): Buffer {
  if (_keyBuffer) return _keyBuffer;
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) throw new Error('ENCRYPTION_MASTER_KEY is not set');
  _keyBuffer = Buffer.from(raw, 'hex');
  return _keyBuffer;
}

export function getDiscordAlertWebhookUrl(): string | undefined {
  return getBaseConfig().DISCORD_ALERT_WEBHOOK_URL;
}

export function getFlareSolverrConcurrency(): number {
  return getBaseConfig().FLARESOLVERR_CONCURRENCY;
}

export function getRedisChatCompression(): 'brotli' | 'gzip' | 'none' {
  return getBaseConfig().REDIS_CHAT_COMPRESSION;
}

export function getRedisCompressionLevel(): number {
  return getBaseConfig().REDIS_COMPRESSION_LEVEL;
}

export function getHealthToken(): string | undefined {
  return getApiConfig().HEALTH_TOKEN;
}

// Clear cache (used by both)
export function resetEnvConfig(): void {
  apiConfigCache = null;
  workersConfigCache = null;
  baseConfigCache = null;
}
