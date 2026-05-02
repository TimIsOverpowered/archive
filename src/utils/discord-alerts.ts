// Context & config
export { isAlertsEnabled, createAlertContext } from './discord/context.js';
export type { AlertContext } from './discord/context.js';

// Embed types & helpers
export type { AlertStatus, RichEmbedData } from './discord/embed.js';
export { constructEmbed, createProgressBar, formatProgressMessage } from './discord/embed.js';

// Failure tracking
export { trackFailure, resetFailures } from './discord/failures.js';

// Webhook operations
export { sendDiscordAlert, sendRichAlert, updateDiscordEmbed, initRichAlert, updateAlert } from './discord/webhook.js';

// Stream alerts
export type { StreamAlertData } from './discord/alerts/stream.js';
export { sendStreamAlert } from './discord/alerts/stream.js';
