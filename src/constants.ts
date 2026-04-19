// ── YouTube ──────────────────────────────────────────────────────────────────
export const YOUTUBE_MAX_DURATION = 43_199; // 12 hours - 1 second (720 minutes)

// ── VOD / Live Worker ────────────────────────────────────────────────────────
export const VOD_LIVE_HEADROOM = 2;
export const VOD_MIN_CONCURRENCY = 50;
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
export const EMOTE_CACHE_TTL = 86_400; // 1 day for emotes

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

// ── Math / Misc ──────────────────────────────────────────────────────────────
export const PERCENTAGE_PRECISION_MULTIPLIER = 1_000;
export const PERCENTAGE_PRECISION_DIVISOR = 10;
