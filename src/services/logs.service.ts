import type { Kysely } from 'kysely';
import { Cache, Logs } from '../constants.js';
import type { StreamerDB, SelectableChatMessages } from '../db/streamer-types.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { compressChatData, decompressChatData } from '../utils/compression.js';
import { VodNotFoundError } from '../utils/domain-errors.js';
import { extractErrorDetails } from '../utils/error.js';
import { badRequest } from '../utils/http-error.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';

interface CursorPayload {
  offset: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

async function fetchBucket(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  offset: number
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  const bucketStart = Math.floor(offset / Logs.BUCKET_SIZE) * Logs.BUCKET_SIZE;
  const bucketEnd = bucketStart + Logs.BUCKET_SIZE;
  const cacheKey = simpleKeys.bucket(tenantId, vodId, bucketStart);
  const redis = RedisService.getActiveClient();

  if (redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached != null && cached.length > 0) {
        getLogger().debug({ vodId, bucketStart }, '[CACHE HIT] bucket');
        const data = (await decompressChatData(cached)) as {
          comments: SelectableChatMessages[];
          cursor?: string | undefined;
        };
        return data;
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      getLogger().warn({ vodId, bucketStart, ...details }, '[CACHE MISS] bucket read failed');
    }
  }

  const vod = await db.selectFrom('vods').select(['created_at', 'duration']).where('id', '=', vodId).executeTakeFirst();

  if (!vod) throw new VodNotFoundError(vodId, 'logs service');

  const streamStart = vod.created_at;
  const streamEnd = new Date(streamStart.getTime() + (vod.duration + 7200) * 1000);

  const comments = await db
    .selectFrom('chat_messages')
    .select([
      'id',
      'vod_id',
      'display_name',
      'content_offset_seconds',
      'user_color',
      'created_at',
      'message',
      'user_badges',
    ])
    .where('vod_id', '=', vodId)
    .where('content_offset_seconds', '>=', bucketStart)
    .where('content_offset_seconds', '<', bucketEnd)
    .where('created_at', '>=', streamStart)
    .where('created_at', '<=', streamEnd)
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(Logs.BUCKET_LIMIT)
    .execute();

  let cursor: string | undefined;
  const peekResult = await db
    .selectFrom('chat_messages')
    .select(['id', 'content_offset_seconds', 'created_at'])
    .where('vod_id', '=', vodId)
    .where('content_offset_seconds', '>=', bucketEnd)
    .where('created_at', '>=', streamStart)
    .where('created_at', '<=', streamEnd)
    .orderBy('content_offset_seconds', 'asc')
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();

  if (peekResult) {
    cursor = encodeCursor(peekResult.content_offset_seconds);
  }

  const response = { comments, cursor };

  if (redis) {
    try {
      const compressed = await compressChatData(response);
      await redis.set(cacheKey, compressed, 'EX', Cache.CHAT_TTL);
      getLogger().debug({ vodId, bucketStart }, '[CACHE SET] bucket');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

/**
 * Fetch chat comments for a VOD using offset-based pagination.
 * Computes fixed 60-second bucket boundaries, caches results in Redis.
 */
export async function getLogsByOffset(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  offsetSeconds: number
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  return fetchBucket(db, tenantId, vodId, offsetSeconds);
}

/**
 * Fetch chat comments for a VOD using cursor-based pagination.
 * Cursor encodes the offset of the next bucket's first message.
 */
export async function getLogsByCursor(
  db: Kysely<StreamerDB>,
  tenantId: string,
  vodId: number,
  cursor: string
): Promise<{ comments: SelectableChatMessages[]; cursor?: string | undefined }> {
  let cursorJson: CursorPayload | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString()) as CursorPayload;
  } catch {
    badRequest('Invalid cursor format');
  }

  if (typeof cursorJson?.offset !== 'number') {
    badRequest('Invalid cursor: missing offset');
  }

  return fetchBucket(db, tenantId, vodId, cursorJson.offset);
}
