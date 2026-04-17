import { getTwitchClient } from './auth.js';
import { getTwitchCredentials } from '../../utils/credentials.js';
import { getTenantConfig } from '../../config/loader.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { HttpError } from '../../utils/http-error.js';

const log = createAutoLogger('twitch-badges');

export async function getChannelBadges(tenantId: string): Promise<Record<string, unknown> | null> {
  const creds = getTwitchCredentials(tenantId);
  const config = getTenantConfig(tenantId);
  if (!creds?.clientId || !config?.twitch?.id) {
    log.warn({ tenantId }, 'Twitch credentials not configured for streamer');
    return null;
  }

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get<{ data?: Record<string, unknown> }>(
      `/chat/badges?broadcaster_id=${config.twitch.id}`
    );

    const badgesData = data?.data || null;
    if (!badgesData) {
      log.debug({ tenantId }, 'No channel badges found for Twitch user');
    }
    return badgesData as Record<string, unknown>;
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
  const creds = getTwitchCredentials(tenantId);
  if (!creds?.clientId) return null;

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get<{ data?: Record<string, unknown> }>('/chat/badges/global');
    return (data?.data || null) as Record<string, unknown>;
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
