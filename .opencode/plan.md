# Archive Rewrite Plan

## Overview

Rewrite the `archive` backend from FeathersJS into a modern, multi-tenant Node.js service that manages VOD archiving and YouTube uploads for multiple streamers — from a single deployment.

---

## Development Branch

This rewrite is being developed on branch: `fastify-rewrite`

- Main branch continues running the current FeathersJS instances
- No changes to main until Phase 5 cutover is verified
- Fast-track merge into main after successful deployment

---

## Goals

- Replace FeathersJS with a leaner, more maintainable stack
- Consolidate 5 separate running instances into one deployment
- Keep per-streamer data and credentials fully isolated
- Separate API and worker processes within one codebase
- Make adding new streamers a config-only change
- Retain Kick.com support with improved reliability

---

## Stack

| Layer           | Choice                                | Reason                                                        |
| --------------- | ------------------------------------- | ------------------------------------------------------------- |
| Language        | TypeScript                            | Type safety, better DX, easier to maintain                    |
| Framework       | Fastify                               | Fast, low overhead, great plugin ecosystem                    |
| ORM             | Prisma                                | Type-safe queries, easy migrations per-streamer DB            |
| Job Queue       | BullMQ                                | Redis-backed, retries, concurrency control, progress tracking |
| Database        | PostgreSQL (per streamer)             | Stays isolated, same as current                               |
| Auth            | Confidential client (Twitch + Google) | Server-side only, no public OAuth routes                      |
| Process Manager | PM2                                   | Two processes: API + worker                                   |

---

## Project Structure

```
archive/
├── src/
│   ├── api/                  # Fastify HTTP server
│   │   ├── routes/
│   │   │   ├── vods.ts
│   │   │   └── chat.ts
│   │   ├── middleware/
│   │   │   └── auth.ts
│   │   └── server.ts
│   │
│   ├── workers/              # BullMQ worker process
│   │   ├── index.ts          # Worker entry point, loads all streamers
│   │   ├── vod.worker.ts     # Processes VOD download jobs
│   │   ├── youtube.worker.ts # Processes YouTube upload jobs
│   │   └── kick.worker.ts    # Processes Kick VOD jobs
│   │
│   ├── jobs/                 # Job definitions and producers
│   │   ├── vod.job.ts
│   │   ├── youtube.job.ts
│   │   └── kick.job.ts
│   │
│   ├── services/             # Shared business logic
│   │   ├── twitch.ts         # Twitch API + VOD polling + token management
│   │   ├── youtube.ts        # YouTube upload logic + token refresh
│   │   ├── kick.ts           # Kick integration (see Kick section below)
│   │   ├── vod.ts            # VOD processing (download, transcode)
│   │   └── chat.ts           # Chat replay logic
│   │
│   ├── db/                   # Database layer
│   │   ├── client.ts         # Per-streamer Prisma client factory
│   │   └── schema.prisma     # Shared schema (applied per-streamer DB)
│   │
│   └── config/
│       ├── loader.ts         # Reads and validates all streamer configs
│       └── types.ts          # StreamerConfig type definition
│
├── scripts/
│   └── auth-youtube.ts       # One-time CLI script to generate + store OAuth tokens
│
├── config/
│   └── streamers/
│       ├── streamer1.json    # Per-streamer credentials + DB connection
│       ├── streamer2.json
│       └── ...
│
├── .env.example              # Template for all required environment variables
├── package.json
├── tsconfig.json
└── ecosystem.config.js       # PM2: runs api + worker as separate processes
```

---

## Streamer Config Schema

Each streamer gets one JSON file. No shared credentials, no crossed data.

```json
{
  "id": "streamer1",
  "twitch": {
    "clientId": "...",
    "clientSecret": "...",
    "channelName": "..."
  },
  "youtube": {
    "clientId": "...",
    "clientSecret": "...",
    "refreshToken": "..."
  },
  "kick": {
    "enabled": false,
    "channelName": "..."
  },
  "database": {
    "url": "postgresql://user:pass@localhost:5432/streamer1_db",
    "connectionLimit": 5
  }
}
```

---

## Authentication Design

Neither Twitch nor YouTube have public-facing OAuth routes in the API. Both are handled entirely server-side since this is a confidential client operated by a single admin.

### Twitch

Uses the **client credentials grant** — no user interaction or callback URL required. On startup, `services/twitch.ts` checks Redis for a cached app access token. If none exists or it has expired, it fetches a fresh one from Twitch and stores it in Redis with a TTL matching the token's expiry. This survives process restarts without hitting Twitch's token endpoint unnecessarily.

