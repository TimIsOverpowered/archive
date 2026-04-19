import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { metaClient } from '../src/db/meta-client.js';
import { encryptObject, encryptScalar } from '../src/utils/encryption.js';
import { extractErrorDetails } from '../src/utils/error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TwitchConfig {
  enabled?: boolean;
  auth?: {
    client_id: string;
    client_secret: string;
    access_token: string;
  };
  id: string;
  username: string;
}

interface YoutubeConfig {
  description?: string;
  public?: boolean;
  vodUpload?: boolean;
  perGameUpload?: boolean;
  restrictedGames?: (string | null)[];
  splitDuration?: number;
  apiKey?: string;
  liveUpload?: boolean;
  multiTrack?: boolean;
  upload?: boolean;
  auth?: {
    access_token: string;
    scope: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
  };
}

interface KickConfig {
  enabled?: boolean;
  username?: string;
  id?: string;
}

interface SettingsConfig {
  channel?: string;
  domainName: string;
  vodPath: string;
  livePath: string;
  timezone: string;
  chatDownload: boolean;
  vodDownload: boolean;
  saveHLS: boolean;
  saveMP4: boolean;
}

interface RawConfig {
  twitch?: TwitchConfig;
  kick?: KickConfig;
  youtube?: YoutubeConfig;
  channel?: string;
  domainName: string;
  vodPath: string;
  livePath: string;
  timezone: string;
  chatDownload: boolean;
  vodDownload: boolean;
  saveHLS: boolean;
  saveMP4: boolean;
}

function processTwitch(config: TwitchConfig | undefined) {
  if (!config) return null;

  const twitch: Record<string, unknown> = {
    enabled: config.enabled ?? false,
    id: config.id,
    username: config.username,
    mainPlatform: false,
  };

  if (config.auth && (config.auth.client_secret || config.auth.access_token)) {
    twitch.auth = encryptObject(config.auth);
  }

  return twitch;
}

function processYoutube(config: YoutubeConfig | undefined) {
  if (!config) return null;

  const youtube: Record<string, unknown> = {};

  if (config.description !== undefined) youtube.description = config.description;
  if (config.public !== undefined) youtube.public = config.public;
  if (config.vodUpload !== undefined) youtube.vodUpload = config.vodUpload;
  if (config.perGameUpload !== undefined) youtube.perGameUpload = config.perGameUpload;
  if (config.restrictedGames !== undefined) youtube.restrictedGames = config.restrictedGames;
  if (config.splitDuration !== undefined) youtube.splitDuration = config.splitDuration;
  if (config.liveUpload !== undefined) youtube.liveUpload = config.liveUpload;
  if (config.multiTrack !== undefined) youtube.multiTrack = config.multiTrack;
  if (config.upload !== undefined) youtube.upload = config.upload;

  if (config.apiKey) {
    youtube.apiKey = encryptScalar(config.apiKey);
  }

  if (config.auth && (config.auth.refresh_token || config.auth.access_token)) {
    youtube.auth = encryptObject(config.auth);
  }

  return Object.keys(youtube).length > 0 ? youtube : null;
}

function processKick(config: KickConfig | undefined) {
  if (!config) return null;

  const kick: Record<string, unknown> = {
    enabled: config.enabled ?? false,
    mainPlatform: false,
  };

  if (config.id) kick.id = config.id;
  if (config.username) kick.username = config.username;

  return kick;
}

function processSettings(raw: RawConfig) {
  const settings: SettingsConfig = {
    domainName: raw.domainName,
    vodPath: raw.vodPath,
    livePath: raw.livePath,
    timezone: raw.timezone,
    chatDownload: raw.chatDownload,
    vodDownload: raw.vodDownload,
    saveHLS: raw.saveHLS,
    saveMP4: raw.saveMP4,
  };

  return settings;
}

async function importConfig(channelName: string, dbUrl: string): Promise<void> {
  // Validate format
  if (!/^[a-z0-9_]+$/.test(channelName)) {
    console.error(`❌ Invalid channel name format: ${channelName}. Must be lowercase alphanumeric + underscore only.`);
    process.exit(1);
  }

  // Validate length
  if (channelName.length > 25) {
    console.error(`❌ Channel name exceeds maximum length of 25 characters: ${channelName}`);
    process.exit(1);
  }

  // Check for existing tenant
  const existingTenant = await metaClient.tenant.findFirst({
    where: { id: channelName },
  });
  if (existingTenant) {
    console.error(`❌ Tenant already exists: ${channelName}`);
    process.exit(1);
  }

  const configPath = path.join(__dirname, '..', 'config', `config.json.${channelName}`);

  if (!fs.existsSync(configPath)) {
    console.log(`Skipping ${channelName}: config file not found`);
    return;
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RawConfig;

  const twitch = processTwitch(rawConfig.twitch);
  const youtube = processYoutube(rawConfig.youtube);
  const kick = processKick(rawConfig.kick);
  const settings = processSettings(rawConfig);

  const platformCount = (twitch ? 1 : 0) + (kick ? 1 : 0);
  if (platformCount === 1) {
    if (twitch) (twitch as Record<string, unknown>).mainPlatform = true;
    if (kick) (kick as Record<string, unknown>).mainPlatform = true;
  }

  const encryptedDbUrl = encryptScalar(dbUrl);

  const displayName = rawConfig.channel || channelName;

  const createData: Record<string, unknown> = {
    id: channelName,
    displayName: displayName,
    databaseUrl: encryptedDbUrl,
    settings: settings as SettingsConfig,
  };

  if (twitch) createData.twitch = twitch;
  if (youtube) createData.youtube = youtube;
  if (kick) createData.kick = kick;

  await metaClient.tenant.create({ data: createData as any });

  console.log(`✓ Imported ${channelName}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx import-tenant.ts <channel_name> <database_url>');
    console.log('Example: tsx import-tenant.ts moonmoon "postgresql://<user>:***@<host>:5432/<db>"');
    process.exit(1);
  }

  const [channelName, dbUrl] = args;

  if (!dbUrl) {
    console.error('Database URL is required');
    process.exit(1);
  }

  try {
    await importConfig(channelName, dbUrl);
    console.log('Done!');
  } catch (error) {
    const details = extractErrorDetails(error);
    console.error('Error importing config:', details.message);
    process.exit(1);
  } finally {
    await metaClient.$disconnect();
  }
}

main();
