// YouTube limits
export const YOUTUBE_MAX_DURATION = 43199; // 12 hours - 1 second (720 minutes)

// Live Worker Concurrency
export const VOD_LIVE_HEADROOM = 2;
export const VOD_MIN_CONCURRENCY = 50;

// Chat download constants
export const CHAT_BATCH_SIZE = 500;
export const CHAT_RATE_LIMIT_MS = 150;
export const CHAT_MAX_RETRIES = 2;
export const CHAT_RETRY_DELAY_MS = 1000;

export const HLS_POLL_INTERVAL_MS = 60_000;
export const HLS_MAX_CONSECUTIVE_ERRORS = 12;
export const HLS_NO_CHANGE_THRESHOLD = 5;
export const HLS_SEGMENT_RETRY_ATTEMPTS = 2;
export const HLS_SEGMENT_CONCURRENCY = 5;

// Redis connection
export const REDIS_RETRY_TIMEOUT_MS = 30000;
export const REDIS_MAX_RETRIES = 10;

// Kick API constants
export const KICK_API_TIMEOUT_MS = 10000;
export const KICK_PAGE_DELAY_MS = 2000;

// DB limits
export const INT32_MAX = 2_147_483_647; // PostgreSQL integer column limit

// DB client manager constants
export const DB_CLIENT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DB_CLIENT_MAX_CLIENTS = 10;
export const DB_CLIENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// Cache TTLs (in seconds)
export const VOD_DETAILS_CACHE_TTL = 3600; // 1 hour for individual VODs
export const VOD_LIST_CACHE_TTL = 900; // 15 minutes for list queries
export const EMOTE_CACHE_TTL = 86400; // 1 day for emotes

// VOD duration tolerance (seconds)
export const VOD_DURATION_TOLERANCE_SECONDS = 1;

// Percentage precision (Math.round(x * 1000) / 10 = 1 decimal place)
export const PERCENTAGE_PRECISION_MULTIPLIER = 1000;
export const PERCENTAGE_PRECISION_DIVISOR = 10;
