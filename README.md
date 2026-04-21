# Archives

Automated VOD upload from Twitch to YouTube after streaming.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Redis 6+
- PgBouncer (required — connection pooler on port 6432)
- FlareSolverr (for Kick stream detection and VOD fetching)

## Database Setup

This project uses two databases:

### Meta Database (Tenant Management)

Stores tenant configurations and admin users.

```bash
# Create the database
createdb archive
```

The `tenants` and `admins` tables must be created manually before use.

### Streamer Database (Per-Tenant)

Each tenant has its own database for VODs, chat logs, emotes, etc. The database URL is stored in the tenant's record in the meta database.

Migrations are applied automatically when creating a new tenant via the create-tenant script. For migrating legacy databases, use:

```bash
NODE_ENV=development npx tsx scripts/migrate-streamer.ts
```

## Getting Started

1. Install dependencies

   ```bash
   cd path/to/archive
   npm install
   ```

2. Set up environment variables

   ```bash
   cp .env.example .env.development
   # Edit .env.development with your configuration
   ```

3. Create a tenant

   ```bash
   NODE_ENV=development npx tsx scripts/create-tenant.ts
   ```

4. Start the application

   ```bash
   NODE_ENV=development npm run dev
   ```

## FlareSolverr Setup

FlareSolverr is required for Kick stream detection and VOD fetching. Run it as a Docker container:

```bash
docker run -d \
  --name=flaresolverr \
  -p 8191:8191 \
  -e LOG_LEVEL=info \
  --restart unless-stopped \
  ghcr.io/flaresolverr/flaresolverr:latest
```

Or install standalone:

```bash
# Linux
sudo apt install -y chromium-browser xvfb
pip install flaresolverr
flaresolverr --port 8191

# Windows
# Download from https://github.com/FlareSolverr/FlareSolverr/releases
# Run: flaresolverr.exe --port 8191
```

Verify it's running:

```bash
curl -X POST 'http://localhost:8191/v1' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"status"}'
```

## PgBouncer Setup

PgBouncer is required as the connection pooler between the application and PostgreSQL. It listens on `127.0.0.1:6432` in `transaction` pool mode.

**Installation:**

```bash
# Debian/Ubuntu
sudo apt install pgbouncer

# Docker
docker run -d \
  --name=pgbouncer \
  -p 6432:6432 \
  -v /path/to/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini \
  -v /path/to/userlist.txt:/etc/pgbouncer/userlist.txt \
  --restart unless-stopped \
  postgres
```

**Configuration:**

- `pgbouncer.ini` — see `pgbouncer.ini` in repo root for a reference config
- `userlist.txt` — PgBouncer auth file (format: `"username"="md5hash"` or `"username"="password"` depending on `auth_type`)
- `listen_addr = 127.0.0.1` — never expose PgBouncer externally
- `pool_mode = transaction` — connections released after each transaction
- Wildcard `* = host=<PG_HOST> port=5432` in `[databases]` for dynamic tenant DBs

Set `PGBOUNCER_URL` in your environment variables (e.g., `postgresql://archive@localhost:6432/archive`).

## Environment Variables

See `.env.example` for all available configuration options. Key variables:

- `PGBOUNCER_URL`: PgBouncer connection string (required, e.g., `postgresql://archive@localhost:6432/archive`)
- `META_DATABASE_URL`: Connection string for the meta database
- `REDIS_URL`: Redis connection for caching and job queues
- `ENCRYPTION_MASTER_KEY`: 64-character hex string for encrypting sensitive data
- `JWT_SECRET`: Secret for admin dashboard authentication
- `FLARESOLVERR_BASE_URL`: FlareSolverr API endpoint (default: `http://localhost:8191`)

## Troubleshooting

### "Cannot resolve environment variable" errors

Ensure `.env` or `.env.development` exists and `NODE_ENV` is set before running scripts.

## Verifying your YouTube channel

To upload 15+ minute videos, verify your YouTube channel: https://www.youtube.com/verify

## Google Console API Verification

To make videos public automatically, you need to complete Google's API audit. See: https://developers.google.com/youtube/v3/docs/videos/insert
