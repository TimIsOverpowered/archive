# Archive

Automated VOD upload from Twitch/Kick to YouTube after streaming.

## Prerequisites

- Node.js 24+
- PostgreSQL 14+
- Redis 6+
- PgBouncer
- FlareSolverr (for Kick)
- TimescaleDB

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

## TimescaleDB Setup

TimescaleDB is used as the hypertable engine for the `chat_messages` table, providing time-based partitioning and automatic compression for chat log data.

### Prerequisites

- PostgreSQL 14+ with the TimescaleDB extension installed
- The extension is created automatically by the migration scripts

### Installation

**Ubuntu/Debian:**

```bash
sudo apt install postgresql-timescaledb
sudo systemctl restart postgresql
```

**Docker:**

```bash
docker run -d \
  --name=timescaledb \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=yourpassword \
  -v /path/to/data:/var/lib/postgresql/data \
  --restart unless-stopped \
  timescaledb/timescaledb:latest-pg16
```

### How It Works

The `chat_messages` table is converted to a hypertable with the following configuration:

| Setting              | Value                        | Purpose                                                |
| -------------------- | ---------------------------- | ------------------------------------------------------ |
| Partition column     | `created_at`                 | Chunks created by time intervals                       |
| Chunk interval       | 7 days                       | Each chunk covers a 7-day window                       |
| Compression          | Enabled                      | Reduces storage for older chat data                    |
| Compression segment  | `vod_id`                     | Keeps messages from the same VOD together              |
| Compression order    | `content_offset_seconds ASC` | Optimizes for sequential replay queries                |
| Auto-compress policy | 30 days                      | Chunks older than 30 days are compressed automatically |

### Composite Primary Key

The `chat_messages` table uses a composite primary key on `(id, created_at)`. This is a TimescaleDB requirement: any unique index on a hypertable must include the partitioning column. Without it, TimescaleDB would need to scan every chunk globally to enforce uniqueness, destroying write performance. Including `created_at` guarantees uniqueness checks are confined to the active chunk.

### Verification

Check that the hypertable is set up correctly:

```sql
SELECT hypertable_name, num_chunks, compression_enabled FROM timescaledb_information.hypertables;

SELECT * FROM timescaledb_information.compression_settings WHERE hypertable_name = 'chat_messages';

SELECT job_id, application_name, schedule_interval, max_runtime, scheduled FROM timescaledb_information.jobs;
```

### Maintenance

**Monitor chunk status:**

```sql
SELECT chunk_name, range_start, range_end, is_compressed FROM timescaledb_information.chunks
WHERE hypertable_name = 'chat_messages' ORDER BY range_start DESC;
```

**Manually compress a chunk:**

```sql
SELECT compress_chunk(chunk_name::regclass, if_not_compressed => true)
FROM timescaledb_information.chunks
WHERE hypertable_name = 'chat_messages' AND NOT is_compressed;
```

**Decompress a chunk (rarely needed):**

```sql
SELECT decompress_chunk(chunk_name::regclass)
FROM timescaledb_information.chunks
WHERE hypertable_name = 'chat_messages' AND is_compressed;
```

**Monitor compression ratio:**

```sql
SELECT
  ch.chunk_name,
  ch.is_compressed,
  pg_size_pretty(pg_total_relation_size(pc.oid)) AS total_size
FROM timescaledb_information.chunks ch
JOIN pg_class pc ON pc.relname = ch.chunk_name
JOIN pg_namespace ns ON ns.oid = pc.relnamespace
WHERE ch.hypertable_name = 'chat_messages'
ORDER BY ch.range_start DESC;
```

### Important Notes

- **No configuration changes needed** — TimescaleDB is transparent to the application. All queries use standard SQL and Kysely queries work identically.
- **PgBouncer compatibility** — TimescaleDB uses standard PostgreSQL protocol, so PgBouncer works without any special configuration.
- **Compression is transparent** — The application reads and writes compressed chunks automatically. Decompression happens on-the-fly during queries.
- **Chunk retention** — Chunks are never automatically dropped. If you need to delete old data, use `drop_chunks('chat_messages', older_than => INTERVAL '90 days')`.

## Environment Variables

See `.env.example` for all available configuration options. Key variables:

- `PGBOUNCER_URL`: PgBouncer connection string (required, e.g., `postgresql://archive@localhost:6432/archive`)
- `META_DATABASE_URL`: Connection string for the meta database
- `REDIS_URL`: Redis connection for caching and job queues
- `ENCRYPTION_MASTER_KEY`: 64-character hex string for encrypting sensitive data
- `JWT_SECRET`: Secret for admin dashboard authentication
- `FLARESOLVERR_BASE_URL`: FlareSolverr API endpoint (default: `http://localhost:8191`)
- `TWITCH_CLIENT_ID`: Twitch app client ID (shared across all tenants for Helix API)
- `TWITCH_CLIENT_SECRET`: Twitch app client secret (shared across all tenants for Helix API)
- `TMP_PATH`: Local SSD/NVMe path for intermediate file operations (optional, enables storage optimization)
- `VOD_PATH`: Final VOD storage path
- `LIVE_PATH`: Final Live storage path for twitch-recorder-go

## Troubleshooting

### "Cannot resolve environment variable" errors

Ensure `.env` exists and `NODE_ENV` is set before running scripts.

## Verifying your YouTube channel

To upload 15+ minute videos, verify your YouTube channel: https://www.youtube.com/verify

## Google Console API Verification

To make videos public automatically, you need to complete Google's API audit. See: https://developers.google.com/youtube/v3/docs/videos/insert
