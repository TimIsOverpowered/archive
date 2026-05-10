// ── YouTube ──────────────────────────────────────────────────────────────────
export const YouTube = {
  /** 12 hours - 1 second (720 minutes) */
  MAX_DURATION: 43_199,
  CATEGORY_ID: '20', // Gaming
  REDIRECT_URI: 'https://developers.google.com/oauthplayground',
} as const;

// ── VOD / Live Worker ────────────────────────────────────────────────────────
export const Vod = {
  LIVE_HEADROOM: 2,
  /** Minimum concurrent live workers regardless of tenant count; ensures adequate throughput for high-traffic channels */
  LIVE_MIN_CONCURRENCY: 50,
  DURATION_TOLERANCE_SECONDS: 1,
} as const;

// ── Chat Download ────────────────────────────────────────────────────────────
export const Chat = {
  BATCH_SIZE: 2500,
  RATE_LIMIT_MS: 70,
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 1_000,
} as const;

// ── HLS ──────────────────────────────────────────────────────────────────────
export const Hls = {
  POLL_INTERVAL_MS: 60_000,
  MAX_CONSECUTIVE_ERRORS: 12,
  NO_CHANGE_THRESHOLD: 10,
  SEGMENT_RETRY_ATTEMPTS: 2,
  SEGMENT_CONCURRENCY: 5,
} as const;

// ── Cache TTLs (seconds) ────────────────────────────────────────────────────
export const Cache = {
  /** 1 hour for individual VODs */
  VOD_DETAILS_TTL: 60 * 60,
  /** 15 minutes for list queries */
  VOD_LIST_TTL: 15 * 60,
  /** 15 seconds for live status/duration */
  VOD_VOLATILE_TTL: 15,
  /** 1 day for emotes */
  EMOTE_TTL: 24 * 60 * 60,
  /** 1 day for badges */
  BADGES_TTL: 24 * 60 * 60,
  /** 3 days for chat cache */
  CHAT_TTL: 3 * 24 * 60 * 60,
  /** Cap paginated list cache to prevent tag explosion */
  MAX_PAGES: 10,
} as const;

// ── Cache Stale-While-Revalidate ────────────────────────────────────────────
export const CacheSwr = {
  /** Revalidate when 80% of TTL has elapsed */
  STALE_RATIO: 0.8,
  /** 5 minutes */
  FAILURES_TTL_MS: 5 * 60 * 1_000,
  /** Max revalidation failures before skipping retries */
  MAX_FAILURES: 3,
} as const;

// ── Cache Inflight Tracking ─────────────────────────────────────────────────
export const CacheInflight = {
  /** 30 seconds max for in-flight requests */
  TIMEOUT_MS: 30_000,
  /** Max concurrent in-flight requests per process */
  CACHE_MAX: 1000,
} as const;

// ── Config Cache ─────────────────────────────────────────────────────────────
export const ConfigCache = {
  /** 1 hour */
  TTL: 3600,
} as const;

// ── Cache Tag TTL Buffer ────────────────────────────────────────────────────
export const CacheTag = {
  /** 1 minute grace period past cache TTL */
  TTL_BUFFER_MS: 60_000,
} as const;

// ── Database ─────────────────────────────────────────────────────────────────
export const Db = {
  /** PostgreSQL integer column limit */
  INT32_MAX: 2_147_483_647,
  POOL_IDLE_TIMEOUT_MS: 15 * 60 * 1_000,
  POOL_MAX_PER_TENANT: 10,
  POOL_GLOBAL_MAX_CONNECTIONS: 800,
  POOL_CLEANUP_INTERVAL_MS: 5 * 60 * 1_000,
  QUERY_TIMEOUT_MS: 10_000,
} as const;

// ── Kick API ─────────────────────────────────────────────────────────────────
export const Kick = {
  API_TIMEOUT_MS: 10_000,
  LIVE_API_TIMEOUT_MS: 15_000,
  API_BASE: 'https://kick.com',
  SUBCATEGORIES_URL: 'https://kick.com/api/v1/subcategories',
} as const;

// ── FlareSolverr ─────────────────────────────────────────────────────────────
export const Flaresolverr = {
  TIMEOUT_MS: 5 * 60 * 1_000,
  HEALTH_CACHE_TTL_MS: 30_000,
} as const;

// ── Encryption ───────────────────────────────────────────────────────────────
export const Encryption = {
  /** AES-256 requires exactly 32 bytes */
  KEY_LENGTH: 32,
  /** Recommended for GCM mode */
  IV_LENGTH: 12,
  AUTH_TAG_LENGTH: 16,
} as const;

