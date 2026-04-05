# Archive Management Scripts

All scripts use `tsx` for TypeScript execution. Run with: `npx tsx scripts/<script-name>.ts`

## Prerequisites

Ensure environment variables are loaded from `.env`:

- `META_DATABASE_URL` - Connection string for the meta database
- `ENCRYPTION_MASTER_KEY` - 64-character hex string for AES-256-GCM encryption

---

## Tenant Management

### create-tenant.ts

Interactive wizard to create a new streamer tenant from scratch.

**Usage:**

```bash
npx tsx scripts/create-tenant.ts
# or use npm script:
npm run tenant:create
```

**Channel Name Validation:**

The script validates the channel name (which becomes the tenant ID):

- **Format**: Lowercase alphanumeric + underscore only (`^[a-z0-9_]+$`)
- **Length**: Maximum 25 characters
- **Uniqueness**: Checks for existing tenant before creation (exits immediately if duplicate)

**What it does:**

1. Validates channel name format, length, and uniqueness
2. Prompts for display name (defaults to channel name if empty)
3. Validates PostgreSQL connection before starting prompts
4. Attempts to create the PostgreSQL database (or asks you to create manually)
5. Runs Prisma migrations to set up the normalized schema
6. Collects streaming platform metadata only (Twitch, Kick user IDs/usernames - **no OAuth credentials**)
7. Collects YouTube upload behavior settings (**no API key or OAuth tokens**)
8. Collects general archive settings (paths, timezone, download preferences)
9. Shows a summary and requires confirmation before proceeding
10. Registers tenant in meta database without encrypted credentials

**Note:** After creating the tenant, use `npm run auth:twitch` or `npm run auth:youtube` to configure OAuth authentication separately.

**Prerequisites:**

- `ENCRYPTION_MASTER_KEY` set in `.env` (64 hex characters)
- `META_DATABASE_URL` set in `.env`
- PostgreSQL server accessible (for creating new databases)

**Example session:**

```bash
$ npx tsx scripts/create-tenant.ts

╔════════════════════════════════════════════╗
║     CREATE TENANT - Interactive Wizard     ║
╚════════════════════════════════════════════╝

──────────────────────────────────────────
BASIC INFORMATION
──────────────────────────────────────────
Channel Name (tenant ID, lowercase alphanumeric + underscore, max 25 chars): moonmoon
Display Name (or press Enter to use channel name): MOONMOON

──────────────────────────────────────────
POSTGRESQL SERVER
──────────────────────────────────────────
PostgreSQL host:  <your-host>
PostgreSQL port: 5432
PostgreSQL username: archive
PostgreSQL password: ********

🔍 Validating PostgreSQL connection...
✓ Connection validated

──────────────────────────────────────────
DATABASE SETUP
──────────────────────────────────────────
✓ Created database 'moonmoon'

📦 Running Prisma migrations...
✓ Migrations completed successfully

──────────────────────────────────────────
STREAMING PLATFORMS (Metadata Only)
──────────────────────────────────────────
Enable Twitch? (y/N): y

Twitch Stream Info:
User ID (numeric, optional): 121059319
Username (optional): moonmoon

Note: OAuth credentials are NOT collected here.
     Run "npm run auth:twitch" after tenant creation to configure authentication.

Enable Kick? (y/N): n

... [YouTube upload behavior settings] ...

==================================================
TENANT CREATION SUMMARY
==================================================
Streamer ID: moonmoon
Display Name: MOONMOON
Database:   postgresql://<user>:***@<host>:5432/<db>

Streaming Platforms:
   ✓ Twitch (metadata only - user_id, username)
   ✗ Kick disabled

YouTube Uploads:
  ✓ Enabled
    - VOD upload: yes
    - Per-game upload: no
    - Multi-track: yes
    - Split duration: 10800s

Settings:
   Domain: <your-domain>
   VOD Path: /mnt/storage/vods
   Timezone: America/New_York
  Chat Download: yes
  VOD Download: yes
  Save HLS: no
  Save MP4: yes

Proceed with tenant creation? (y/N): y

✅ TENANT CREATED SUCCESSFULLY!

Channel Name: moonmoon
Tenant ID in meta DB: moonmoon

🗄️  Database: postgresql://<user>:***@<host>:5432/<db>
   Schema: Migrated with normalized tables

Optional Authentication Setup:
────────────────────────────────
To configure OAuth authentication for this tenant, run:

  • Twitch Auth: npm run auth:twitch (then enter tenant ID "moonmoon")
  • YouTube Auth: npm run auth:youtube (then enter tenant ID "moonmoon")

These scripts will guide you through the OAuth flow and securely store credentials.
```

