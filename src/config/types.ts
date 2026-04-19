export interface TenantBase {
  id: string;
  displayName?: string;
  createdAt: Date;
}

export interface TwitchConfig {
  enabled: boolean;
  auth?: string;
  username?: string;
  mainPlatform?: boolean;
  id?: string;
}

export interface YouTubeConfig {
  auth?: string;
  public: boolean;
  upload: boolean;
  vodUpload: boolean;
  liveUpload: boolean;
  multiTrack: boolean;
  apiKey?: string;
  splitDuration: number;
  perGameUpload: boolean;
  restrictedGames: (string | null)[];
  description: string;
}

export interface KickConfig {
  id?: string;
  enabled: boolean;
  username?: string;
  mainPlatform?: boolean;
}

export interface DatabaseConfig {
  url: string;
  connectionLimit?: number;
}

export interface TenantSettings {
  vodPath?: string;
  livePath?: string;
  vodDownload?: boolean;
  chatDownload?: boolean;
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
