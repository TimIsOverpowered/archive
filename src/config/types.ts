export interface TenantConfig {
  id: string;
  displayName?: string;
  createdAt: Date;
  twitch?: { enabled: boolean; auth?: string; username?: string; mainPlatform?: boolean; id?: string };
  youtube?: {
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
  };
  kick?: { id?: string; enabled: boolean; username?: string; mainPlatform?: boolean };
  database: { url: string; connectionLimit?: number };
  settings: {
    vodPath?: string;
    livePath?: string;
    vodDownload?: boolean;
    chatDownload?: boolean;
    domainName: string;
    timezone: string;
    saveMP4: boolean;
    saveHLS: boolean;
  };
}
