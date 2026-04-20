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

// --- PUPPETEER_MEMORY_LIMIT_MB ---
const PuppeteerMemoryLimitSchema = z.coerce.number().int().positive();

let _puppeteerMemoryLimitMb: number | null = null;

export function getPuppeteerMemoryLimitMb(): number {
  if (_puppeteerMemoryLimitMb !== null) return _puppeteerMemoryLimitMb;
  const parsed = PuppeteerMemoryLimitSchema.safeParse(process.env.PUPPETEER_MEMORY_LIMIT_MB);
  _puppeteerMemoryLimitMb = parsed.success ? parsed.data : 512;
  return _puppeteerMemoryLimitMb;
}

// --- PUPPETEER_SHUTDOWN_TIMEOUT_MS ---
const PuppeteerShutdownTimeoutSchema = z.coerce.number().int().positive();

let _puppeteerShutdownTimeoutMs: number | null = null;

export function getPuppeteerShutdownTimeoutMs(): number {
  if (_puppeteerShutdownTimeoutMs !== null) return _puppeteerShutdownTimeoutMs;
  const parsed = PuppeteerShutdownTimeoutSchema.safeParse(process.env.PUPPETEER_SHUTDOWN_TIMEOUT_MS);
  _puppeteerShutdownTimeoutMs = parsed.success ? parsed.data : 5000;
  return _puppeteerShutdownTimeoutMs;
}

// --- PUPPETEER_WARNING_THRESHOLD_PCT ---
const PuppeteerWarningThresholdSchema = z.coerce.number().int().positive();

let _puppeteerWarningThresholdPct: number | null = null;

export function getPuppeteerWarningThresholdPct(): number {
  if (_puppeteerWarningThresholdPct !== null) return _puppeteerWarningThresholdPct;
  const parsed = PuppeteerWarningThresholdSchema.safeParse(process.env.PUPPETEER_WARNING_THRESHOLD_PCT);
  _puppeteerWarningThresholdPct = parsed.success ? parsed.data : 85;
  return _puppeteerWarningThresholdPct;
}

// --- PUPPETEER_CONCURRENCY ---
const PuppeteerConcurrencySchema = z.coerce.number().int().positive();

let _puppeteerConcurrency: number | null = null;

export function getPuppeteerConcurrency(): number {
  if (_puppeteerConcurrency !== null) return _puppeteerConcurrency;
  const parsed = PuppeteerConcurrencySchema.safeParse(process.env.PUPPETEER_CONCURRENCY);
  _puppeteerConcurrency = parsed.success ? parsed.data : 3;
  return _puppeteerConcurrency;
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
  _puppeteerMemoryLimitMb = null;
  _puppeteerShutdownTimeoutMs = null;
  _puppeteerWarningThresholdPct = null;
  _puppeteerConcurrency = null;
  _redisChatCompression = null;
  _redisCompressionLevel = null;
  _healthToken = null;
}
