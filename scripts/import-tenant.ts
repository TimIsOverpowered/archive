#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { metaClient } from '../src/db/meta-client';
import { encryptObject, encryptScalar } from '../src/utils/encryption';

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
    api_key?: string;
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

interface GoogleConfig {
    client_id: string;
    client_secret: string;
    redirect_url: string;
}

interface SettingsConfig {
    channel?: string;
    domain_name: string;
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
    google?: GoogleConfig;
    youtube?: YoutubeConfig;
    channel?: string;
    domain_name?: string;
    vodPath?: string;
    livePath?: string;
    timezone?: string;
    chatDownload?: boolean;
    vodDownload?: boolean;
    saveHLS?: boolean;
    saveMP4?: boolean;
}

function processTwitch(config: TwitchConfig | undefined) {
    if (!config) return null;

    const twitch: Record<string, unknown> = {
        enabled: config.enabled ?? false,
        id: config.id,
        username: config.username,
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

    if (config.api_key) {
        youtube.api_key = encryptScalar(config.api_key);
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
    };

    if (config.id) kick.id = config.id;
    if (config.username) kick.username = config.username;

    return kick;
}

function processGoogle(config: GoogleConfig | undefined) {
    if (!config) return null;

    return {
        client_id: config.client_id,
        client_secret: config.client_secret,
        redirect_url: config.redirect_url,
    };
}

function processSettings(raw: RawConfig) {
    const settings: Record<string, unknown> = {};

    if (raw.domain_name) settings.domain_name = raw.domain_name;
    if (raw.vodPath) settings.vodPath = raw.vodPath;
    if (raw.livePath) settings.livePath = raw.livePath;
    if (raw.timezone) settings.timezone = raw.timezone;
    if (raw.chatDownload !== undefined) settings.chatDownload = raw.chatDownload;
    if (raw.vodDownload !== undefined) settings.vodDownload = raw.vodDownload;
    if (raw.saveHLS !== undefined) settings.saveHLS = raw.saveHLS;
    if (raw.saveMP4 !== undefined) settings.saveMP4 = raw.saveMP4;

    return settings;
}

async function importConfig(streamerId: string, dbUrl: string): Promise<void> {
    const configPath = path.join(__dirname, '..', 'config', `config.json.${streamerId}`);
    const defaultPath = path.join(__dirname, '..', 'config', `default.json.${streamerId}`);

    if (!fs.existsSync(configPath)) {
        console.log(`Skipping ${streamerId}: config file not found`);
        return;
    }

    const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RawConfig;

    const twitch = processTwitch(rawConfig.twitch);
    const youtube = processYoutube(rawConfig.youtube);
    const kick = processKick(rawConfig.kick);
    const google = processGoogle(rawConfig.google);
    const settings = processSettings(rawConfig);

    const encryptedDbUrl = encryptScalar(dbUrl);

    const displayName = rawConfig.channel || streamerId;

    const createData = {
            display_name: displayName,
            database_url: encryptedDbUrl,
            settings: settings as Record<string, string | boolean | number>,
        };

        if (twitch) (createData as any).twitch = twitch;
        if (youtube) (createData as any).youtube = youtube;
        if (kick) (createData as any).kick = kick;
        if (google) (createData as any).google = google;

    await metaClient.tenant.create({ data: createData });

    console.log(`✓ Imported ${streamerId}`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: tsx import-tenant.ts <streamer_id> <database_url>');
        console.log('Example: tsx import-tenant.ts moonmoon "postgresql://user:pass@host/db"');
        process.exit(1);
    }

    const [streamerId, dbUrl] = args;

    if (!dbUrl) {
        console.error('Database URL is required');
        process.exit(1);
    }

    try {
        await importConfig(streamerId, dbUrl);
        console.log('Done!');
    } catch (error) {
        console.error('Error importing config:', error);
        process.exit(1);
    } finally {
        await metaClient.$disconnect();
    }
}

main();
