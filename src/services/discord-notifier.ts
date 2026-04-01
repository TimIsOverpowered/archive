import { getStreamerConfig } from '../config/loader.js';
import { extractErrorDetails } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import { formatDuration } from '../utils/formatting.js';

export type AlertType = 'in_progress' | 'failure' | 'success';

interface DiscordAlert {
  tenantId: string;
  vodId: string;
  platform: 'twitch' | 'kick';
  alertType: AlertType;
  streamerName?: string;
  durationSeconds?: number;
  errorMessage?: string;
}

function getAlertTitle(alert: DiscordAlert): string {
  switch (alert.alertType) {
    case 'in_progress':
      return `Stream Download Started`;
    case 'failure':
      return `Download Failed`;
    case 'success':
      return `Upload Completed Successfully`;
  }
}

export async function sendDiscordAlert(alert: DiscordAlert): Promise<void> {
  getStreamerConfig(alert.tenantId); // Fetch to validate tenant exists

  if (!process.env.DISCORD_ALERTS_ENABLED || process.env.DISCORD_ALERTS_ENABLED === 'false') {
    return;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;

  if (!webhookUrl) {
    logger.warn('[Discord Alert] DISCORD_ALERT_WEBHOOK_URL not configured in environment');
    return;
  }

  const colorMap: Record<AlertType, number> = {
    in_progress: 3447003, // Blue (#3498db)
    failure: 15158332, // Red (#e74c3c)
    success: 3066992, // Green (#2ecc71)
  };

  const emojiMap: Record<AlertType, string> = {
    in_progress: '[IN_PROGRESS]',
    failure: '[FAILED]',
    success: '[SUCCESS]',
  };

  const embeds = [
    {
      title: `${emojiMap[alert.alertType]} ${getAlertTitle(alert)}`,
      description: alert.errorMessage ? `**Error:**\n\`\`\`${alert.errorMessage}\`\`\`` : undefined,
      color: colorMap[alert.alertType],
      fields: [
        { name: 'Platform', value: alert.platform.toUpperCase(), inline: true },
        { name: 'VOD ID', value: `\`${alert.vodId}\``, inline: true },
        ...(alert.durationSeconds ? [{ name: 'Duration', value: formatDuration(alert.durationSeconds), inline: true }] : []),
      ],
      footer: {
        text: `Archive System`,
      },
      timestamp: new Date().toISOString(),
    },
  ];

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json' as any,
      },
      body: JSON.stringify({ embeds }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed with status ${response.status}`);
    }
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ vodId: alert.vodId, ...details }, '[Discord Alert] Failed to send alert');
  }
}

export function createProgressBar(percent: number): string {
  const bars = 20;
  const filled = Math.round((percent / 100) * bars);
  const empty = bars - filled;

  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${Math.round(percent)}%`;
}
