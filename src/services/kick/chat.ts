import { Kick } from '../../constants.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { childLogger, type AppLogger } from '../../utils/logger.js';

export interface KickMessageSenderIdentity {
  color?: string;
  badges?: Array<{
    type: string;
    text: string;
    count?: number;
    sort_order?: number;
  }>;
  badges_v2?: Array<{
    name: string;
    badge_type: string;
    image_url: string;
    selected?: boolean;
    metadata?: Record<string, unknown>;
    sort_order?: number;
  }>;
}

export interface KickMessageSender {
  id?: number;
  slug?: string;
  username?: string;
  identity?: KickMessageSenderIdentity;
}

export interface KickChatMessage {
  id: string;
  chat_id?: number;
  user_id?: number;
  content?: string;
  type?: string;
  metadata?: string;
  created_at: string;
  sender?: KickMessageSender;
}

export interface KickMessagesResponse {
  status?: {
    error?: boolean;
    code?: number;
    message?: string;
  };
  data?: {
    messages?: KickChatMessage[];
    cursor?: string;
    pinned_message?: unknown;
  };
}

export class KickChatWaterfallClient {
  private cycleTlsSession: CycleTLSSession;
  private cfCookies?: string;
  private cfUserAgent?: string;
  private logger: AppLogger;

  // Mutex state for Cloudflare challenge handling
  private isSolvingChallenge = false;
  private challengePromise: Promise<void> | null = null;

  constructor(log?: AppLogger) {
    this.cycleTlsSession = createSession();
    this.logger = log ?? childLogger({ module: 'kick-chat-waterfall' });
  }

  async fetchPage(channelId: number | string, startTime: string): Promise<KickMessagesResponse | null> {
    const url = new URL(`${Kick.API_BASE}/api/v2/channels/${channelId}/messages`);
    url.searchParams.set('start_time', startTime);

    // MUTEX CHECK: If another thread is solving CF, wait for clearance before firing
    if (this.isSolvingChallenge && this.challengePromise) {
      await this.challengePromise;
    }

    try {
      // 1. FAST PATH: CycleTLS
      const response = await this.cycleTlsSession.fetchText(url.toString(), {
        timeoutMs: Kick.CHAT_API_TIMEOUT_MS,
        ...(this.cfCookies != null && this.cfCookies !== '' && { headers: { Cookie: this.cfCookies } }),
        ...(this.cfUserAgent != null && this.cfUserAgent !== '' && { userAgent: this.cfUserAgent }),
      });

      const data = JSON.parse(response) as KickMessagesResponse;
      return data;
    } catch (err: unknown) {
      const msg = extractErrorDetails(err).message;

      // Pure rate limits bubble up to the paginator for the 30s sleep
      if (msg.includes('429')) {
        throw err;
      }

      // 2. DETECT CLOUDFLARE
      if (
        msg.includes('403') ||
        msg.includes('495') ||
        msg.includes('408') ||
        msg.includes('503') ||
        msg.includes('timeout') ||
        msg.includes('status 0')
      ) {
        return this.solveChallengeAndRetry(url.toString());
      }

      throw err;
    }
  }

  private async solveChallengeAndRetry(url: string): Promise<KickMessagesResponse | null> {
    // MUTEX DOUBLE-CHECK: Did another thread grab the lock while we were catching the error?
    if (this.isSolvingChallenge && this.challengePromise) {
      this.logger.debug('Another thread is solving CF. Waiting in queue...');
      await this.challengePromise;
      // Woke up! Clearance is ready. Retry the fast-path for THIS specific URL.
      return this.fetchPageUsingUrl(url);
    }

    // ACQUIRE LOCK
    this.isSolvingChallenge = true;
    let resolveChallenge!: () => void;
    let rejectChallenge!: (err: Error) => void;

    this.challengePromise = new Promise((resolve, reject) => {
      resolveChallenge = resolve;
      rejectChallenge = reject;
    });

    this.logger.info('CycleTLS blocked by Cloudflare. Booting FlareSolverr (Lock acquired)...');

    try {
      // 3. HEAVY PATH: FlareSolverr
      const fsResult = await fetchUrl(url, { maxRetries: 2 });

      if (fsResult.success) {
        this.logger.info('FlareSolverr bypassed Cloudflare. Saving clearance tokens...');

        if (fsResult.cookies != null && fsResult.cookies !== '') this.cfCookies = fsResult.cookies;
        if (fsResult.userAgent != null && fsResult.userAgent !== '') this.cfUserAgent = fsResult.userAgent;

        // UNLOCK waiting threads so they can retry their own URLs
        resolveChallenge();

        // Return the data FS already extracted so we don't waste the request
        return fsResult.data as KickMessagesResponse;
      } else {
        throw new Error(`FlareSolverr fallback failed: ${fsResult.error}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectChallenge(error);
      throw error;
    } finally {
      // RELEASE LOCK STATE
      this.isSolvingChallenge = false;
      this.challengePromise = null;
    }
  }

  private async fetchPageUsingUrl(url: string): Promise<KickMessagesResponse | null> {
    // MUTEX CHECK: If another thread started solving while we were transitioning, wait
    if (this.isSolvingChallenge && this.challengePromise) {
      await this.challengePromise;
    }

    try {
      const response = await this.cycleTlsSession.fetchText(url, {
        timeoutMs: Kick.CHAT_API_TIMEOUT_MS,
        ...(this.cfCookies != null && this.cfCookies !== '' && { headers: { Cookie: this.cfCookies } }),
        ...(this.cfUserAgent != null && this.cfUserAgent !== '' && { userAgent: this.cfUserAgent }),
      });

      return JSON.parse(response) as KickMessagesResponse;
    } catch (err: unknown) {
      const msg = extractErrorDetails(err).message;

      if (msg.includes('429')) {
        throw err;
      }

      if (
        msg.includes('403') ||
        msg.includes('495') ||
        msg.includes('408') ||
        msg.includes('503') ||
        msg.includes('timeout') ||
        msg.includes('status 0')
      ) {
        return this.solveChallengeAndRetry(url);
      }

      throw err;
    }
  }

  close(): void {
    this.cycleTlsSession.close();
  }
}
