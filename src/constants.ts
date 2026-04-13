// YouTube limits
export const YOUTUBE_MAX_DURATION = 43199; // 12 hours - 1 second (720 minutes)

// Chat download constants
export const CHAT_BATCH_SIZE = 2500;
export const CHAT_RATE_LIMIT_MS = 150;
export const CHAT_MAX_RETRIES = 3;
export const CHAT_RETRY_DELAY_MS = 1000;

export const HLS_POLL_INTERVAL_MS = 60_000;
export const HLS_MAX_CONSECUTIVE_ERRORS = 12;
export const HLS_NO_CHANGE_THRESHOLD = 5;
export const HLS_SEGMENT_RETRY_ATTEMPTS = 3;
export const HLS_SEGMENT_CONCURRENCY = 5;

// Redis connection
export const REDIS_RETRY_TIMEOUT_MS = 30000;
export const REDIS_MAX_RETRIES = 10;

// Kick API constants
export const KICK_API_TIMEOUT_MS = 10000;
export const KICK_PAGE_DELAY_MS = 2000;
