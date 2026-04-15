import { PrismaClient } from '../../generated/streamer/client';
import { redisClient } from '../api/plugins/redis.plugin';
import { compressChatData, decompressChatData } from '../utils/compression';
import { logger } from '../utils/logger.js';
import { badRequest } from '../utils/http-error';

const PAGE_SIZE = 200;
const DEFAULT_BUCKET_SIZE = 120;
const TARGET_COMMENTS_PER_BUCKET = 300;
const BOUNDARIES = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];

const CURSOR_TTL = parseInt(process.env.CHAT_CURSOR_TTL || '259200', 10);
const OFFSET_TTL = parseInt(process.env.CHAT_OFFSET_TTL || '259200', 10);
const BUCKET_SIZE_TTL = parseInt(process.env.CHAT_BUCKET_SIZE_TTL || '2592000', 10);

const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';

interface ChatMessage {
  id: string;
  vod_id: number;
  display_name: string | null;
  content_offset_seconds: number;
  message: unknown;
  user_badges: unknown;
  user_color: string | null;
}

interface CursorData {
  offset: number;
  createdAt: string;
  id: string;
}

function computeBucketSize(commentsPer100s: number): number {
  const raw = (TARGET_COMMENTS_PER_BUCKET / commentsPer100s) * 100;
  return BOUNDARIES.reduce((prev, curr) => (Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev));
}

async function getVodBucketSize(client: PrismaClient, tenantId: string, vodId: number): Promise<number> {
  const key = `${tenantId}:${vodId}:bucketSize`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        logger.debug({ vodId }, '[CACHE HIT] bucketSize');
        return parseInt(cached, 10);
      }
    } catch {
      // fall through to DB query
    }
  }

  const rawResult = await client.$queryRawUnsafe(
    `
    SELECT 
      COUNT(*) / NULLIF((MAX(content_offset_seconds) - MIN(content_offset_seconds)), 0) * 100 AS comments_per_100s
    FROM chat_messages
    WHERE vod_id = $1
  `,
    vodId
  );

  const row = (rawResult as unknown[])[0] as { comments_per_100s?: unknown };
  const commentsPer100sValue = parseFloat(String(row?.comments_per_100s ?? ''));
  const bucketSize = isFinite(commentsPer100sValue) ? computeBucketSize(commentsPer100sValue) : DEFAULT_BUCKET_SIZE;

  if (!DISABLE_CACHE && redisClient) {
    try {
      await redisClient.set(key, bucketSize.toString(), 'EX', BUCKET_SIZE_TTL);
    } catch {
      // Ignore cache errors
    }
  }

  return bucketSize;
}

export async function getLogsByOffset(client: PrismaClient, tenantId: string, vodId: number, offsetSeconds: number): Promise<{ comments: ChatMessage[]; cursor?: string }> {
  const bucketSize = await getVodBucketSize(client, tenantId, vodId);
  const bucket = Math.floor(offsetSeconds / bucketSize) * bucketSize;
  const cacheKey = `${tenantId}:${vodId}:bucket:${bucket}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.getBuffer(cacheKey);
      if (cached) {
        logger.debug({ vodId, bucket }, '[CACHE HIT] bucket');
        const data = (await decompressChatData(cached)) as { comments: ChatMessage[]; cursor?: string };
        return data;
      }
    } catch (error) {
      logger.warn({ vodId, bucket, error: String(error) }, '[CACHE MISS] bucket read failed');
    }
  }

  const data = await client.chatMessage.findMany({
    where: {
      vod_id: vodId,
      content_offset_seconds: { gte: bucket },
    },
    orderBy: [{ content_offset_seconds: 'asc' }, { createdAt: 'asc' }],
    take: PAGE_SIZE + 1,
  });

  if (!data || data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, PAGE_SIZE).map((msg) => ({
    id: msg.id,
    vod_id: msg.vod_id,
    display_name: msg.display_name,
    content_offset_seconds: Number(msg.content_offset_seconds),
    message: msg.message,
    user_badges: msg.user_badges,
    user_color: msg.user_color,
    created_at: msg.createdAt,
  }));

  let cursor: string | undefined;
  if (data.length === PAGE_SIZE + 1) {
    const lastMsg = data[PAGE_SIZE];
    if (!lastMsg.createdAt) {
      throw new Error(`Missing createdAt on message ${lastMsg.id}`);
    }
    const cursorData: CursorData = {
      offset: Number(lastMsg.content_offset_seconds),
      createdAt: lastMsg.createdAt.toISOString(),
      id: lastMsg.id,
    };
    cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor };

  if (!DISABLE_CACHE && redisClient) {
    try {
      const compressed = await compressChatData(response);
      await redisClient.set(cacheKey, compressed as Buffer, 'EX', OFFSET_TTL);
      logger.debug({ vodId, bucket }, '[CACHE SET] bucket');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

export async function getLogsByCursor(client: PrismaClient, tenantId: string, vodId: number, cursor: string): Promise<{ comments: ChatMessage[]; cursor?: string }> {
  const cacheKey = `${tenantId}:${vodId}:cursor:${cursor}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await redisClient.getBuffer(cacheKey);
      if (cached) {
        logger.debug({ vodId }, '[CACHE HIT] cursor');

        const data = (await decompressChatData(cached)) as { comments: ChatMessage[]; cursor?: string };
        return data;
      }
    } catch (error) {
      logger.warn({ vodId, error: String(error) }, '[CACHE MISS] cursor read failed');
    }
  }

  let cursorJson: CursorData | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString());
  } catch {
    badRequest('Invalid cursor format');
  }

  if (cursorJson?.offset == null || cursorJson?.createdAt == null || cursorJson?.id == null) {
    badRequest('Invalid cursor: missing required fields');
  }

  const cursorDate = new Date(cursorJson.createdAt);
  if (isNaN(cursorDate.getTime())) {
    badRequest('Invalid cursor: invalid date');
  }

  const data = await client.chatMessage.findMany({
    where: {
      vod_id: vodId,
      OR: [
        { content_offset_seconds: { gt: cursorJson.offset } },
        {
          content_offset_seconds: cursorJson.offset,
          OR: [{ createdAt: { gt: cursorDate } }, { createdAt: cursorDate, id: { gt: cursorJson.id } }],
        },
      ],
    },
    orderBy: [{ content_offset_seconds: 'asc' }, { createdAt: 'asc' }],
    take: PAGE_SIZE + 1,
  });

  if (!data || data.length === 0) {
    return { comments: [], cursor: undefined };
  }

  const comments = data.slice(0, PAGE_SIZE).map((msg) => ({
    id: msg.id,
    vod_id: msg.vod_id,
    display_name: msg.display_name,
    content_offset_seconds: Number(msg.content_offset_seconds),
    message: msg.message,
    user_badges: msg.user_badges,
    user_color: msg.user_color,
    created_at: msg.createdAt,
  }));

  let nextCursor: string | undefined;
  if (data.length === PAGE_SIZE + 1) {
    const lastMsg = data[PAGE_SIZE];
    if (!lastMsg.createdAt) {
      throw new Error(`Missing createdAt on message ${lastMsg.id}`);
    }
    const cursorData: CursorData = {
      offset: Number(lastMsg.content_offset_seconds),
      createdAt: lastMsg.createdAt.toISOString(),
      id: lastMsg.id,
    };
    nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor: nextCursor };

  if (!DISABLE_CACHE && redisClient) {
    try {
      const compressed = await compressChatData(response);
      await redisClient.set(cacheKey, compressed as Buffer, 'EX', CURSOR_TTL);
      logger.debug({ vodId }, '[CACHE SET] cursor');
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}