**Generated files:**

- `config/config.json.<channel_name>` - Non-sensitive configuration (metadata and upload settings only, no credentials)
- `config/default.json.<channel_name>` - Server defaults with database connection string

**Encrypted fields in meta DB:**

After running auth scripts separately:

- `twitch.auth` (client_id, client_secret) - configured via `npm run auth:twitch`
- `youtube.auth` (access_token, refresh_token) - configured via `npm run auth:youtube`
- `database_url`

**Note:** This script is for interactive tenant creation. For bulk imports from existing config files, use `import-tenant.ts`. OAuth credentials must be added separately using the dedicated authentication scripts after tenant creation.

---

### import-tenant.ts

Import a streamer's configuration from JSON file into the meta database.

**Usage:**

```bash
npx tsx scripts/import-tenant.ts <channel_name> "postgresql://<user>:***@<host>:5432/<db>"
```

**Example:**

```bash
npx tsx scripts/import-tenant.ts moonmoon "postgresql://<user>:***@<host>:5432/<db>"
```

**Channel Name Validation:**

- **Format**: Lowercase alphanumeric + underscore only (`^[a-z0-9_]+$`)
- **Length**: Maximum 25 characters
- **Uniqueness**: Must not already exist in the database (exits immediately if duplicate)

**What it does:**

1. Validates channel name format and length
2. Checks for existing tenant (exits with error if found)
3. Reads `config/config.json.<channel_name>`
4. Encrypts sensitive fields:
   - `twitch.auth` (client_secret, access_token)
   - `youtube.auth` (refresh_token, access_token)
   - `youtube.api_key`
   - `database_url`
5. Inserts into `tenants` table with explicit `id` set to channel name

**Requirements:**

- Config file must exist at `config/config.json.<channel_name>`
- Database URL must be provided as second argument
- The PostgreSQL database must already exist

---

## OAuth Authentication

### auth-twitch.ts

Interactive script to configure Twitch OAuth credentials for an existing tenant.

**Usage:**

```bash
npx tsx scripts/auth-twitch.ts
# or use npm script:
npm run auth:twitch
```

**What it does:**

1. Prompts for tenant/streamer ID
2. Validates tenant exists in meta database
3. Prompts for Twitch Client ID
4. Prompts for Twitch Client Secret (hidden input)
5. Generates access token via Twitch OAuth client credentials flow
6. Encrypts credentials with AES-256-GCM
7. Stores encrypted auth object in tenant's `twitch.auth` field
8. Enables Twitch for the tenant

**Example session:**

```bash
$ npm run auth:twitch

╔════════════════════════════╗
║  TWITCH AUTH CONFIGURATOR  ║
╚════════════════════════════╝

────────────────────────────────────────
TENANT SELECTION
────────────────────────────────────────

Tenant/Streamer ID: moonmoon

✓ Tenant found!

Current Twitch Status: Disabled (no credentials configured)

────────────────────────────────────────
CREDENTIALS INPUT
────────────────────────────────────────

Client ID: abc123def456
Client Secret: ********************

🔄 Generating access token via Twitch OAuth client credentials flow...
✓ Access token generated successfully!

Encrypting credentials with AES-256-GCM...
Storing in meta database for tenant "moonmoon"...

╔══════════════╗
║ ✓ SUCCESSFUL ║
╚══════════════╝

Tenant ID: moonmoon

Auth Object Generated & Stored:
  • Client ID: abc123de...
  • Access Token: 9a8b7c6d5e4f3g2h1i...

Credentials encrypted with AES-256-GCM and stored in meta database.

Note: Access token expires after ~6 hours but can be refreshed
      automatically using the stored client_id + client_secret.
```