```
Startup (per streamer)
  └── GET twitch:token:{streamerId} from Redis
        ├── Cache hit → use token
        └── Cache miss → POST https://id.twitch.tv/oauth2/token
                          (grant_type=client_credentials)
                       → store in Redis with TTL
                       → use token

Runtime
  └── On 401 → invalidate Redis key → re-fetch token
```

No `/auth/twitch` route exists in the API.

### YouTube

Uses the **authorization code grant**, but the callback is handled by a one-time local CLI script — not a public API route. You run this once per streamer during initial setup (or whenever a refresh token needs to be regenerated). The resulting refresh token is written into the streamer's config file and used by the app indefinitely.

```
Setup (one-time, per streamer):
  node scripts/auth-youtube.ts --streamer streamer1
    → opens browser → you complete Google OAuth
    → script spins up localhost:9999/callback to catch the code
    → exchanges code for access + refresh token
    → writes refreshToken into config/streamers/streamer1.json

Runtime:
  services/youtube.ts reads refreshToken from config
    → exchanges for access token on demand
    → retries automatically on expiry
```

> **Security note:** `scripts/auth-youtube.ts` writes directly to the streamer config file. Never commit config files — ensure `config/streamers/` is in `.gitignore` before running the script.

No `/auth/youtube` route exists in the API. This replaces the manual Google Playground workflow — you never need to hand-generate tokens again.

---

## Per-Streamer Prisma Client

One Prisma client per streamer with an explicit connection pool cap. Simple to reason about, safe at current scale, and bounded so a busy streamer can't exhaust DB connections.

```typescript
// src/db/client.ts
import { PrismaClient } from '@prisma/client';
import { StreamerConfig } from '../config/types';

const clients = new Map<string, PrismaClient>();

export function getClient(streamer: StreamerConfig): PrismaClient {
  if (!clients.has(streamer.id)) {
    clients.set(
      streamer.id,
      new PrismaClient({
        datasourceUrl: `${streamer.database.url}?connection_limit=${streamer.database.connectionLimit ?? 5}`,
      })
    );
  }
  return clients.get(streamer.id)!;
}
```

> If the streamer count grows significantly (20+), revisit switching to connection pool per streamer or single client with tenant discrimination.

---

## Redis Startup Behaviour

Redis is a hard dependency — if it is unavailable, BullMQ cannot function. On startup, both the API and worker processes attempt to connect to Redis with exponential backoff before giving up. This handles the common case where Redis and the app start simultaneously on boot and Redis isn't ready yet.

```
Startup Redis check
  └── Attempt connection
        ├── Success → proceed normally
        └── Failure → wait 2s, retry
                    → wait 4s, retry
                    → wait 8s, retry
                    → wait 16s, retry
                    → wait 32s, retry
                    → log fatal error + exit(1)
```

Total wait before exit: ~62 seconds — enough for Redis to come up on a slow boot without hanging indefinitely.

---

## Multi-Tenant Architecture

- On startup, `config/loader.ts` reads all files in `config/streamers/`
- A Prisma client is instantiated per streamer using their individual DB URL
- BullMQ worker pool is shared — jobs are namespaced by `streamerId`
- Every job carries `{ streamerId }` so the worker resolves the correct DB client and credentials
- Databases remain fully separate — no cross-streamer queries, no shared tables

```
Startup
  └── Connect to Redis (with backoff)
  └── Load streamer configs (N streamers)
        ├── Instantiate Prisma client (pool capped) → streamer DB
        ├── Fetch/cache Twitch app access token in Redis
        └── Register BullMQ worker → streamer queue

Twitch/Kick Poll (per streamer, on interval)
  └── VOD detected → enqueue vod:download job { streamerId, vodId, platform }

Worker picks up job
  └── Resolve streamer config by streamerId
        ├── Download VOD
        ├── Process/transcode
        ├── Upload to YouTube (exchange refreshToken → access token)
        └── Write metadata to streamer's DB

API request
  └── Resolve streamer from route param
        └── Query streamer's Prisma client
```

---

## Process Separation

Two processes share the codebase but run independently, with the worker process guarded by a memory ceiling to catch leaks early:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'archive-api',
      script: 'dist/api/server.js',
    },
    {
      name: 'archive-worker',
      script: 'dist/workers/index.js',
      max_memory_restart: '1G', // restart worker if it exceeds 1GB (tune per server)
    },
  ],
};
```

- API crashing does not stop active downloads
- Workers can be restarted independently (e.g. after ffmpeg changes)
- `max_memory_restart` catches Puppeteer or ffmpeg memory leaks before they affect the whole server

---

## Health Endpoint

`GET /health` is protected by a secret token passed as a request header. This allows uptime monitors to authenticate without exposing queue internals or Puppeteer state publicly.

```
GET /health
Headers:
  X-Health-Token: <HEALTH_TOKEN from .env>
