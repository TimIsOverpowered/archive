import { Token, Twitch } from '../../constants.js';
import { getTwitchAppCredentials } from '../../utils/credentials.js';
import { sendDiscordAlert, trackFailure, resetFailures } from '../../utils/discord-alerts.js';
import { extractErrorDetails } from '../../utils/error.js';
import { request } from '../../utils/http-client.js';
import { getLogger } from '../../utils/logger.js';
import { RedisService } from '../../utils/redis-service.js';
import { createTwitchClient, type TwitchClient } from './client.js';

const log = getLogger().child({ module: 'twitch-auth' });

let tokenState: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

export async function getAppAccessToken(): Promise<string> {
  const now = Date.now();

  if (tokenState != null && tokenState.expiresAt > now + 60 * 60 * 1000) {
    return tokenState.token;
  }

  if (refreshing != null) {
    return refreshing;
  }

  const redisToken = await tryLoadFromRedis();
  if (redisToken != null && redisToken.expiresAt > now + 60 * 60 * 1000) {
    tokenState = redisToken;
    return redisToken.token;
  }

  refreshing = refreshToken();
  try {
    const token = await refreshing;
    return token;
  } finally {
    refreshing = null;
  }
}

async function tryLoadFromRedis(): Promise<{ token: string; expiresAt: number } | null> {
  const redis = RedisService.getActiveClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(Twitch.REDIS_TOKEN_KEY);
    if (raw == null || raw === '') return null;

    const parsed = JSON.parse(raw) as { token: string; expiresAt: number };
    if (parsed.token != null && parsed.token !== '' && parsed.expiresAt > 0) {
      return parsed;
    }
  } catch {
    /* ignore stale/corrupt data */
  }
  return null;
}

async function saveToRedis(token: string, expiresAt: number): Promise<void> {
  const redis = RedisService.getActiveClient();
  if (!redis) return;

  try {
    const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 600);
    await redis.set(Twitch.REDIS_TOKEN_KEY, JSON.stringify({ token, expiresAt }), 'EX', ttlSeconds);
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ err: message }, 'Failed to save Twitch token to Redis');
  }
}

let lockValue: string | null = null;

async function acquireLock(): Promise<boolean> {
  const redis = RedisService.getActiveClient();
  if (!redis) return true;

  try {
    lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await redis.set(Twitch.REDIS_LOCK_KEY, lockValue, 'EX', Twitch.LOCK_TTL, 'NX');
    return result === 'OK';
  } catch (err) {
    const { message } = extractErrorDetails(err);
    log.warn({ err: message }, 'Failed to acquire Redis refresh lock');
    return true;
  }
}

async function releaseLock(): Promise<void> {
  const redis = RedisService.getActiveClient();
  if (!redis || lockValue == null) return;

  try {
    const current = await redis.get(Twitch.REDIS_LOCK_KEY);
    if (current === lockValue) {
      await redis.del(Twitch.REDIS_LOCK_KEY);
    }
  } catch {
    /* best-effort cleanup */
  } finally {
    lockValue = null;
  }
}

async function refreshToken(): Promise<string> {
  const gotLock = await acquireLock();

  if (!gotLock) {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const redisToken = await tryLoadFromRedis();
      if (redisToken != null && redisToken.expiresAt > Date.now() + 60 * 60 * 1000) {
        tokenState = redisToken;
        return redisToken.token;
      }
    }
  }

  try {
    const { clientId, clientSecret } = getTwitchAppCredentials();

    const url = new URL(Twitch.TOKEN_URL);
    url.searchParams.append('client_id', clientId);
    url.searchParams.append('client_secret', clientSecret);
    url.searchParams.append('grant_type', 'client_credentials');

    const data = await request<{ access_token: string; expires_in: number }>(url.toString(), {
      method: 'POST',
    });

    const { access_token, expires_in } = data;
    const expiresAt = Date.now() + expires_in * 1000;

    tokenState = { token: access_token, expiresAt };
    await saveToRedis(access_token, expiresAt);
    resetFailures(Token.TWITCH_FAILURE_KEY);

    log.info({ expires_in, expires_at: expiresAt }, 'Fetched new Twitch access token');

    return access_token;
  } catch (err: unknown) {
    const { message } = extractErrorDetails(err);
    log.error({ err: message }, 'Failed to fetch Twitch access token');

    if (trackFailure(Token.TWITCH_FAILURE_KEY, Token.MAX_FAILURES)) {
      sendDiscordAlert(`🚨 Twitch token refresh failed after ${Token.MAX_FAILURES} attempts: ${message}`).catch((e) => {
        log.error({ err: extractErrorDetails(e) }, 'Failed to send Discord alert for Twitch token failure');
      });
    }

    throw err;
  } finally {
    if (gotLock) {
      await releaseLock();
    }
  }
}

export function getTwitchClient(): TwitchClient {
  return createTwitchClient(() => getAppAccessToken());
}