**Prerequisites:**

- Tenant must already exist in meta database
- `ENCRYPTION_MASTER_KEY` set in `.env` (64 hex characters)
- `META_DATABASE_URL` set in `.env`

---

### auth-youtube.ts

Interactive script to configure YouTube OAuth credentials for an existing tenant.

**Usage:**

```bash
# Manual paste mode (default):
npx tsx scripts/auth-youtube.ts <streamer_id>

# Auto-open browser mode:
npx tsx scripts/auth-youtube.ts <streamer_id> --open
# or use npm script:
npm run auth:youtube
```

**What it does:**

1. Validates tenant exists in meta database
2. Generates OAuth authorization URL with state token
3. **Manual mode:** Opens URL in browser, then paste callback URL or auth code
4. **Auto mode:** Opens browser automatically and starts local callback server on port 9999
5. Exchanges authorization code for access token and refresh token
6. Converts relative expiry to absolute timestamp
7. Encrypts and stores auth object in tenant's `youtube.auth` field
8. Preserves existing YouTube configuration settings

**Manual Mode Example:**

```bash
$ npx tsx scripts/auth-youtube.ts moonmoon

=== YouTube OAuth Authentication ===

Tenant ID: moonmoon

Step 1 - Open URL on any device with browser access:
───────────────────────────────

https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=http://localhost:9999/callback&response_type=code&scope=...&state=abc123...

Step 2 - Get the callback URL or authorization code after authorizing:
───────────────────────────────

After authorizing, Google will redirect to a page like:

http://localhost:9999/callback?code=4/0A...&state=abc123...

Step 3 - Paste the URL here below:
───────────────────────────────

Copy and paste either:
• The full callback URL from your browser's address bar, OR
• Just the authorization code (the value after "code=" in the URL)

> http://localhost:9999/callback?code=4/0AXXX...&state=abc123...

=== Raw Token Response from Google ===
access_token present: true (1234 chars)
refresh_token present: true
expires_in: 3599
scope: https://www.googleapis.com/auth/youtube.force-ssl ...

=== Authentication Successful ===

Stream ID: moonmoon
Token received. Storing encrypted authentication object in database...

Using encryption for auth object storage.
Preserving existing YouTube configuration...

=== Auth Object Stored Successfully ===
```

**Auto Mode Example:**

```bash
$ npx tsx scripts/auth-youtube.ts moonmoon --open

=== YouTube OAuth Authentication ===

Mode: Browser
Tenant ID: moonmoon

Callback server running at http://localhost:9999

[Browser automatically opens to OAuth URL]

[After authorization, browser shows success page]

✓ Callback server closed. Authentication complete.
```

**Options:**

- `--open` - Automatically open browser and start callback server (default: manual paste mode)

**Prerequisites:**

- Tenant must already exist in meta database
- `YOUTUBE_CLIENT_ID` set in `.env`
- `YOUTUBE_CLIENT_SECRET` set in `.env`
- `META_DATABASE_URL` set in `.env`

**Note:** The refresh token is critical for long-term access. It's stored encrypted and used to automatically refresh expired access tokens.

---

## Admin User Management

### create-admin.ts

Create a new admin user with an API key for authentication.

**Usage:**

```bash
npx tsx scripts/create-admin.ts <username>
```

**Example:**

```bash
npx tsx scripts/create-admin.ts admin
```

**Output:**

```
✓ Admin user created successfully!
Username: admin
API Key: archive_<64-hex-chars>

⚠️ WARNING: Save this API key now - it cannot be retrieved later!
```

**Notes:**

- API key format: `archive_<64-hex-characters>` (72 chars total, case-sensitive)
- API key is shown **once** during creation - save it securely
- Error if username already exists (exit code 1)

---

### reset-admin-key.ts

Reset the API key for an existing admin user (if forgotten or compromised).

**Usage:**

```bash
npx tsx scripts/reset-admin-key.ts <username>
```

**Example:**

```bash
npx tsx scripts/reset-admin-key.ts admin
```

**Output:**

```
✓ API key reset successfully!
Username: admin
New API Key: archive_<new-64-hex-chars>

⚠️ WARNING: Save this new API key now - the old one is revoked!
```

