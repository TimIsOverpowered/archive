"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTenantStats = getTenantStats;
exports.getAllTenants = getAllTenants;
const meta_client_1 = require("../db/meta-client");
const redis_plugin_1 = require("../api/plugins/redis.plugin");
const STATS_CACHE_TTL = parseInt(process.env.STATS_CACHE_TTL || '60', 10);
const DISABLE_CACHE = process.env.DISABLE_REDIS_CACHE === 'true';
async function getTenantStats(client, streamerId) {
    const cacheKey = `stats:${streamerId}`;
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
    const tenant = await meta_client_1.metaClient.tenant.findFirst({
        where: { id: parseInt(streamerId, 10) },
    });
    if (!tenant) {
        throw new Error('Tenant not found');
    }
    let dbStatus = 'connected';
    try {
        await client.$queryRaw `SELECT 1`;
    }
    catch {
        dbStatus = 'error';
    }
    const platforms = [];
    if (tenant.twitch?.username)
        platforms.push('twitch');
    if (tenant.youtube?.api_key || tenant.youtube?.auth)
        platforms.push('youtube');
    if (tenant.kick?.username)
        platforms.push('kick');
    const [vods, vodUploads, chatMessages, chapters] = await Promise.all([
        client.vod.findMany({ where: { platform: { startsWith: streamerId } } }),
        client.vodUpload.findMany({
            where: {
                vod: { platform: { startsWith: streamerId } },
            },
        }),
        client.chatMessage.count({
            where: { vod_id: { startsWith: streamerId } },
        }),
        client.chapter.findMany({
            where: { vod: { platform: { startsWith: streamerId } } },
        }),
    ]);
    const byPlatform = {};
    vods.forEach((vod) => {
        byPlatform[vod.platform] = (byPlatform[vod.platform] || 0) + 1;
    });
    const totalDurationSeconds = vods.reduce((sum, vod) => sum + vod.duration, 0);
    const lastVodDate = vods.length > 0 ? new Date(Math.max(...vods.map((v) => v.created_at.getTime()))) : null;
    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);
    const thisMonthVods = vods.filter((v) => v.created_at >= thisMonthStart).length;
    const completedUploads = vodUploads.filter((u) => u.status === 'COMPLETED');
    const failedUploads = vodUploads.filter((u) => u.status === 'FAILED');
    const totalUploads = completedUploads.length + failedUploads.length;
    const lastUploadDate = completedUploads.length > 0 ? new Date(Math.max(...completedUploads.map((u) => u.created_at.getTime()))) : null;
    const uploadSuccessRate = totalUploads > 0 ? Math.round((completedUploads.length / totalUploads) * 1000) / 10 : 0;
    const uniqueGames = new Set(chapters
        .filter((c) => c.game_id)
        .map((c) => c.game_id)
        .filter(Boolean));
    const thisMonthChatStart = new Date();
    thisMonthChatStart.setMonth(thisMonthChatStart.getMonth() - 1);
    const messagesThisMonth = await client.chatMessage.count({
        where: {
            vod_id: { startsWith: streamerId },
            created_at: { gte: thisMonthChatStart },
        },
    });
    const stats = {
        tenant: {
            id: streamerId,
            display_name: tenant.display_name,
            platforms,
            created_at: tenant.created_at,
        },
        database: {
            status: dbStatus,
            lastChecked: new Date(),
        },
        vods: {
            totalCount: vods.length,
            byPlatform,
            totalHours: Math.round((totalDurationSeconds / 3600) * 10) / 10,
            lastVodDate,
            thisMonthCount: thisMonthVods,
        },
        youtube: {
            totalUploads: completedUploads.length,
            failedUploads: failedUploads.length,
            lastUploadDate,
            uploadSuccessRate,
        },
        chat: {
            totalMessages: chatMessages,
            messagesThisMonth,
        },
        chapters: {
            totalChapters: chapters.length,
            gamesCount: uniqueGames.size,
        },
    };
    if (!DISABLE_CACHE && redis_plugin_1.redisClient) {
        try {
            await redis_plugin_1.redisClient.set(cacheKey, JSON.stringify(stats), { EX: STATS_CACHE_TTL });
        }
        catch {
            // Ignore cache errors
        }
    }
    return stats;
}
async function getAllTenants() {
    const tenants = await meta_client_1.metaClient.tenant.findMany({
        select: {
            id: true,
            display_name: true,
            twitch: true,
            youtube: true,
            kick: true,
            created_at: true,
        },
    });
    return tenants.map((t) => {
        const platforms = [];
        if (t.twitch?.username)
            platforms.push('twitch');
        if (t.youtube?.api_key || t.youtube?.auth)
            platforms.push('youtube');
        if (t.kick?.username)
            platforms.push('kick');
        return {
            id: t.id.toString(),
            display_name: t.display_name,
            platforms,
            created_at: t.created_at,
        };
    });
}
//# sourceMappingURL=tenants.service.js.map