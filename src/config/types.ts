import { Platform } from '../types/platforms.js';

export interface TenantBase {
  id: string;
  displayName?: string | undefined;
  createdAt: Date;
}

export interface TwitchConfig {
  enabled: boolean;
  auth?: string | undefined;
  username?: string | undefined;
  mainPlatform?: boolean | undefined;
  id?: string | undefined;
}

export interface YouTubeConfig {
  auth?: string | undefined;
  public: boolean;
  upload: boolean;
  vodUpload: boolean;
  liveUpload: boolean;
  multiTrack: boolean;
  apiKey?: string | undefined;
  splitDuration: number;
  perGameUpload: boolean;
  restrictedGames: (string | null)[];
  description: string;
}

export interface KickConfig {
  id?: string | undefined;
  enabled: boolean;
  username?: string | undefined;
  mainPlatform?: boolean | undefined;
}

export interface DatabaseConfig {
  url: string;
  connectionLimit?: number;
}

export interface TenantSettings {
  vodPath?: string | undefined;
  livePath?: string | undefined;
  vodDownload?: boolean | undefined;
  chatDownload?: boolean | undefined;
  domainName: string;
  timezone: string;
  saveMP4: boolean;
  saveHLS: boolean;
}

export interface TenantConfig extends TenantBase {
  twitch?: TwitchConfig;
  youtube?: YouTubeConfig;
  kick?: KickConfig;
  database: DatabaseConfig;
  settings: TenantSettings;
}

export type PlatformConfig = TwitchConfig | KickConfig | undefined;

export function getPlatformConfig(config: TenantConfig, platform: Platform): PlatformConfig {
  switch (platform) {
    case 'twitch':
      return config.twitch;
    case 'kick':
      return config.kick;
    default:
      return undefined;
  }
}
