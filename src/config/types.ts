import type {
  TwitchConfig as _TwitchConfig,
  YouTubeConfig as _YouTubeConfig,
  KickConfig as _KickConfig,
  TenantSettings as _TenantSettings,
} from './schemas.js';
import { Platform } from '../types/platforms.js';

export type TwitchConfig = _TwitchConfig;
export type YouTubeConfig = _YouTubeConfig;
export type KickConfig = _KickConfig;
export type TenantSettings = _TenantSettings;

export interface TenantBase {
  id: string;
  displayName?: string | undefined;
  createdAt: Date;
}

export interface DatabaseConfig {
  url: string;
  connectionLimit?: number;
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

export function getDisplayName(config: TenantConfig): string {
  return config.displayName ?? config.id;
}
