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
  NO_CHANGE_THRESHOLD: 5,
  SEGMENT_RETRY_ATTEMPTS: 2,
  SEGMENT_CONCURRENCY: 5,
} as const;

// ── Redis ────────────────────────────────────────────────────────────────────
export const Redis = {
  RETRY_TIMEOUT_MS: 30_000,
  MAX_RETRIES: 10,
} as const;

// ── Cache TTLs (seconds) ────────────────────────────────────────────────────
export const Cache = {
  /** 1 hour for individual VODs */
  VOD_DETAILS_TTL: 3_600,
  /** 15 minutes for list queries */
  VOD_LIST_TTL: 900,
  /** 15 seconds for live status/duration */
  VOD_VOLATILE_TTL: 15,
  /** 1 day for emotes */
  EMOTE_TTL: 86_400,
  /** 3 days for chat cursor positions */
  CHAT_CURSOR_TTL: 3 * 24 * 3600,
  /** 3 days for chat offset positions */
  CHAT_OFFSET_TTL: 3 * 24 * 3600,
  /** 30 days for chat bucket size cache */
  CHAT_BUCKET_SIZE_TTL: 30 * 24 * 3600,
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

// ── Cache Tag TTL Buffer ────────────────────────────────────────────────────
export const CacheTag = {
  /** 1 minute grace period past cache TTL */
  TTL_BUFFER_MS: 60_000,
} as const;

// ── Database ─────────────────────────────────────────────────────────────────
export const Db = {
  /** PostgreSQL integer column limit */
  INT32_MAX: 2_147_483_647,
  POOL_IDLE_TIMEOUT_MS: 30 * 60 * 1_000,
  POOL_MAX_CLIENTS: 10,
  POOL_CLEANUP_INTERVAL_MS: 5 * 60 * 1_000,
  STATEMENT_TIMEOUT_MS: 30_000,
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
  PAGE_SIZE: 200,
  DEFAULT_BUCKET_SIZE: 120,
  TARGET_COMMENTS_PER_BUCKET: 300,
} as const;

// ── Token Health ─────────────────────────────────────────────────────────────
export const Token = {
  MAX_FAILURES: 3,
} as const;

// ── Twitch API ───────────────────────────────────────────────────────────────
export const Twitch = {
  HELIX_BASE_URL: 'https://api.twitch.tv/helix',
  GQL_URL: 'https://gql.twitch.tv/gql',
  TOKEN_URL: 'https://id.twitch.tv/oauth2/token',
  USHER_BASE_URL: 'https://usher.ttvnw.net/vod',
  GQL_CLIENT_ID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  BACKUP_GQL_CLIENT_ID: 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
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

// ── Cache ────────────────────────────────────────────────────────────────────
export const CacheRefresh = {
  /** Pre-fetch threshold — refresh if TTL remaining is under 1 hour */
  TTL_REMAINING_THRESHOLD: 3_600,
} as const;
