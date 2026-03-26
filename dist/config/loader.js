"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadStreamerConfigs = loadStreamerConfigs;
exports.getStreamerConfig = getStreamerConfig;
exports.getConfigById = getConfigById;
exports.clearConfigCache = clearConfigCache;
const meta_client_1 = require("../db/meta-client");
const encryption_1 = require("../utils/encryption");
const configCache = new Map();
async function loadStreamerConfigs() {
    const tenants = await meta_client_1.metaClient.tenant.findMany();
    if (tenants.length === 0)
        return [];
    for (const tenant of tenants) {
        if (!tenant.database_url)
            continue;
        const dbUrl = (0, encryption_1.decryptScalar)(tenant.database_url);
        const streamerConfig = {
            id: tenant.id.toString(),
            database: { url: dbUrl },
        };
        if (tenant.twitch && typeof tenant.twitch === 'object') {
            const twitch = tenant.twitch;
            if ('username' in twitch && twitch.username) {
                streamerConfig.twitch = {};
                if ('auth' in twitch && twitch.auth) {
                    const auth = (0, encryption_1.decryptObject)(twitch.auth);
                    streamerConfig.twitch.clientId = auth.client_id;
                    streamerConfig.twitch.clientSecret = auth.client_secret;
                }
                streamerConfig.twitch.channelName = twitch.username;
            }
        }
        if (tenant.youtube && typeof tenant.youtube === 'object') {
            const youtube = tenant.youtube;
            streamerConfig.youtube = {};
            if ('api_key' in youtube && youtube.api_key) {
                const apiKey = (0, encryption_1.decryptScalar)(youtube.api_key);
                streamerConfig.youtube.clientId = apiKey;
            }
            if ('auth' in youtube && youtube.auth) {
                const auth = (0, encryption_1.decryptObject)(youtube.auth);
                streamerConfig.youtube.refreshToken = auth.refresh_token;
            }
            if ('client_secret' in youtube && youtube.client_secret) {
                const clientSecret = (0, encryption_1.decryptScalar)(youtube.client_secret);
                streamerConfig.youtube.clientSecret = clientSecret;
            }
        }
        if (tenant.kick && typeof tenant.kick === 'object') {
            const kick = tenant.kick;
            if ('username' in kick && kick.username) {
                streamerConfig.kick = { enabled: true };
                streamerConfig.kick.channelName = kick.username;
            }
        }
        configCache.set(streamerConfig.id, streamerConfig);
    }
    return Array.from(configCache.values());
}
function getStreamerConfig(streamerId) {
    return configCache.get(streamerId);
}
function getConfigById(streamerId) {
    return getStreamerConfig(streamerId);
}
function clearConfigCache() {
    configCache.clear();
}
//# sourceMappingURL=loader.js.map