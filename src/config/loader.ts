import { metaClient } from '../db/meta-client';
import { decrypt, validateEncryptionKey } from '../utils/encryption';
import { StreamerConfig } from './types';

const configCache = new Map<string, StreamerConfig>();

export async function loadStreamerConfigs(): Promise<StreamerConfig[]> {
    if (!validateEncryptionKey(process.env.ENCRYPTION_MASTER_KEY || '')) throw new Error('ENCRYPTION_MASTER_KEY must be set and valid');

    const tenants = await metaClient.tenant.findMany({ include: { credentials: true } });
    if (tenants.length === 0) return [];

    for (const tenant of tenants) {
        const configMap = new Map<string, string>();
        
        for (const credential of tenant.credentials) {
            try {
                const decryptedValue = decrypt(Buffer.from(credential.encryptedValue!));
                configMap.set(`${credential.platform}:${credential.type}`, decryptedValue);
            } catch {}
        }

        const streamerConfig: StreamerConfig = {
            id: tenant.id,
            database: { url: '' },
        };

        if (configMap.has('twitch:client_id')) {
            streamerConfig.twitch = {};
            if (configMap.has('twitch:client_secret')) streamerConfig.twitch.clientSecret = configMap.get('twitch:client_secret') || undefined;
            if (configMap.has('twitch:channel_name')) streamerConfig.twitch.channelName = configMap.get('twitch:channel_name');
        }

        if (configMap.has('youtube:client_id')) {
            streamerConfig.youtube = {};
            if (configMap.has('youtube:client_secret')) streamerConfig.youtube.clientSecret = configMap.get('youtube:client_secret') || undefined;
            if (configMap.has('youtube:refresh_token')) streamerConfig.youtube.refreshToken = configMap.get('youtube:refresh_token');
        }

        const kickEnabled = configMap.get('kick:enabled') === 'true';
        if (kickEnabled) {
            streamerConfig.kick = { enabled: true };
            if (configMap.has('kick:channel_name')) streamerConfig.kick.channelName = configMap.get('kick:channel_name');
        }

        const dbUrl = configMap.get('database:url');
        if (!dbUrl) continue;

        streamerConfig.database.url = dbUrl;
        
        const connectionLimitStr = configMap.get('database:connection_limit');
        if (connectionLimitStr && !isNaN(parseInt(connectionLimitStr))) {
            streamerConfig.database.connectionLimit = parseInt(connectionLimitStr);
        }

        configCache.set(tenant.id, streamerConfig);
    }

    return Array.from(configCache.values());
}

export function getConfigById(streamerId: string): StreamerConfig | undefined {
    return configCache.get(streamerId);
}

export function clearConfigCache(): void {
    configCache.clear();
}
