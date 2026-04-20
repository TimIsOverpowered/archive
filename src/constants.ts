// ── YouTube ──────────────────────────────────────────────────────────────────
export const YOUTUBE_MAX_DURATION = 43_199; // 12 hours - 1 second (720 minutes)

// ── VOD / Live Worker ────────────────────────────────────────────────────────
export const VOD_LIVE_HEADROOM = 2;
export const VOD_MIN_CONCURRENCY = 50; // Minimum concurrent live workers regardless of tenant count; ensures adequate throughput for high-traffic channels
export const VOD_DURATION_TOLERANCE_SECONDS = 1;

// ── Chat Download ────────────────────────────────────────────────────────────
export const CHAT_BATCH_SIZE = 500;
export const CHAT_RATE_LIMIT_MS = 150;
export const CHAT_MAX_RETRIES = 2;
export const CHAT_RETRY_DELAY_MS = 1_000;

// ── HLS ──────────────────────────────────────────────────────────────────────
export const HLS_POLL_INTERVAL_MS = 60_000;
export const HLS_MAX_CONSECUTIVE_ERRORS = 12;
export const HLS_NO_CHANGE_THRESHOLD = 5;
export const HLS_SEGMENT_RETRY_ATTEMPTS = 2;
export const HLS_SEGMENT_CONCURRENCY = 5;

// ── Redis ────────────────────────────────────────────────────────────────────
export const REDIS_RETRY_TIMEOUT_MS = 30_000;
export const REDIS_MAX_RETRIES = 10;

// ── Cache TTLs (seconds) ────────────────────────────────────────────────────
export const VOD_DETAILS_CACHE_TTL = 3_600; // 1 hour for individual VODs
export const VOD_LIST_CACHE_TTL = 900; // 15 minutes for list queries
export const VOD_VOLATILE_CACHE_TTL = 15; // 15 seconds for live status/duration
export const EMOTE_CACHE_TTL = 86_400; // 1 day for emotes
export const MAX_CACHE_PAGES = 10; // cap paginated list cache to prevent tag explosion

// ── Database ─────────────────────────────────────────────────────────────────
export const INT32_MAX = 2_147_483_647; // PostgreSQL integer column limit
export const DB_CLIENT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
export const DB_CLIENT_MAX_CLIENTS = 10;
export const DB_CLIENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

// ── Kick API ─────────────────────────────────────────────────────────────────
export const KICK_API_TIMEOUT_MS = 10_000;
export const KICK_LIVE_API_TIMEOUT_MS = 15_000;
export const KICK_PAGE_DELAY_MS = 2_000;

// ── Puppeteer ────────────────────────────────────────────────────────────────
export const PUPPETEER_NAV_TIMEOUT_MS = 5 * 60 * 1_000;
export const PUPPETEER_HEALTH_CACHE_TTL_MS = 30_000;

// ── Encryption ───────────────────────────────────────────────────────────────
export const ENCRYPTION_KEY_LENGTH = 32; // AES-256 requires exactly 32 bytes
export const ENCRYPTION_IV_LENGTH = 12; // Recommended for GCM mode
export const ENCRYPTION_AUTH_TAG_LENGTH = 16;

// ── Cloudflare ───────────────────────────────────────────────────────────────
export const CF_IP_RANGES_TTL = 86_400 * 7; // 7 days

// ── Logs / Comments ──────────────────────────────────────────────────────────
export const LOGS_PAGE_SIZE = 200;
export const LOGS_DEFAULT_BUCKET_SIZE = 120;
export const LOGS_TARGET_COMMENTS_PER_BUCKET = 300;

// ── Token Health ─────────────────────────────────────────────────────────────
export const TOKEN_MAX_FAILURES = 3;

// ── Twitch API ───────────────────────────────────────────────────────────────
export const TWITCH_HELIX_BASE_URL = 'https://api.twitch.tv/helix';
export const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_USHER_BASE_URL = 'https://usher.ttvnw.net/vod';
export const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const BACKUP_GQL_TWITCH_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';

// ── Kick API ─────────────────────────────────────────────────────────────────
export const KICK_API_BASE = 'https://kick.com';
export const KICK_SUBCATEGORIES_URL = `${KICK_API_BASE}/api/v1/subcategories`;

// ── Emote APIs ───────────────────────────────────────────────────────────────
export const FFZ_API_BASE = 'https://api.frankerfacez.com/v1/room/id';
export const BTTV_API_BASE = 'https://api.betterttv.net/3/cached';
export const SEVENTV_API_BASE = 'https://7tv.io/v3';

// ── YouTube ──────────────────────────────────────────────────────────────────
export const YOUTUBE_CATEGORY_ID = '20'; // Gaming
export const YOUTUBE_REDIRECT_URI = 'https://developers.google.com/oauthplayground';

// ── HTTP / Retry ─────────────────────────────────────────────────────────────
export const HTTP_DEFAULT_ATTEMPTS = 3;
export const HTTP_DEFAULT_BASE_DELAY_MS = 1_000;
export const HTTP_DEFAULT_MAX_DELAY_MS = 30_000;

// ── Math / Misc ──────────────────────────────────────────────────────────────
export const PERCENTAGE_PRECISION_MULTIPLIER = 1_000;
export const PERCENTAGE_PRECISION_DIVISOR = 10;
