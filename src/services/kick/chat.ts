import { Kick } from '../../constants.js';
import { createSession, type ImpitSession } from '../../utils/impit-wrapper.js';
import type { AppLogger } from '../../utils/logger.js';
import { kickCloudflareManager } from './cloudflare.js';

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

  constructor(_log?: AppLogger) {
    this.impitSession = createSession();
  }

  async fetchPage(channelId: number | string, startTime: string): Promise<KickMessagesResponse | null> {
    const url = new URL(`${Kick.API_BASE}/api/v2/channels/${channelId}/messages`);
    url.searchParams.set('start_time', startTime);
    const urlStr = url.toString();

    const creds = await kickCloudflareManager.getCredentials();
    if (creds) {
      this.impitSession.setCloudflareCredentials(creds.cookies, creds.userAgent);
    }

    const response = await kickCloudflareManager.withRetry(urlStr, async (cfCreds) => {
      if (cfCreds) {
        this.impitSession.setCloudflareCredentials(cfCreds.cookies, cfCreds.userAgent);
      }
      return await this.impitSession.fetchText(urlStr, { timeoutMs: Kick.CHAT_API_TIMEOUT_MS });
    });

    return JSON.parse(response) as KickMessagesResponse;
  }

  close(): void {
    this.impitSession.close();
  }
}