// ── Cloudflare ───────────────────────────────────────────────────────────────
export const Cloudflare = {
  /** 7 days */
  IP_RANGES_TTL: 86_400 * 7,
} as const;

// ── Logs / Comments ──────────────────────────────────────────────────────────
export const Logs = {
  BUCKET_SIZE: 60,
  BUCKET_LIMIT: 10000,
  /** Minimum historical messages to pre-fill UI on scrub */
  TARGET_PAST: 20,
  /** Minimum future messages to prevent client API spam */
  TARGET_FUTURE: 30,
  /** Maximum buckets to scan in either direction (4 minutes) */
  MAX_EXPANSION: 4,
} as const;

// ── Token Health ─────────────────────────────────────────────────────────────
export const Token = {
  MAX_FAILURES: 3,
  TWITCH_FAILURE_KEY: 'twitch',
} as const;

// ── Monitor ──────────────────────────────────────────────────────────────────
export const Monitor = {
  TWITCH_BATCH_JOB_ID: 'monitor_twitch_batch',
} as const;

// ── Twitch API ───────────────────────────────────────────────────────────────
export const Twitch = {
  HELIX_BASE_URL: 'https://api.twitch.tv/helix',
  GQL_URL: 'https://gql.twitch.tv/gql',
  TOKEN_URL: 'https://id.twitch.tv/oauth2/token',
  USHER_BASE_URL: 'https://usher.ttvnw.net/vod',
  GQL_CLIENT_ID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  BACKUP_GQL_CLIENT_ID: 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
  /** Max user_id query params per /streams request. */
  STREAMS_BATCH_SIZE: 100,
  /** Redis key for shared app access token */
  REDIS_TOKEN_KEY: 'twitch:app_token',
  /** Redis lock key for distributed token refresh */
  REDIS_LOCK_KEY: 'twitch:token:refreshing',
  /** Lock TTL in seconds */
  LOCK_TTL: 30,
} as const;

// ── Emote APIs ───────────────────────────────────────────────────────────────
export const Emote = {
  FFZ_API_BASE: 'https://api.frankerfacez.com/v1/room/id',
  BTTV_API_BASE: 'https://api.betterttv.net/3/cached',
  SEVENTV_API_BASE: 'https://7tv.io/v3',
} as const;

// ── HTTP / Retry ─────────────────────────────────────────────────────────────
export const Http = {
  DEFAULT_ATTEMPTS: 3,
  DEFAULT_BASE_DELAY_MS: 1_000,
  DEFAULT_MAX_DELAY_MS: 30_000,
  SEGMENT_DOWNLOAD_MAX_CONNECTIONS: 5000,
  SEGMENT_DOWNLOAD_PIPELINING: 1,
} as const;

// ── HTTP / Server ────────────────────────────────────────────────────────────
export const Server = {
  /** 25MB request body limit */
  BODY_LIMIT: 25 * 1024 * 1024,
  /** 10KB response compression threshold */
  COMPRESSION_THRESHOLD: 10240,
  /** Grace period before force-exit on SIGTERM/SIGINT */
  SHUTDOWN_TIMEOUT_MS: 5_000,
} as const;

// ── Redis ────────────────────────────────────────────────────────────────────
export const RedisBatch = {
  /** Pipeline chunk size for tag registration */
  CHUNK_SIZE: 50,
  /** SSCAN COUNT for tag invalidation iteration */
  SCAN_COUNT: 50,
} as const;

// ── Full-Text Search ─────────────────────────────────────────────────────────
export const Fts = {
  /** Max words in a single fts query to prevent massive tsquery strings */
  MAX_WORDS: 20,
} as const;

// ── Cache ────────────────────────────────────────────────────────────────────
export const CacheRefresh = {
  /** Pre-fetch threshold — refresh if TTL remaining is under 1 hour */
  TTL_REMAINING_THRESHOLD: 3_600,
} as const;

// ── Job IDs ────────────────────────────────────────────────────────────────────
export const Jobs = {
  LIVE_HLS_JOB_PREFIX: 'live_hls_',
  YOUTUBE_JOB_PREFIX: 'youtube_',
  VOD_JOB_PREFIX: 'vod_',
  CHAT_JOB_PREFIX: 'chat_',
  DMCA_JOB_PREFIX: 'dmca_',
  FINALIZE_JOB_PREFIX: 'finalize_',
  COPY_JOB_PREFIX: 'copy_',
} as const;
