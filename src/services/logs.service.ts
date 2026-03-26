import { PrismaClient } from '../../generated/streamer/client';
import { redisClient } from '../api/plugins/redis.plugin';
import { compressChatData, decompressChatData } from '../utils/compression';

const PAGE_SIZE = 200;
const DEFAULT_BUCKET_SIZE = 120;
const TARGET_COMMENTS_PER_BUCKET = 300;
const BOUNDARIES = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];

const CURSOR_TTL = parseInt(process.env.CHAT_CURSOR_TTL || '259200', 10);
const OFFSET_TTL = parseInt(process.env.CHAT_OFFSET_TTL || '259200', 10);
const BUCKET_SIZE_TTL = parseInt(process.env.CHAT_BUCKET_SIZE_TTL || '2592000', 10);

const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';
const ENABLE_CACHE_LOGGER = process.env.ENABLE_REDIS_CACHE_LOGGER === 'true';

interface ChatMessage {
  id: string;
  vod_id: string;
  display_name: string | null;
  content_offset_seconds: number;
  message: unknown;
  user_badges: unknown;
  user_color: string;
}

interface CursorData {
  offset: number;
  id: string;
}

function computeBucketSize(commentsPer100s: number): number {
  const raw = (TARGET_COMMENTS_PER_BUCKET / commentsPer100s) * 100;
  return BOUNDARIES.reduce((prev, curr) => (Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev));
}

async function getVodBucketSize(streamerId: string, vodId: string): Promise<number> {
  if (DISABLE_CACHE || !redisClient) return DEFAULT_BUCKET_SIZE;

  const key = `${streamerId}:${vodId}:bucketSize`;

  try {
    const cached = await redisClient.get(key);
    if (cached) {
      if (ENABLE_CACHE_LOGGER) console.log(`[CACHE HIT] bucketSize:${vodId}`);
      return parseInt(cached, 10);
    }
  } catch {
    // Ignore cache errors
  }

  const rawResult = await (PrismaClient as unknown as { queryRawUnsafe: (query: string, ...params: unknown[]) => Promise<unknown[]> }).queryRawUnsafe(
    `
    SELECT 
      COUNT(*) / NULLIF((MAX(content_offset_seconds) - MIN(content_offset_seconds)), 0) * 100 AS comments_per_100s
    FROM chat_messages
    WHERE vod_id = $1
  `,
    vodId
  );

  const commentsPer100s = (rawResult?.[0] as { comments_per_100s?: unknown } | undefined)?.comments_per_100s;
  const bucketSize = commentsPer100s ? computeBucketSize(parseFloat(String(commentsPer100s))) : DEFAULT_BUCKET_SIZE;

  if (!DISABLE_CACHE && redisClient) {
    try {
      await redisClient.set(key, bucketSize.toString(), { EX: BUCKET_SIZE_TTL });
    } catch {
      // Ignore cache errors
    }
  }

  return bucketSize;
}

export async function getLogsByOffset(client: PrismaClient, streamerId: string, vodId: string, offsetSeconds: number): Promise<{ comments: ChatMessage[]; cursor?: string }> {
  const bucketSize = await getVodBucketSize(streamerId, vodId);
  const bucket = Math.floor(offsetSeconds / bucketSize) * bucketSize;
  const cacheKey = `${streamerId}:${vodId}:bucket:${bucket}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await (redisClient as unknown as { getBuffer: (key: string) => Promise<Buffer | null> }).getBuffer(cacheKey);
      if (cached) {
        if (ENABLE_CACHE_LOGGER) console.log(`[CACHE HIT] bucket:${vodId}:${bucket}`);
        const data = (await decompressChatData(cached)) as { comments: ChatMessage[]; cursor?: string };
        return data;
      }
    } catch {
      // Ignore cache errors
    }
  }

  const data = await client.chatMessage.findMany({
    where: {
      vod_id: vodId,
      content_offset_seconds: { gte: bucket },
    },
    orderBy: [{ content_offset_seconds: 'asc' }, { id: 'asc' }],
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
  }));

  let cursor: string | undefined;
  if (data.length === PAGE_SIZE + 1) {
    const cursorData: CursorData = {
      offset: Number(data[PAGE_SIZE].content_offset_seconds),
      id: data[PAGE_SIZE].id,
    };
    cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor };

  if (!DISABLE_CACHE && redisClient) {
    try {
      const compressed = await compressChatData(response);
      await (redisClient as unknown as { setBuffer: (key: string, value: Buffer, options?: { EX?: number }) => Promise<string> }).setBuffer(cacheKey, compressed, { EX: OFFSET_TTL });
      if (ENABLE_CACHE_LOGGER) console.log(`[CACHE SET] bucket:${vodId}:${bucket}`);
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}

export async function getLogsByCursor(client: PrismaClient, streamerId: string, vodId: string, cursor: string): Promise<{ comments: ChatMessage[]; cursor?: string }> {
  const cacheKey = `${streamerId}:${vodId}:cursor:${cursor}`;

  if (!DISABLE_CACHE && redisClient) {
    try {
      const cached = await (redisClient as unknown as { getBuffer: (key: string) => Promise<Buffer | null> }).getBuffer(cacheKey);
      if (cached) {
        if (ENABLE_CACHE_LOGGER) console.log(`[CACHE HIT] cursor:${vodId}`);
        const data = (await decompressChatData(cached)) as { comments: ChatMessage[]; cursor?: string };
        return data;
      }
    } catch {
      // Ignore cache errors
    }
  }

  let cursorJson: CursorData | null = null;
  try {
    cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString());
  } catch {
    return { comments: [], cursor: undefined };
  }

  if (!cursorJson?.offset || !cursorJson?.id) {
    return { comments: [], cursor: undefined };
  }

  const data = await client.chatMessage.findMany({
    where: {
      vod_id: vodId,
      OR: [
        { content_offset_seconds: { gt: cursorJson.offset } },
        {
          content_offset_seconds: cursorJson.offset,
          id: { gte: cursorJson.id },
        },
      ],
    },
    orderBy: [{ content_offset_seconds: 'asc' }, { id: 'asc' }],
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
  }));

  let nextCursor: string | undefined;
  if (data.length === PAGE_SIZE + 1) {
    const cursorData: CursorData = {
      offset: Number(data[PAGE_SIZE].content_offset_seconds),
      id: data[PAGE_SIZE].id,
    };
    nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  const response = { comments, cursor: nextCursor };

  if (!DISABLE_CACHE && redisClient) {
    try {
      const compressed = await compressChatData(response);
      await (redisClient as unknown as { setBuffer: (key: string, value: Buffer, options?: { EX?: number }) => Promise<string> }).setBuffer(cacheKey, compressed, { EX: CURSOR_TTL });
      if (ENABLE_CACHE_LOGGER) console.log(`[CACHE SET] cursor:${vodId}`);
    } catch {
      // Ignore cache errors
    }
  }

  return response;
}
