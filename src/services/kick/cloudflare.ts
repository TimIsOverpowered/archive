import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { createSession } from '../../utils/impit-wrapper.js';
import { childLogger } from '../../utils/logger.js';
import { RedisService } from '../../utils/redis-service.js';

const log = childLogger({ module: 'kick-cf-manager' });

export interface KickCFCredentials {
  cookies: string;
  userAgent: string;
}

export class KickCloudflareManager {
  private lockValue: string | null = null;
  private localCache: KickCFCredentials | null = null;
  private cacheTimestamp: number | null = null;
  private refreshing: Promise<KickCFCredentials> | null = null;

  /**
   * Retrieves the current Cloudflare credentials from memory or Redis.
   * Proactively refreshes if approaching TTL expiry.
   */
  async getCredentials(): Promise<KickCFCredentials | null> {
    if (this.localCache) {
      const elapsed = Date.now() - (this.cacheTimestamp ?? 0);
      const threshold = Kick.CF_CACHE_TTL_SECONDS * Kick.CF_REFRESH_THRESHOLD * 1000;
      if (elapsed > threshold) {
        this.localCache = null;
        this.cacheTimestamp = null;
        this.refreshCredentialsForTtl();
      } else {
        return this.localCache;
      }
    }

    const redis = RedisService.getActiveClient();
    if (redis) {
      try {
        const cached = await redis.get('kick:cf_credentials');
        if (cached != null && cached !== '') {
          const parsed = JSON.parse(cached) as KickCFCredentials;
          this.localCache = parsed;
          this.cacheTimestamp = Date.now();
          return this.localCache;
        }
      } catch (err) {
        log.warn({ err: extractErrorDetails(err).message }, 'Failed to read CF credentials from Redis');
      }
    }
    return null;
  }

  private refreshCredentialsForTtl(): void {
    if (this.refreshing) return;
    this.refreshing = this._refreshCredentials(Kick.API_BASE).finally(() => {
      this.refreshing = null;
    });
  }

  /**
   * Pre-flight check. Makes exactly ONE request to test the cached credentials.
   * If they are expired or missing, it blocks and refreshes them via FlareSolverr.
   */
  async ensureValidClearance(testUrl: string): Promise<KickCFCredentials> {
    const creds = await this.getCredentials();

    if (!creds) {
      log.info('No Cloudflare credentials found. Solving initial challenge...');
      return await this.refreshCredentials(testUrl);
    }

    const session = createSession();
    try {
      await session.fetchText(testUrl, {
        timeoutMs: 5000,
        attempts: 1,
        headers: { Cookie: creds.cookies },
        userAgent: creds.userAgent,
      });

      return creds;
    } catch (err: unknown) {
      const msg = extractErrorDetails(err).message;
      if (msg.includes('403') || msg.includes('503') || msg.includes('timeout')) {
        log.info('Pre-flight check failed (Cloudflare block). Refreshing clearance...');
        return await this.refreshCredentials(testUrl);
      }
      throw err;
    } finally {
      session.close();
    }
  }

  /**
   * Forces a refresh of the Cloudflare credentials using a distributed Redis lock.
   */
  async refreshCredentials(triggerUrl: string): Promise<KickCFCredentials> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = this._refreshCredentials(triggerUrl).finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  private async _refreshCredentials(triggerUrl: string): Promise<KickCFCredentials> {
    let gotLock = false;
    try {
      gotLock = await this.acquireLock();

      if (!gotLock) {
        log.debug('Another process is solving Cloudflare. Waiting for result...');
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const creds = await this.getCredentials();
          if (creds) return creds;
        }
        throw new Error('Timeout waiting for Cloudflare clearance lock');
      }

      log.info({ triggerUrl }, 'Solving Cloudflare challenge via FlareSolverr...');

      const result = await fetchUrl(triggerUrl, { maxRetries: 0, timeoutMs: Kick.API_TIMEOUT_MS * 2 });

      if (
        !result.success ||
        result.cookies == null ||
        result.cookies === '' ||
        result.userAgent == null ||
        result.userAgent === ''
      ) {
        throw new Error(`FlareSolverr failed: ${!result.success ? result.error : 'Missing cookies/UA'}`);
      }

      const creds: KickCFCredentials = {
        cookies: result.cookies,
        userAgent: result.userAgent,
      };

      this.localCache = creds;

      const redis = RedisService.getActiveClient();
      if (redis) {
        await redis.set('kick:cf_credentials', JSON.stringify(creds), 'EX', Kick.CF_CACHE_TTL_SECONDS);
      }

      log.info('Cloudflare challenge solved and credentials cached globally');
      return creds;
    } finally {
      if (gotLock) await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<boolean> {
    const redis = RedisService.getActiveClient();
    if (!redis) return true;

    try {
      this.lockValue = `${process.pid}-${Date.now()}`;
      const res = await redis.set('kick:cf_lock', this.lockValue, 'EX', 60, 'NX');
      return res === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    const redis = RedisService.getActiveClient();
    if (!redis || this.lockValue == null) return;

    try {
      const val = await redis.get('kick:cf_lock');
      if (val === this.lockValue) {
        await redis.del('kick:cf_lock');
      }
    } catch {
      // Best effort cleanup
    } finally {
      this.lockValue = null;
    }
  }

  /**
   * Attempts a fetch and retries once with fresh credentials on 403/503.
   */
  async withRetry(
    url: string,
    fetchFn: (creds: KickCFCredentials | null) => Promise<string>,
  ): Promise<string> {
    const creds = await this.getCredentials();
    try {
      return await fetchFn(creds);
    } catch (err: unknown) {
      const msg = extractErrorDetails(err).message;
      if (msg.includes('403') || msg.includes('503') || msg.includes('timeout')) {
        log.info({ url }, 'Cloudflare block during fetch. Refreshing clearance...');
        const newCreds = await this.refreshCredentials(url);
        return await fetchFn(newCreds);
      }
      throw err;
    }
  }
}

export const kickCloudflareManager = new KickCloudflareManager();
