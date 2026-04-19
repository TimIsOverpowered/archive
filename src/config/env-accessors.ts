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

// --- Test helper ---
export function resetEnvAccessorCache(): void {
  _disableRedisCache = null;
  _keyBuffer = null;
  _cursorTtl = null;
  _offsetTtl = null;
  _bucketSizeTtl = null;
}
