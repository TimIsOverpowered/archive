"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVods = getVods;
exports.getVodById = getVodById;
const redis_plugin_1 = require("../api/plugins/redis.plugin");
const CACHE_TTL = 86400; // 24 hours
const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';
async function getVods(client, streamerId, query) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const offset = (page - 1) * limit;
    const cacheKey = `vods:${streamerId}:${JSON.stringify({ ...query, page, limit })}`;
    if (!DISABLE_CACHE && redis_plugin_1.redisClient) {
        try {
            const cached = await redis_plugin_1.redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        }
        catch {
            // Ignore cache errors
        }
    }
    const where = { vod_id: { startsWith: streamerId } };
    if (query.platform) {
        where.platform = query.platform;
    }
    if (query.from || query.to) {
        where.created_at = {};
        if (query.from)
            where.created_at.gte = new Date(query.from);
        if (query.to)
            where.created_at.lte = new Date(query.to);
    }
    if (query.uploaded === 'youtube') {
        where.vod_uploads = {
            some: {
                platform: 'youtube',
            },
        };
    }
    if (query.game) {
        const gameLower = query.game.toLowerCase();
        const games = await client.game.findMany({
            where: {
                game_name: {
                    contains: gameLower,
                    mode: 'insensitive',
                },
            },
            select: { vod_id: true },
        });
        const gameVodIds = games.map((g) => g.vod_id);
        if (gameVodIds.length > 0) {
            where.id = { in: gameVodIds };
        }
        else {
            return { vods: [], total: 0 };
        }
    }
    const [vods, total] = await Promise.all([
        client.vod.findMany({
            where,
            skip: offset,
            take: limit + 1,
            orderBy: {
                [query.sort || 'created_at']: query.order || 'desc',
            },
            include: {
                vod_uploads: {
                    select: {
                        upload_id: true,
                        platform: true,
                        status: true,
                    },
                },
                chapters: {
                    select: {
                        name: true,
                        duration: true,
                        start: true,
                    },
                },
            },
        }),
        client.vod.count({ where }),
    ]);
    const hasMore = vods.length > limit;
    const resultVods = hasMore ? vods.slice(0, limit) : vods;
    const response = {
        vods: resultVods,
        total,
    };
    if (!DISABLE_CACHE && redis_plugin_1.redisClient) {
        try {
            await redis_plugin_1.redisClient.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });
        }
        catch {
            // Ignore cache errors
        }
    }
    return response;
}
async function getVodById(client, streamerId, vodId) {
    const cacheKey = `vod:${streamerId}:${vodId}`;
    if (!DISABLE_CACHE && redis_plugin_1.redisClient) {
        try {
            const cached = await redis_plugin_1.redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        }
        catch {
            // Ignore cache errors
        }
    }
    const vod = await client.vod.findFirst({
        where: {
            id: vodId,
            platform: { startsWith: streamerId },
        },
        include: {
            vod_uploads: {
                select: {
                    upload_id: true,
                    platform: true,
                    status: true,
                },
            },
            chapters: {
                select: {
                    name: true,
                    duration: true,
                    start: true,
                },
            },
        },
    });
    if (vod) {
        const response = vod;
        if (!DISABLE_CACHE && redis_plugin_1.redisClient) {
            try {
                await redis_plugin_1.redisClient.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL });
            }
            catch {
                // Ignore cache errors
            }
        }
        return response;
    }
    return null;
}
//# sourceMappingURL=vods.service.js.map