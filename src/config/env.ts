import path from 'node:path';
import { z } from 'zod';

function normalizePathForSchema(basePath?: string): string | undefined {
  if (basePath == null || basePath === '') return undefined;
  const normalized = path.normalize(basePath);
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ? normalized : path.resolve(normalized);
}

/**
 * Parses a boolean env var.
 * When defaultsTo=true, only the string "false" disables it.
 * When defaultsTo=false, only the string "true" enables it.
 */
function envBoolWithDefault(defaultsTo: boolean) {
  return z.preprocess(
    (val) => (defaultsTo ? String(val).toLowerCase() !== 'false' : String(val).toLowerCase() === 'true'),
    z.boolean()
  );
}

function throwConfigError(label: string, error: unknown): never {
  if (error instanceof z.ZodError) {
    const flat = error.flatten();
    const msgs = Object.entries(flat.fieldErrors)
      .map(([path, errs]) => `  - ${path}: ${(errs as string[])?.join(', ')}`)
      .join('\n');
    throw new Error(`${label} config validation failed:\n${msgs}`);
  }
  throw error;
}

// Shared base schema (used by both API and workers)
const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  META_DATABASE_URL: z.string().min(1, 'META_DATABASE_URL is required'),
  ENCRYPTION_MASTER_KEY: z.string().refine((val) => {
    if (val === '') return false;
    if (val.length !== 64) return false;
    return /^[0-9a-fA-F]+$/.test(val);
  }, 'ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DISCORD_ALERT_WEBHOOK_URL: z.string().url().optional(),
  REDIS_COMPRESSION: z.enum(['brotli', 'gzip', 'none']).default('brotli'),
  REDIS_COMPRESSION_LEVEL: z.coerce.number().int().min(0).max(11).default(6),
  FLARESOLVERR_CONCURRENCY: z.coerce.number().int().positive().default(3),

  PGBOUNCER_URL: z.string().min(1, 'PGBOUNCER_URL is required'),
  DISCORD_ALERTS_ENABLED: envBoolWithDefault(true).default(true),
  REQUIRE_CLOUDFLARE_IP: envBoolWithDefault(true).default(true),
  FLARESOLVERR_BASE_URL: z.string().url().default('http://localhost:8191'),
  FLARESOLVERR_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FLARESOLVERR_SESSION_TTL: z.coerce.number().int().positive().default(3600),
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),

  /** Base path for temporary processing files (local SSD), normalized to absolute */
  TMP_PATH: z.string().min(1, 'TMP_PATH is required').transform(normalizePathForSchema),

  /** Base path for storing VOD files, normalized to absolute */
  VOD_PATH: z.string().min(1, 'VOD_PATH is required').transform(normalizePathForSchema),

  /** Base path for storing live stream files, normalized to absolute */
  LIVE_PATH: z
    .string()
    .optional()
    .transform((p): string | undefined => (p != null && p !== '' ? normalizePathForSchema(p) : undefined)),
});

// API-specific schema (extends base + API-only fields)
const ApiConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().min(1).max(65535).default(3030),
  HOST: z.string().default('0.0.0.0'),
  STATS_CACHE_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_VODS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHAT: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ADMIN_GET: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ADMIN_AUTH: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_BLOCK_DURATION: z.coerce.number().int().positive().default(60),

  HEALTH_TOKEN: z.string().optional(),
});

// Workers-specific schema (extends base + workers-only fields)
const WorkersConfigSchema = BaseConfigSchema.extend({
  CLEAR_QUEUES_ON_STARTUP: envBoolWithDefault(false).default(false),
  VOD_STANDARD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  YOUTUBE_UPLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  VOD_FINALIZE_FILE_CONCURRENCY: z.coerce.number().int().positive().default(1),
  CHAT_DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  MONITOR_CONCURRENCY: z.coerce.number().int().positive().default(10),
  FILE_COPY_CONCURRENCY: z.coerce.number().int().positive().default(2),
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
    baseConfigCache ??= apiConfigCache as BaseConfig;
    return apiConfigCache;
  } catch (error) {
    throwConfigError('API', error);
  }
}

export function getApiConfig(): ApiConfig {
  return apiConfigCache ?? loadApiConfig();
}

// Workers config loader
export function loadWorkersConfig(): WorkersConfig {
  if (workersConfigCache) return workersConfigCache;

  try {
    workersConfigCache = WorkersConfigSchema.parse(process.env);
    baseConfigCache ??= workersConfigCache as BaseConfig;
    return workersConfigCache;
  } catch (error) {
    throwConfigError('Workers', error);
  }
}

export function getWorkersConfig(): WorkersConfig {
  return workersConfigCache ?? loadWorkersConfig();
}

function loadBaseConfig(): BaseConfig {
  if (baseConfigCache) return baseConfigCache;
  try {
    baseConfigCache = BaseConfigSchema.parse(process.env);
    return baseConfigCache;
  } catch (error) {
    throwConfigError('Base', error);
  }
}

export function getBaseConfig(): BaseConfig {
  return baseConfigCache ?? apiConfigCache ?? workersConfigCache ?? loadBaseConfig();
}

// --- Lazy accessor helpers (consolidated from env-accessors.ts) ---

// ENCRYPTION_MASTER_KEY read directly (works even when full config can't load)
let _keyBuffer: Buffer | null = null;

export function getEncryptionKeyBuffer(): Buffer {
  if (_keyBuffer) return _keyBuffer;
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (raw == null || raw === '') throw new Error('ENCRYPTION_MASTER_KEY is not set');
  _keyBuffer = Buffer.from(raw, 'hex');
  return _keyBuffer;
}

export function getDiscordAlertWebhookUrl(): string | undefined {
  return getBaseConfig().DISCORD_ALERT_WEBHOOK_URL;
}

export function getRedisCompression(): 'brotli' | 'gzip' | 'none' {
  return getBaseConfig().REDIS_COMPRESSION;
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
  _keyBuffer = null;
}

// --- Storage path accessors ---

export function getTmpPath(): string | undefined {
  return getBaseConfig().TMP_PATH;
}

export function getVodPath(): string | undefined {
  return getBaseConfig().VOD_PATH;
}

export function getLivePath(): string | undefined {
  return getBaseConfig().LIVE_PATH;
}
