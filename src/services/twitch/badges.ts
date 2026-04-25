import { getTwitchClient } from './auth.js';
import { getTwitchCredentials } from '../../utils/credentials.js';
import { configService } from '../../config/tenant-config.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { HttpError } from '../../utils/http-error.js';
import { LRUCache } from 'lru-cache';

const log = createAutoLogger('twitch-badges');

const channelBadgesCache = new LRUCache<string, Record<string, unknown>>({
  max: 100,
  ttl: 60 * 60 * 1000,
  allowStale: false,
});

const globalBadgesCache = new LRUCache<string, Record<string, unknown>>({
  max: 100,
  ttl: 60 * 60 * 1000,
  allowStale: false,
});

export async function getChannelBadges(tenantId: string): Promise<Record<string, unknown> | null> {
  const cached = channelBadgesCache.get(tenantId);
  if (cached !== undefined) {
    return cached;
  }

  const creds = getTwitchCredentials(tenantId);
  const config = configService.get(tenantId);
  if (creds?.clientId == null || creds?.clientId === '' || config?.twitch?.id == null || config?.twitch?.id === '') {
    log.warn({ tenantId }, 'Twitch credentials not configured for streamer');
    return null;
  }

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get(`/chat/badges?broadcaster_id=${config.twitch.id}`);

    const badgesData = ((data as { data?: unknown })?.data ?? null) as Record<string, unknown>[] | null;
    if (badgesData == null) {
      log.debug({ tenantId }, 'No channel badges found for Twitch user');
      return null;
    }

    channelBadgesCache.set(tenantId, badgesData as unknown as Record<string, unknown>);
    return badgesData as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      if (error.statusCode === 404) {
        log.debug({ tenantId }, 'Channel badges not found (404)');
      } else if (error.statusCode >= 500) {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Twitch API unstable, skipping badges');
      } else {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Failed to fetch channel badges');
      }
      return null;
    }

    const { message } = extractErrorDetails(error);
    log.error({ tenantId, error: message }, 'Failed to fetch channel badges');
    return null;
  }
}

export async function getGlobalBadges(tenantId: string): Promise<Record<string, unknown> | null> {
  const cached = globalBadgesCache.get(tenantId);
  if (cached !== undefined) {
    return cached;
  }

  const creds = getTwitchCredentials(tenantId);
  if (creds?.clientId == null || creds?.clientId === '') return null;

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get('/chat/badges/global');
    const badgesData = ((data as { data?: unknown })?.data ?? null) as Record<string, unknown>[] | null;

    if (badgesData != null) {
      globalBadgesCache.set(tenantId, badgesData as unknown as Record<string, unknown>);
    }

    return badgesData as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      if (error.statusCode === 404) {
        log.debug({ tenantId }, 'Global badges not found (404)');
      } else if (error.statusCode >= 500) {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Twitch API unstable, skipping badges');
      } else {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Failed to fetch global badges');
      }
      return null;
    }

    const { message } = extractErrorDetails(error);
    log.error({ tenantId, error: message }, 'Failed to fetch global badges');
    return null;
  }
}
