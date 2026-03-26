# Archive Management Scripts

All scripts use `tsx` for TypeScript execution. Run with: `npx tsx scripts/<script-name>.ts`

## Prerequisites

Ensure environment variables are loaded from `.env`:

- `META_DATABASE_URL` - Connection string for the meta database
- `ENCRYPTION_MASTER_KEY` - 64-character hex string for AES-256-GCM encryption

---

## Tenant Management

### import-tenant.ts

Import a streamer's configuration from JSON file into the meta database.

**Usage:**

```bash
npx tsx scripts/import-tenant.ts <channel_name> "postgresql://user:pass@host:5432/dbname"
```

**Example:**

```bash
npx tsx scripts/import-tenant.ts moonmoon "postgresql://archive_moonmoon:password@95.217.201.55:5432/moonmoon"
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

## Security Notes

- All credentials are encrypted at rest using AES-256-GCM
- API keys are shown only once during creation/reset and cannot be retrieved
- Store API keys in a secure password manager or vault
- Scripts directory is ignored in git (`.gitignore`)
- Never commit config files containing plaintext credentials

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

Migrate a streamer's database from legacy Sequelize schema to new Prisma schema.

**Usage:**

```bash
npx tsx scripts/migrate-streamer.ts --streamer <id> --db-url <url> [--dry-run]
```

**Options:**

- `--streamer <id>` - Streamer ID (required)
- `--db-url <url>` - PostgreSQL connection URL for the streamer's database (required)
- `--dry-run` - Validate and show what would be migrated without making changes

**Examples:**

```bash
# Dry run to see what would migrate
npx tsx scripts/migrate-streamer.ts --streamer quin69 --db-url "postgresql://op:ea@EX7PLKTuK2iiw@192.168.1.66/quin69" --dry-run

# Execute migration
npx tsx scripts/migrate-streamer.ts --streamer quin69 --db-url "postgresql://op:ea@EX7PLKTuK2iiw@192.168.1.66/quin69"
```

**What it does:**

1. **Pre-flight validation:** Checks legacy table row counts (vods, emotes, games, logs)
2. **Creates new schema:** Generates `_new` tables (vods_new, emotes_new, games_new) + new tables (vod_uploads, chapters)
3. **Migrates data:**
   - VODs: Converts duration from seconds to Int, extracts YouTube uploads to separate table
   - Emotes: Maps 7tv_emotes column to seven_tv_emotes
   - Games: Migrates game chapter timestamps
   - Chapters: Extracts Kick-specific chapters from JSONB `chapters[]` array in vods table
   - Chat messages: Renames `logs` table to `chat_messages` (no data migration needed)
4. **Transaction-based:** All operations in single transaction with automatic rollback on error
5. **Legacy rename:** After confirmation, renames old tables to `*_legacy` for safe rollback capability

**Migration Output:**

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

## Tenant Creation

### create-tenant.ts

Interactive wizard to create a new streamer tenant from scratch.

**Usage:**

```bash
npx tsx scripts/create-tenant.ts
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
6. Collects streaming platform credentials (Twitch, Kick)
7. Collects YouTube upload settings and OAuth credentials
8. Collects Google OAuth credentials (for YouTube token refresh)
9. Collects general archive settings (paths, timezone, download preferences)
10. Shows a summary and requires confirmation before proceeding
11. Generates config files with plaintext credentials for backup
12. Registers tenant in meta database with encrypted sensitive fields and explicit `id`

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
PostgreSQL host: 95.217.201.55
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
STREAMING PLATFORMS
──────────────────────────────────────────
Enable Twitch? (y/N): y

Twitch Stream Info:
User ID (numeric): 121059319
Username: moonmoon

Twitch OAuth App Credentials:
Client ID: 0bl8jkdk4uzksk6ountqhx6sff1eb1
Client Secret: ********
Access Token: ********

Enable Kick? (y/N): n

...

==================================================
TENANT CREATION SUMMARY
==================================================
Streamer ID: moonmoon
Display Name: MOONMOON
Database: postgresql://archive:***@95.217.201.55:5432/moonmoon

Streaming Platforms:
  ✓ Twitch (121059319 / moonmoon)
  ✗ Kick disabled

YouTube Uploads:
  ✓ Enabled
    - VOD upload: yes
    - Per-game upload: no
    - Multi-track: yes
    - Split duration: 10800s

Settings:
  Domain: moon2.tv
  VOD Path: /mnt/storage/vods
  Timezone: America/New_York
  Chat Download: yes
  VOD Download: yes
  Save HLS: no
  Save MP4: yes

Proceed with tenant creation? (y/N): y

✓ Created config/config.json.moonmoon
✓ Created config/default.json.moonmoon

✅ TENANT CREATED SUCCESSFULLY!

Channel Name: moonmoon
Tenant ID in meta DB: moonmoon

📁 Config files created:
   - config/config.json.moonmoon
   - config/default.json.moonmoon

🗄️  Database: postgresql://archive:***@95.217.201.55:5432/moonmoon
   Schema: Migrated with normalized tables

⚠️  IMPORTANT: Store these credentials securely:
   Plaintext credentials are stored in config/config.json.moonmoon
```

**Generated files:**

- `config/config.json.<channel_name>` - Full configuration with plaintext credentials for backup
- `config/default.json.<channel_name>` - Server defaults with database connection string

**Encrypted fields in meta DB:**

- `twitch.auth` (client_id, client_secret, access_token)
- `youtube.api_key`
- `youtube.auth` (access_token, refresh_token, etc.)
- `database_url`

**Note:** This script is for interactive tenant creation. For bulk imports from existing config files, use `import-tenant.ts`.

---

### import-tenant.ts

Import a streamer's configuration from JSON file into the meta database.

**Usage:**

```bash
npx tsx scripts/import-tenant.ts <streamer_id> "postgresql://user:pass@host:5432/dbname"
```

**Example:**

```bash
npx tsx scripts/import-tenant.ts moonmoon "postgresql://archive_moonmoon:password@95.217.201.55:5432/moonmoon"
```

**What it does:**

1. Reads `config/config.json.<streamer_id>`
2. Encrypts sensitive fields:
   - `twitch.auth` (client_secret, access_token)
   - `youtube.auth` (refresh_token, access_token)
   - `youtube.api_key`
   - `database_url`
3. Inserts into `tenants` table with all settings

**Requirements:**

- Config file must exist at `config/config.json.<streamer_id>`
- Database URL must be provided as second argument
- The PostgreSQL database must already exist

---

## Security Notes

- All credentials are encrypted at rest using AES-256-GCM
- API keys are shown only once during creation/reset and cannot be retrieved
- Store API keys in a secure password manager or vault
- Scripts directory is ignored in git (`.gitignore`)
- Never commit config files containing plaintext credentials
- Migration scripts preserve legacy tables for safe rollback capability
