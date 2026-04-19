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

// --- CHAT TTLs (worker-specific) ---
const ChatTtlSchema = z.coerce.number().int().positive();

let _cursorTtl: number | null = null;
let _offsetTtl: number | null = null;
let _bucketSizeTtl: number | null = null;

export function getChatCursorTtl(): number {
  if (_cursorTtl !== null) return _cursorTtl;
  const parsed = ChatTtlSchema.safeParse(process.env.CHAT_CURSOR_TTL);
  _cursorTtl = parsed.success ? parsed.data : 259200;
  return _cursorTtl;
}

export function getChatOffsetTtl(): number {
  if (_offsetTtl !== null) return _offsetTtl;
  const parsed = ChatTtlSchema.safeParse(process.env.CHAT_OFFSET_TTL);
  _offsetTtl = parsed.success ? parsed.data : 259200;
  return _offsetTtl;
}

export function getChatBucketSizeTtl(): number {
  if (_bucketSizeTtl !== null) return _bucketSizeTtl;
  const parsed = ChatTtlSchema.safeParse(process.env.CHAT_BUCKET_SIZE_TTL);
  _bucketSizeTtl = parsed.success ? parsed.data : 2592000;
  return _bucketSizeTtl;
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

// --- Test helper ---
export function resetEnvAccessorCache(): void {
  _disableRedisCache = null;
  _keyBuffer = null;
  _cursorTtl = null;
  _offsetTtl = null;
  _bucketSizeTtl = null;
  _discordAlertsEnabled = null;
  _puppeteerMemoryLimitMb = null;
  _puppeteerShutdownTimeoutMs = null;
  _puppeteerWarningThresholdPct = null;
}
