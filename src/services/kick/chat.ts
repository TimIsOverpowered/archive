import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { createSession, type ImpitSession } from '../../utils/impit-wrapper.js';
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
  private impitSession: ImpitSession;
  private logger: AppLogger;

  constructor(log?: AppLogger) {
    this.impitSession = createSession();
    this.logger = log ?? childLogger({ module: 'kick-chat-waterfall' });
  }

  async fetchPage(channelId: number | string, startTime: string): Promise<KickMessagesResponse | null> {
    const url = new URL(`${Kick.API_BASE}/api/v2/channels/${channelId}/messages`);
    url.searchParams.set('start_time', startTime);

    try {
      const response = await this.impitSession.fetchText(url.toString(), {
        timeoutMs: Kick.CHAT_API_TIMEOUT_MS,
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
        return this.fetchViaFlareSolverr(url.toString());
      }

      throw err;
    }
  }

  private async fetchViaFlareSolverr(url: string): Promise<KickMessagesResponse | null> {
    this.logger.info({ url }, 'Impit blocked by Cloudflare. Falling back to FlareSolverr...');

    const result = await fetchUrl(url, { maxRetries: 2 });

    if (result.success && result.data != null) {
      this.logger.info({ url }, 'FlareSolverr returned data');
      return result.data;
    }

    throw new Error(`FlareSolverr failed: ${!result.success ? result.error : 'unknown error'}`);
  }

  close(): void {
    this.impitSession.close();
  }
}
