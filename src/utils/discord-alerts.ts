// Context & config
export { isAlertsEnabled } from './discord/context.js';

// Embed types & helpers
export type { AlertStatus, RichEmbedData } from './discord/embed.js';
export { constructEmbed, createProgressBar } from './discord/embed.js';

// Failure tracking
export { trackFailure, resetFailures } from './discord/failures.js';

// Webhook operations
export { sendDiscordAlert, sendRichAlert, updateDiscordEmbed, initRichAlert, updateAlert } from './discord/webhook.js';
