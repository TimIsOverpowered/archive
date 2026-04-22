import { extractErrorDetails } from '../error.js';
import { request } from '../http-client.js';
import { getLogger } from '../logger.js';
import { getDiscordAlertWebhookUrl } from '../../config/env.js';
import { isAlertsEnabled } from './context.js';
import { constructEmbed } from './embed.js';

function getUpdateUrl(webhookUrl: string, messageId: string): string {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname}/messages/${messageId}`;
  return url.toString();
}

export async function sendDiscordAlert(message: string): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (!webhookUrl) {
    return null;
  }

  try {
    const data = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: { content: message },
    });

    if (data.id) {
      return data.id;
    }
    return null;
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to send Discord alert');
    return null;
  }
}

export async function sendRichAlert(data: import('./embed.js').RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) {
    return null;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (!webhookUrl) {
    return null;
  }

  try {
    const embed = constructEmbed(data);

    const payload: Record<string, unknown> = { embeds: [embed] };

    if (data.mention === 'everyone') {
      payload.content = '@everyone';
    } else if (data.mention === 'here') {
      payload.content = '@here';
    } else if (data.mention) {
      payload.content = `<@&${data.mention}>`;
    }

    const responseData = await request<{ id?: string }>(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: payload,
    });

    if (responseData.id) {
      return responseData.id;
    }
    return null;
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to send rich Discord alert');
    return null;
  }
}

export async function updateDiscordEmbed(
  messageId: string,
  data: import('./embed.js').RichEmbedData
): Promise<void> {
  if (!isAlertsEnabled()) {
    return;
  }

  const webhookUrl = getDiscordAlertWebhookUrl();
  if (!webhookUrl) {
    return;
  }

  try {
    const updateUrl = getUpdateUrl(webhookUrl, messageId);
    const embed = constructEmbed(data);

    await request(updateUrl, {
      method: 'PATCH',
      body: { embeds: [embed] },
    });
  } catch (err) {
    getLogger().error(extractErrorDetails(err), 'Failed to update Discord embed');
  }
}

export async function initRichAlert(data: import('./embed.js').RichEmbedData): Promise<string | null> {
  if (!isAlertsEnabled()) return null;

  try {
    return await sendRichAlert(data);
  } catch {
    return null;
  }
}

export async function updateAlert(messageId: string | null, data: import('./embed.js').RichEmbedData): Promise<void> {
  if (!messageId || !isAlertsEnabled()) return;
  await updateDiscordEmbed(messageId, data).catch((err) => {
    const details = extractErrorDetails(err);
    getLogger().warn({ ...details }, 'Failed to update Discord embed');
  });
}
