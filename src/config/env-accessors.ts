import { z } from 'zod';

// --- DISABLE_REDIS_CACHE ---
const DisableRedisCacheSchema = z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean());

let _disableRedisCache: boolean | null = null;

export function getDisableRedisCache(): boolean {
  if (_disableRedisCache !== null) return _disableRedisCache;
  const parsed = DisableRedisCacheSchema.safeParse(process.env.DISABLE_REDIS_CACHE);
  if (!parsed.success) {
    _disableRedisCache = false;
    return false;
  }
  _disableRedisCache = parsed.data;
  return _disableRedisCache;
}

// --- ENCRYPTION_MASTER_KEY ---
const EncryptionKeySchema = z
  .string()
  .refine(
    (val) => val.length === 64 && /^[0-9a-fA-F]+$/.test(val),
    'ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string'
  );

let _keyBuffer: Buffer | null = null;

export function getEncryptionKeyBuffer(): Buffer {
  if (_keyBuffer) return _keyBuffer;
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) throw new Error('ENCRYPTION_MASTER_KEY is not set');
  const parsed = EncryptionKeySchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  _keyBuffer = Buffer.from(parsed.data, 'hex');
  return _keyBuffer;
}

// --- DISCORD_ALERT_WEBHOOK_URL ---
let _discordAlertWebhookUrl: string | undefined | null = null;

export function getDiscordAlertWebhookUrl(): string | undefined {
  if (_discordAlertWebhookUrl !== null) return _discordAlertWebhookUrl;
  const url = process.env.DISCORD_ALERT_WEBHOOK_URL;
  _discordAlertWebhookUrl = url || undefined;
  return _discordAlertWebhookUrl;
}

// --- DISCORD_ALERTS_ENABLED ---
const DiscordAlertsEnabledSchema = z.preprocess((val) => String(val).toLowerCase() !== 'false', z.boolean());

let _discordAlertsEnabled: boolean | null = null;

export function getDiscordAlertsEnabled(): boolean {
  if (_discordAlertsEnabled !== null) return _discordAlertsEnabled;
  const parsed = DiscordAlertsEnabledSchema.safeParse(process.env.DISCORD_ALERTS_ENABLED);
  _discordAlertsEnabled = parsed.success ? parsed.data : true;
  return _discordAlertsEnabled;
}

// --- FLOARESOLVERR_BASE_URL ---
let _flaresolverrBaseUrl: string | null = null;

export function getFlareSolverrBaseUrl(): string {
  if (_flaresolverrBaseUrl !== null) return _flaresolverrBaseUrl;
  _flaresolverrBaseUrl = process.env.FLOARESOLVERR_BASE_URL || 'http://localhost:8191';
  return _flaresolverrBaseUrl;
}

// --- FLOARESOLVERR_TIMEOUT_MS ---
const FlareSolverrTimeoutSchema = z.coerce.number().int().positive();

let _flaresolverrTimeoutMs: number | null = null;

export function getFlareSolverrTimeoutMs(): number {
  if (_flaresolverrTimeoutMs !== null) return _flaresolverrTimeoutMs;
  const parsed = FlareSolverrTimeoutSchema.safeParse(process.env.FLOARESOLVERR_TIMEOUT_MS);
  _flaresolverrTimeoutMs = parsed.success ? parsed.data : 300_000;
  return _flaresolverrTimeoutMs;
}

// --- FLOARESOLVERR_SESSION_TTL ---
const FlareSolverrSessionTtlSchema = z.coerce.number().int().positive();

let _flaresolverrSessionTtl: number | null = null;

export function getFlareSolverrSessionTtl(): number {
  if (_flaresolverrSessionTtl !== null) return _flaresolverrSessionTtl;
  const parsed = FlareSolverrSessionTtlSchema.safeParse(process.env.FLOARESOLVERR_SESSION_TTL);
  _flaresolverrSessionTtl = parsed.success ? parsed.data : 3600;
  return _flaresolverrSessionTtl;
}

// --- FLOARESOLVERR_CONCURRENCY ---
const FlareSolverrConcurrencySchema = z.coerce.number().int().positive();

let _flaresolverrConcurrency: number | null = null;

export function getFlareSolverrConcurrency(): number {
  if (_flaresolverrConcurrency !== null) return _flaresolverrConcurrency;
  const parsed = FlareSolverrConcurrencySchema.safeParse(process.env.FLOARESOLVERR_CONCURRENCY);
  _flaresolverrConcurrency = parsed.success ? parsed.data : 3;
  return _flaresolverrConcurrency;
}

// --- REDIS_COMPRESSION ---
const RedisCompressionAlgorithmSchema = z.enum(['brotli', 'gzip', 'none']);

let _redisChatCompression: string | null = null;
let _redisCompressionLevel: number | null = null;

export function getRedisChatCompression(): 'brotli' | 'gzip' | 'none' {
  if (_redisChatCompression !== null) return _redisChatCompression as 'brotli' | 'gzip' | 'none';
  const parsed = RedisCompressionAlgorithmSchema.safeParse(process.env.REDIS_CHAT_COMPRESSION);
  _redisChatCompression = parsed.success ? parsed.data : 'brotli';
  return _redisChatCompression as 'brotli' | 'gzip' | 'none';
}

export function getRedisCompressionLevel(): number {
  if (_redisCompressionLevel !== null) return _redisCompressionLevel;
  const parsed = z.coerce.number().int().min(0).max(11).safeParse(process.env.REDIS_COMPRESSION_LEVEL);
  _redisCompressionLevel = parsed.success ? parsed.data : 6;
  return _redisCompressionLevel;
}

// --- HEALTH_TOKEN ---
let _healthToken: string | undefined | null = null;

export function getHealthToken(): string | undefined {
  if (_healthToken !== null) return _healthToken;
  const token = process.env.HEALTH_TOKEN;
  _healthToken = token || undefined;
  return _healthToken;
}

// --- Test helper ---
export function resetEnvAccessorCache(): void {
  _disableRedisCache = null;
  _keyBuffer = null;
  _discordAlertWebhookUrl = null;
  _discordAlertsEnabled = null;
  _flaresolverrBaseUrl = null;
  _flaresolverrTimeoutMs = null;
  _flaresolverrSessionTtl = null;
  _flaresolverrConcurrency = null;
  _redisChatCompression = null;
  _redisCompressionLevel = null;
  _healthToken = null;
}