```

Returns `401` if the header is missing or incorrect.

```json
{
  "status": "ok",
  "redis": "ok",
  "streamers": [
    {
      "id": "streamer1",
      "db": "ok",
      "queue": { "waiting": 0, "active": 1, "failed": 0 }
    }
  ],
  "kick": {
    "puppeteer": "ok",
    "instanceMemoryMb": 142
  }
}
```

- `redis` — BullMQ connectivity
- `db` per streamer — Prisma `$queryRaw SELECT 1` probe
- `queue` per streamer — BullMQ job counts (surfacing stuck or failed jobs)
- `kick.puppeteer` — shared Puppeteer instance health and current memory footprint

Overall `status` is `"degraded"` if any non-critical check fails, `"error"` if Redis or all DBs are down.

Uptime monitors should be configured to send the `X-Health-Token` header and alert on any non-`200` response or a `status` field that is not `"ok"`.

---

## Kick.com Integration

Kick is kept but rewritten with reliability as the priority. The current Puppeteer-based approach is fragile and memory-intensive — replaced with a direct API/WebSocket approach where possible, with Puppeteer as a constrained fallback only.

**Concerns with current implementation:**

- Puppeteer spawns a full Chromium instance per operation — high memory, slow startup
- Browser-based scraping breaks on any Kick frontend change
- No retry or crash recovery if the browser hangs

**Rewrite approach:**

- Use Kick's undocumented REST API endpoints directly where available (VOD metadata, chat logs)
- Use Kick's WebSocket for live chat capture instead of browser scraping
- If Puppeteer is unavoidable, run it as a single shared instance — not spawned per-job
- Expose Puppeteer instance health and memory via `/health`
- Wrap all Kick jobs in aggressive retry logic and timeouts via BullMQ job options

```typescript
// Kick jobs get conservative resource limits
const kickQueue = new Queue('kick', {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    timeout: 300000, // 5 min hard limit per job
  },
});
```

---

## API Endpoints

```
GET  /vods/:streamerId              List VODs for a streamer
GET  /vods/:streamerId/:vodId       Get VOD metadata
GET  /vods/:streamerId/:vodId/chat  Get chat replay
GET  /health                        Health check — requires X-Health-Token header
```

No OAuth callback routes. All authentication is handled internally or via the one-time CLI setup script.

---

## Migration Plan

### Phase 0 — Security (do this before anything else)

The existing `config/default.json` contains exposed credentials that are committed or otherwise at risk.

- [ ] Audit git history for committed secrets using `git-secrets` or `trufflehog` — if found, treat those credentials as permanently compromised regardless of rotation
- [ ] Rotate all Twitch client secrets across all 5 instances
- [ ] Rotate all YouTube/Google OAuth credentials across all 5 instances
- [ ] Rotate any database passwords that may have been exposed
- [ ] Move all credentials out of `config/default.json` into environment variables (dotenv + `.gitignore`)
- [ ] Add `config/`, `.env`, and any secret files to `.gitignore` on all 5 instances immediately

> Do not proceed to Phase 1 until all credentials are rotated and secured.

---

### Phase 1 — Foundation

- [ ] Set up TypeScript + Fastify project skeleton
- [ ] Create `.env.example` documenting all required environment variables with placeholder values and comments
- [ ] Implement Redis connection with exponential backoff on startup
- [ ] Implement streamer config loader with validation
- [ ] Implement per-streamer Prisma client factory with connection cap
- [ ] Define shared Prisma schema (vods, logs, chat)

**.env.example** should cover at minimum:

```bash
# Server
PORT=3000
NODE_ENV=development

# Redis (BullMQ + Twitch token cache)
REDIS_URL=redis://localhost:6379

# Streamer configs directory
STREAMERS_CONFIG_DIR=./config/streamers

# Health endpoint
HEALTH_TOKEN=replace-with-a-long-random-secret

