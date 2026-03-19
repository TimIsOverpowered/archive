# Implementation Task List

> This file tracks individual implementation tasks. Update checkboxes as you complete each item.

## Phase 0 — Security (Do Before Any Development)

**Status:** ⏸️ BLOCKED - Current project must stay alive until cutover

- [ ] Audit git history for committed secrets using `git-secrets` or `trufflehog`
- [ ] Rotate all Twitch client secrets across all 5 instances
- [ ] Rotate all YouTube/Google OAuth credentials across all 5 instances
- [ ] Rotate any database passwords that may have been exposed
- [ ] Move all credentials out of `config/default.json` into environment variables (dotenv + `.gitignore`)
- [ ] Add `config/`, `.env`, and any secret files to `.gitignore` on all 5 instances

> ⚠️ Do not proceed to Phase 1 until all credentials are rotated and secured.

---

## Phase 1 — Foundation

### Project Setup
- [ ] Initialize new Node.js project with `npm init -y`
- [ ] Install TypeScript: `npm install -D typescript ts-node @types/node`
- [ ] Install Fastify: `npm install fastify @fastify/jwt`
- [ ] Create `tsconfig.json` with strict mode enabled
- [ ] Create `.gitignore` (node_modules, dist, .env, config/streamers/*.json)

### Environment Configuration
- [ ] Create `.env.example` with all required variables:
  - [ ] PORT, NODE_ENV
  - [ ] REDIS_URL
  - [ ] STREAMERS_CONFIG_DIR
  - [ ] HEALTH_TOKEN
  - [ ] KICK_PUPPETEER_MEMORY_LIMIT_MB

### Redis Connection
- [ ] Install ioredis: `npm install ioredis`
- [ ] Create `src/utils/redis.ts` with connection helper
- [ ] Implement exponential backoff on startup (2s, 4s, 8s, 16s, 32s = ~62s total)
- [ ] Add graceful exit with error logging after max retries

### Config Loader
- [ ] Define `StreamersConfig` interface in `src/config/types.ts`
- [ ] Create `src/config/loader.ts` that:
  - [ ] Reads all JSON files from `config/streamers/` directory
  - [ ] Validates each config against TypeScript interface
  - [ ] Returns validated array of streamer configs
  - [ ] Throws descriptive errors on invalid configs

### Prisma Setup
- [ ] Install Prisma: `npm install prisma @prisma/client -D`
- [ ] Initialize Prisma: `npx prisma init`
- [ ] Define shared schema in `src/db/schema.prisma`:
  - [ ] Vods model (id, title, platform, stream_id, created_at, youtube JSONB, drive JSONB)
  - [ ] Logs model (vod_id, username, user_color, content, content_offset_seconds, created_at)
  - [ ] Emotes model (vod_id, set_id, emote_id, code, image_url)
  - [ ] Games model (vod_id, game_name, start_time, end_time)
- [ ] Create `src/db/client.ts` with per-streamer Prisma client factory:
  - [ ] Map-based caching of clients by streamer ID
  - [ ] Connection limit parameter in datasource URL
  - [ ] Proper cleanup on process exit

---

## Phase 2 — API (Run Parallel with Phase 3)

### Server Setup
- [ ] Create `src/api/server.ts` with Fastify app initialization
- [ ] Configure CORS, body parsing, error handling
- [ ] Add startup logging with environment info

### VODs Routes
- [ ] Create `src/api/routes/vods.ts`:
  - [ ] `GET /vods/:streamerId` - list all VODs for streamer
  - [ ] `GET /vods/:streamerId/:vodId` - get single VOD metadata
  - [ ] Add route-level streamer resolution middleware
  - [ ] Return proper error codes (404, 401, 500)

### Chat Routes
- [ ] Create `src/api/routes/chat.ts`:
  - [ ] `GET /vods/:streamerId/:vodId/chat` - get chat replay
  - [ ] Implement pagination if needed
  - [ ] Filter by time range if supported

### Auth Middleware
- [ ] Create `src/api/middleware/auth.ts`:
  - [ ] Validate API key from header (for admin endpoints if needed)
  - [ ] Use constant-time comparison for security

### Health Endpoint
- [ ] Create health check handler:
  - [ ] Verify Redis connectivity
  - [ ] Probe each streamer's DB with `SELECT 1`
  - [ ] Get BullMQ job counts per streamer queue
  - [ ] Check Kick Puppeteer instance memory (if enabled)
  - [ ] Return composite status (ok/degraded/error)
  - [ ] Require `X-Health-Token` header matching env var

---

## Phase 3 — Worker (Run Parallel with Phase 2)

### BullMQ Setup
- [ ] Install BullMQ: `npm install bullmq`
- [ ] Create queue factory in `src/workers/index.ts`
- [ ] Set up job name spacing by streamer ID
- [ ] Configure default retry options

### Twitch Integration
- [ ] Create `src/services/twitch.ts`:
  - [ ] Implement client credentials grant flow
  - [ ] Cache access token in Redis with TTL
  - [ ] Auto-refresh on 401 responses
  - [ ] Expose token getter for other services

### YouTube Integration
- [ ] Create `src/services/youtube.ts`:
  - [ ] Implement refresh token → access token exchange
  - [ ] Cache access tokens in memory with expiry tracking
  - [ ] Auto-refresh on token expiry
  - [ ] Upload video with metadata (title, description, chapters)

### YouTube Auth CLI Script
- [ ] Create `scripts/auth-youtube.ts`:
  - [ ] Parse `--streamer` argument
  - [ ] Open browser to Google OAuth consent screen
  - [ ] Spin up local server on port 9999 for callback
  - [ ] Exchange auth code for tokens
  - [ ] Write refresh token to streamer config file
  - [ ] Add security warning about not committing config

### VOD Processing Pipeline
- [ ] Create `src/jobs/vod.job.ts` with job definition
- [ ] Create `src/workers/vod.worker.ts`:
  - [ ] Download HLS manifest parsing
  - [ ] Segment download with retry logic
  - [ ] FFmpeg concatenation/transcoding
  - [ ] Progress tracking via BullMQ

### YouTube Upload Worker
- [ ] Create `src/jobs/youtube.job.ts`
- [ ] Create `src/workers/youtube.worker.ts`:
  - [ ] Upload video file to YouTube Data API
  - [ ] Set visibility (private/unlisted/public)
  - [ ] Add chapters from games data
  - [ ] Store YouTube video ID in DB

### Twitch Polling Producer
- [ ] Create polling service that:
  - [ ] Checks each streamer's channel on interval (30s)
  - [ ] Detects new VODs via Twitch API
  - [ ] Enqueues `vod:download` job with streamerId + vodId

### Kick Integration Rewrite
- [ ] Create `src/services/kick.ts`:
  - [ ] Implement REST API calls for VOD metadata (if available)
  - [ ] Implement WebSocket connection for live chat capture
  - [ ] Fallback to Puppeteer only when necessary
- [ ] Create `src/workers/kick.worker.ts`:
  - [ ] Single shared Puppeteer browser instance
  - [ ] Memory limit enforcement
  - [ ] Health check endpoint integration
- [ ] Configure Kick queue with conservative limits:
  - [ ] attempts: 3
  - [ ] exponential backoff starting at 5s
  - [ ] timeout: 300000ms (5 min hard limit)

### Error Handling
- [ ] Add global error handler for all workers
- [ ] Implement structured logging with streamerId context
- [ ] Add failed job retry configuration per job type

---

## Phase 4 — Data Migration

### Schema Audit
- [ ] Document current FeathersJS/Sequelize models:
  - [ ] vods.model.js fields and types
  - [ ] logs.model.js fields and types
  - [ ] emotes.model.js fields and types
  - [ ] games.model.js fields and types
- [ ] Compare with new Prisma schema
- [ ] Document all differences and transformations needed

### Migration Script
- [ ] Create `scripts/migrate-streamer.ts`:
  - [ ] Accept `--streamer` argument
  - [ ] Connect to old PostgreSQL DB via Sequelize
  - [ ] Read all records from legacy tables
  - [ ] Transform data types (e.g., TEXT → FLOAT for offsets)
  - [ ] Write to new Prisma schema on same DB
  - [ ] Log row counts before/after for verification

### Migration Execution
- [ ] Create backup copy of streamer1 database
- [ ] Run migration against backup first
- [ ] Verify row counts match
- [ ] Spot-check random records for data integrity
- [ ] Repeat for all 5 streamers (on backups)
- [ ] Run migrations on live databases one at a time
- [ ] Rename old tables to `_legacy_*` prefix after verification

---

## Phase 5 — Consolidation & Cutover

### Pre-Deployment
- [ ] Run `scripts/auth-youtube.ts` for streamer1
- [ ] Run `scripts/auth-youtube.ts` for streamer2
- [ ] Run `scripts/auth-youtube.ts` for streamer3
- [ ] Run `scripts/auth-youtube.ts` for streamer4
- [ ] Run `scripts/auth-youtube.ts` for streamer5

### Staging Tests
- [ ] Deploy to staging environment
- [ ] Load all 5 streamer configs simultaneously
- [ ] Verify each streamer can only access their own DB
- [ ] Trigger test VOD download for each streamer
- [ ] Verify YouTube uploads use correct credentials per streamer

### Load Testing
- [ ] Simulate 3 concurrent VOD downloads
- [ ] Monitor memory usage of worker process
- [ ] Verify PM2 `max_memory_restart` triggers correctly (test with artificial leak)
- [ ] Check Redis queue handles concurrent jobs properly

### Production Deployment
- [ ] Finalize `ecosystem.config.js` with tuned `max_memory_restart` value
- [ ] Stop old FeathersJS instances gracefully (allow active downloads to complete)
- [ ] Deploy new Fastify instance (API + worker processes)
- [ ] Verify `/health` endpoint returns ok for all streamers

### Monitoring Setup
- [ ] Configure uptime monitor (e.g., UptimeRobot, Pingdom):
  - [ ] Endpoint: `GET /health`
  - [ ] Header: `X-Health-Token: <token>`
  - [ ] Alert on non-200 responses
  - [ ] Alert on status != "ok"

### Verification Period
- [ ] Monitor for at least 1 complete stream cycle per streamer
- [ ] Verify all VODs are downloaded and uploaded correctly
- [ ] Check chat replay functionality
- [ ] Review logs for any errors or warnings

### Cleanup
- [ ] Decommission 5 old PM2 FeathersJS processes
- [ ] Remove old instance configuration files
- [ ] Update any external documentation pointing to old endpoints
- [ ] Fast-track merge `fastify-rewrite` into `main` branch

---

## Notes

- Phases 2 & 3 can be developed in parallel using mocked dependencies
- All credentials live in `.gitignore`'d streamer config files, not in `.env`
- Health endpoint requires `X-Health-Token` header for authentication
- Total estimated tasks: ~113 individual checkboxes

---

## Progress Summary

| Phase | Tasks | Completed |
|-------|-------|-----------|
| Phase 0 | 6 | 0/6 (BLOCKED) |
| Phase 1 | 22 | 0/22 |
| Phase 2 | 17 | 0/17 |
| Phase 3 | 35 | 0/35 |
| Phase 4 | 12 | 0/12 |
| Phase 5 | 21 | 0/21 |
| **Total** | **113** | **0/113** |

Update this table as you complete phases.
