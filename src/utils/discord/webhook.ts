import { getDiscordAlertWebhookUrl } from '../../config/env.js';
import { DiscordAlert } from '../../constants.js';
import { extractErrorDetails } from '../error.js';
import { request } from '../http-client.js';
import { getLogger } from '../logger.js';
import { isAlertsEnabled } from './context.js';
import { constructEmbed, RichEmbedData } from './embed.js';

function getUpdateUrl(webhookUrl: string, messageId: string): string {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname}/messages/${messageId}`;
  return url.toString();
}

type PendingTask = {
  resolve: () => void;
  reject: (err: unknown) => void;
};

const messageQueues = new Map<string, PendingTask[]>();

async function serializeByMessage(messageId: string, fn: () => Promise<void>): Promise<void> {
  let queue = messageQueues.get(messageId);
  if (!queue) {
    queue = [];
    messageQueues.set(messageId, queue);
  }

  await new Promise<void>((resolve, reject) => {
    const task = { resolve, reject };
    if (queue.length === 0) {
      void (async () => {
        try {
          await fn();
          task.resolve();
        } catch (err) {
          task.reject(err);
        }
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) continue;
          try {
            await fn();
            task.resolve();
          } catch (err) {
            task.reject(err);
          }
        }
        messageQueues.delete(messageId);
      })();
    } else {
      queue.push(task);
    }
  });
}

export async function sendDiscordAlert(message: string): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (webhookUrl == null || webhookUrl === '') {
    return null;
  }

  try {
    const data = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: { content: message },
      timeoutMs: DiscordAlert.WEBHOOK_TIMEOUT_MS,
    });

    if (data.id != null && data.id !== '') {
      return data.id;
    }
    return null;
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to send Discord alert');
    return null;
  }
}

export async function sendRichAlert(data: RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (webhookUrl == null || webhookUrl === '') {
    return null;
  }

  try {
    const embed = constructEmbed(data);

    const payload: Record<string, unknown> = { embeds: [embed] };

    if (data.mention === 'everyone') {
      payload.content = '@everyone';
    } else if (data.mention === 'here') {
      payload.content = '@here';
    } else if (data.mention != null) {
      payload.content = `<@&${data.mention as string}>`;
    }

    const responseData = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: payload,
      timeoutMs: DiscordAlert.WEBHOOK_TIMEOUT_MS,
    });

    if (responseData.id != null && responseData.id !== '') {
      return responseData.id;
    }
    return null;
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to send rich Discord alert');
    return null;
  }
}

export async function updateDiscordEmbed(messageId: string, data: RichEmbedData): Promise<void> {
  if (!isAlertsEnabled()) {
    return;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (webhookUrl == null || webhookUrl === '') {
    return;
  }

  try {
    const updateUrl = getUpdateUrl(webhookUrl, messageId);
    const embed = constructEmbed(data);

    await serializeByMessage(messageId, async () => {
      await request(updateUrl, {
        method: 'PATCH',
        body: { embeds: [embed] },
        timeoutMs: DiscordAlert.WEBHOOK_TIMEOUT_MS,
        retryOptions: {
          attempts: DiscordAlert.WEBHOOK_RETRY_ATTEMPTS,
          baseDelayMs: DiscordAlert.WEBHOOK_RETRY_BASE_DELAY_MS,
          maxDelayMs: DiscordAlert.WEBHOOK_RETRY_MAX_DELAY_MS,
        },
      });
    });
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to update Discord embed');
  }
}

export async function initRichAlert(data: RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) return null;

  try {
    return await sendRichAlert(data);
  } catch {
    return null;
  }
}

export async function updateAlert(messageId: string | null, data: RichEmbedData): Promise<void> {
  if (messageId == null || messageId === '' || !isAlertsEnabled()) return;
  await updateDiscordEmbed(messageId, data).catch((err) => {
    const details = extractErrorDetails(err);
    getLogger().warn({ ...details }, 'Failed to update Discord embed');
  });
}