**Notes:**

- Old API key is immediately revoked upon reset
- New API key is shown **once** - save it securely
- Error if username does not exist (exit code 1)

---

## Troubleshooting

**"ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string"**

- Ensure `ENCRYPTION_MASTER_KEY` in `.env` is exactly 64 hex characters
- Generate with: `openssl rand -hex 32`

**"Admin user already exists"**

- Use `reset-admin-key.ts` to generate a new API key for existing users
- Or delete the user manually from database and recreate

**"Config file not found"**

- Ensure config file exists at `config/config.json.<streamer_id>`
- Check file permissions and path

---

## Database Migration

### migrate-streamer.ts

Migrate a streamer's database from legacy Sequelize schema to new Prisma schema. Interactive mode only - no flags required.

**Usage:**

```bash
npx tsx scripts/migrate-streamer.ts
```

The script will prompt for:

- Streamer name (tenant identifier)
- Dry run mode (validation-only, defaults to NO if skipped)

**Examples:**

```bash
# Run migration interactively
$ npx tsx scripts/migrate-streamer.ts

🚀 Starting migration

Streamer name (tenant identifier): quin69
Dry run only? (y/N to skip validation-only mode): y

📋 Migration details:
   Streamer: quin69
   Database URL: postgresql://***:***@<host>:5432/quin69
   Dry run mode: YES
```

**What it does:**

1. Fetches database URL from meta database for the tenant (automatically decrypted)
2. **Pre-flight validation:** Checks legacy table row counts (vods, emotes, games, logs)
3. **Creates new schema:** Generates `_new` tables (vods_new, emotes_new, games_new) + new tables (vod_uploads, chapters)
4. **Migrates data:**
   - VODs: Converts duration from seconds to Int, extracts YouTube uploads to separate table
   - Emotes: Maps 7tv_emotes column to seventv_emotes
   - Games: Migrates game chapter timestamps
   - Chapters: Extracts Kick-specific chapters from JSONB `chapters[]` array in vods table
   - Chat messages: Renames `logs` table to `chat_messages` (no data migration needed)
5. **Transaction-based:** All operations in single transaction with automatic rollback on error
6. **Legacy rename:** After confirmation, renames old tables to `*_legacy` for safe rollback capability

**Prerequisites:**

- Tenant must exist in meta database with encrypted `databaseUrl` field
- Streamer's PostgreSQL database must be accessible via the stored connection string

**Migration Output (Interactive):**

```
📊 Legacy database row counts:
   vods: 589
   emotes: 587
   games: 699
   logs: 48270726

✅ Migrated 589 VODs
✅ Migrated 587 emote records
✅ Migrated 699 game chapters
✅ Renamed logs table to chat_messages

📊 New database row counts:
   vods_new: 589
   vod_uploads: 243
   emotes_new: 587
   games_new: 699
   chapters: 1145
   chat_messages: 48270726

Rename legacy tables and finalize migration? [y/N]: y
✅ Legacy tables renamed and migration finalized

🎉 Migration completed successfully!
```

**Post-Migration Tables:**

- `vods` - Main VOD records (renamed from vods_new)
- `vod_uploads` - YouTube upload tracking (new table)
- `emotes` - Emote data per VOD (renamed from emotes_new)
- `games` - Game chapter timestamps (renamed from games_new)
- `chapters` - Kick-specific chapters extracted from JSONB (new table)
- `chat_messages` - Chat logs (renamed from logs)
- `vods_legacy`, `emotes_legacy`, `games_legacy`, `streams_legacy` - Backup tables

**Rollback Procedure:**

If you need to rollback after migration:

```sql
-- Drop new tables
DROP TABLE IF EXISTS vods, vod_uploads, emotes, games, chapters, chat_messages;

-- Restore legacy tables
ALTER TABLE vods_legacy RENAME TO vods;
ALTER TABLE emotes_legacy RENAME TO emotes;
ALTER TABLE games_legacy RENAME TO games;
ALTER TABLE streams_legacy RENAME TO streams;
```

---

## Internal/Testing Scripts

Scripts in the `scripts/internal/` directory are for testing, debugging, and maintenance tasks.

### cleanup-chat-typenames.ts

