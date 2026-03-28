import axios from 'axios';
import { getStreamerConfig } from '../config/loader.js';

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

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m ${secs}s`;
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

  // Only check global alert enabled flag - no per-tenant webhook URLs (use only env var)
  if (!process.env.DISCORD_ALERTS_ENABLED || process.env.DISCORD_ALERTS_ENABLED === 'false') {
    return;
  }

  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('[Discord Alert] DISCORD_ALERT_WEBHOOK_URL not configured in environment');
    return;
  }

  const colorMap: Record<AlertType, number> = {
    in_progress: 3447003, // Blue (#3498db)
    failure: 15158332, // Red (#e74c3c)
    success: 3066992, // Green (#2ecc71)
  };

  const emojiMap: Record<AlertType, string> = {
    in_progress: '🔄',
    failure: '❌',
    success: '✅',
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
    await axios.post(webhookUrl, { embeds });
  } catch (error) {
    console.error(`[Discord Alert] Failed to send alert for VOD ${alert.vodId}:`, error);
  }
}

export function createProgressBar(percent: number): string {
  const bars = 20;
  const filled = Math.round((percent / 100) * bars);
  const empty = bars - filled;

  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${Math.round(percent)}%`;
}