# Kick (optional — only if any streamer has kick.enabled = true)
KICK_PUPPETEER_MEMORY_LIMIT_MB=512
```

Per-streamer secrets (Twitch, YouTube, DB) live in each streamer's JSON config, which is `.gitignore`'d — not in `.env`.

---

### Phases 2 & 3 — API and Worker (run in parallel)

These can be developed simultaneously. Use mocked job producers in Phase 2 tests and mocked API calls in Phase 3 tests until integration is ready.

**Phase 2 — API**

- [ ] Port vods routes
- [ ] Port chat replay routes
- [ ] Implement `/health` endpoint with `X-Health-Token` auth (Redis, per-streamer DB, queue counts, Kick Puppeteer)

**Phase 3 — Worker**

- [ ] Set up BullMQ queues and worker pool
- [ ] Implement Twitch client credentials token fetch with Redis caching + auto-refresh on 401
- [ ] Implement YouTube refresh token exchange + auto-refresh in `services/youtube.ts`
- [ ] Write `scripts/auth-youtube.ts` one-time CLI setup script
- [ ] Port Twitch VOD polling → job producer
- [ ] Port VOD download + transcode logic → worker
- [ ] Port YouTube upload logic → worker
- [ ] Rewrite Kick integration (REST/WS first, Puppeteer as fallback)
- [ ] Add per-job error handling and retry config

---

### Phase 4 — Data Migration

Before cutting over, existing data from all 5 running databases needs to be preserved.

- [ ] Audit schema differences between current FeathersJS models and new Prisma schema
- [ ] Write a migration script per streamer (`scripts/migrate-streamer.ts`) that:
  - Connects to the old DB
  - Reads existing vods, logs, and chat tables
  - Transforms any schema differences
  - Writes into the new schema on the same DB
- [ ] Run migrations against a copy of each DB first — never against live data directly
- [ ] Verify row counts and spot-check data integrity after each migration
- [ ] Keep old tables under a `_legacy_` prefix until the rewrite is confirmed stable

---

### Phase 5 — Consolidation & Cutover

- [ ] Run `scripts/auth-youtube.ts` for all 5 streamers to generate fresh refresh tokens
- [ ] Test all 5 streamer configs simultaneously in staging
- [ ] Verify DB isolation (no cross-streamer data leakage)
- [ ] Load test concurrent VOD downloads (simulate 3+ streamers live at once)
- [ ] Set up PM2 ecosystem config with `max_memory_restart` tuned to the server's available RAM
- [ ] Deploy new single instance
- [ ] Configure uptime monitor to hit `GET /health` with `X-Health-Token` header — alert on non-`200` or non-`ok` status
- [ ] Monitor for 1-2 stream cycles per streamer before decommissioning old instances
- [ ] Decommission 5 old PM2 processes

---

## Adding a New Streamer

1. Create `config/streamers/streamerN.json` with Twitch + YouTube client credentials and DB URL
2. Create a new PostgreSQL database
3. Run `prisma migrate deploy` targeting the new DB
4. Run `node scripts/auth-youtube.ts --streamer streamerN` to generate and store the refresh token
5. Restart the worker process (`pm2 restart archive-worker`)

No code changes required.

---

## Task Tracking

Individual tasks are tracked in `.opencode/TASKS.md` on the `fastify-rewrite` branch. This document remains as high-level planning and architecture reference.

To mark tasks complete, update checkboxes in `.opencode/TASKS.md`:
- `[ ]` = pending
- `[x]` = completed

---

## Key Improvements Over Current Setup

|                          | Current (5 instances)                   | Rewrite                                         |
| ------------------------ | --------------------------------------- | ----------------------------------------------- |
| Deployment               | Deploy 5 times per change               | Deploy once                                     |
| Config management        | 5 separate configs, no shared structure | Typed, validated, co-located                    |
| Resource usage           | 5 API servers + 5 pollers running       | 1 API server + 1 worker pool                    |
| Adding a streamer        | Clone repo, set up new instance         | Add config + run auth script                    |
| Error visibility         | 5 separate log streams                  | Unified logs, tagged by streamerId              |
| Kick reliability         | Puppeteer per-job, no limits            | Single instance, WS-first, memory-capped        |
| Memory safety            | No guardrails                           | PM2 `max_memory_restart` on worker              |
| Observability            | None                                    | Protected `/health` + uptime checks             |
| Twitch token management  | In-memory only, lost on restart         | Cached in Redis with TTL                        |
| YouTube token management | Manual Google Playground regeneration   | One-time CLI script, auto-refresh               |
| Twitch auth              | Callback route                          | Client credentials, no route needed             |
| Redis resilience         | N/A                                     | Backoff retry on startup, clean exit after ~62s |
| Credentials              | Exposed in config files                 | Rotated, env-based, out of version control      |
| Framework                | FeathersJS (declining ecosystem)        | Fastify (actively maintained)                   |