Remove `__typename` fields from chat message JSONB columns (message and user_badges).

**Usage:**

```bash
npx tsx scripts/internal/cleanup-chat-typenames.ts [options] [streamer]
```

**Options:**

- `--streamer <id>` or positional argument - Target specific streamer (optional, defaults to all)
- `--dry-run` - Validate without making changes
- `--yes` or `-y` - Auto-confirm without prompt
- `--batch-size <n>` - Set batch size (default: 50000)
- `--workers <n>` - Set worker count for parallel processing (default: 4)

**Example:**

```bash
# Dry run for specific streamer
npx tsx scripts/internal/cleanup-chat-typenames.ts --streamer moonmoon --dry-run

# Process all streamers with auto-confirm
npx tsx scripts/internal/cleanup-chat-typenames.ts --yes --workers 8
```

**What it does:**

1. Scans `chat_messages` table for JSONB fields containing `__typename`
2. Strips `__typename` from nested objects in `message` and `user_badges` columns
3. Updates records in parallel using multiple workers
4. Reports progress and statistics

---

### test-decrypt.ts

Test decryption functionality for encrypted database fields.

**Usage:**

```bash
npx tsx scripts/internal/test-decrypt.ts
```

**What it does:**

- Tests decryption of various encrypted fields (database URLs, auth objects, API keys)
- Validates encryption/decryption round-trip
- Useful for debugging encryption issues

---

### test-discord-webhook.ts

Test Discord webhook connectivity and message delivery.

**Usage:**

```bash
npx tsx scripts/internal/test-discord-webhook.ts
```

**Prerequisites:**

- `DISCORD_ALERT_WEBHOOK_URL` set in `.env`

**What it does:**

1. Validates webhook URL format
2. Sends basic text message
3. Sends embedded message with fields
4. Reports success/failure for each test

**Example output:**

```bash
✅ Loaded .env

Webhook: webhooks/123456789/****

=================================================
Discord Webhook Test Suite
=================================================

✅ Alerts enabled

✅ Sent!
✅ Embed sent!

=================================================
All automated tests complete! ✅
```

---

### test-youtube-token.ts

Test YouTube OAuth token persistence, refresh, and validation.

**Usage:**

```bash
npx tsx scripts/internal/test-youtube-token.ts [options]
```

**Options:**

- `-t, --tenant <id>` - Target specific tenant (auto-selects first if not specified)
- `--force-refresh` - Force token refresh via Google API
- `-v, --verbose` - Show detailed token objects
- `--check-only` - Only check current state without forcing refresh

**Example:**

```bash
# Check token status for specific tenant
npx tsx scripts/internal/test-youtube-token.ts --tenant moonmoon --verbose

# Force token refresh
npx tsx scripts/internal/test-youtube-token.ts --tenant moonmoon --force-refresh
```

**What it does:**

1. Retrieves encrypted YouTube auth from tenant record
2. Decrypts and displays current token state
3. Optionally forces token refresh via Google OAuth API
4. Validates token persistence in database
5. Reports token expiry and refresh status

**Example output:**

```bash
YouTube Token Test
==================

Using tenant: moonmoon

Current Token State:
--------------------------------------------------
Before:
  • Access token: ...abc123 (expires in 2h 15m)
  • Refresh token: ...xyz789 (present)
  • Scope: youtube.force-ssl youtube youtube.upload
  • Token type: Bearer

Forcing token refresh...
Loading streamer configs from DB...
✅ Refresh token available - attempting API refresh via validateYoutubeToken()
✅ Token refreshed successfully!

Updated Token State:
--------------------------------------------------
After:
  • Access token: ...def456 (expires in 1h 0m)
  • Refresh token: ...xyz789 (unchanged)
  • Expiry: 2024-01-15T18:30:00.000Z

✅ Token validation passed
```

---

## Security Notes

- All credentials are encrypted at rest using AES-256-GCM
- API keys are shown only once during creation/reset and cannot be retrieved
- Store API keys in a secure password manager or vault
- Scripts directory is ignored in git (`.gitignore`)
- Never commit config files containing plaintext credentials
- Migration scripts preserve legacy tables for safe rollback capability
