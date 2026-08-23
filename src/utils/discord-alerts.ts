// Context & config
export { isAlertsEnabled } from './discord/context.ts';

// Embed types & helpers
export type { AlertStatus, RichEmbedData } from './discord/embed.ts';
export { constructEmbed, createProgressBar } from './discord/embed.ts';

// Failure tracking
export { resetFailures, trackFailure } from './discord/failures.ts';

// Webhook operations
export { initRichAlert, sendDiscordAlert, sendRichAlert, updateAlert, updateDiscordEmbed } from './discord/webhook.ts';
