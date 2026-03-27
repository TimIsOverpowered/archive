export interface StreamerConfig {
  id: string;
  twitch?: { clientId?: string | undefined; clientSecret?: string | undefined; channelName?: string };
  youtube?: {
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    refreshToken?: string;
    public: boolean;
    splitDuration: number;
    perGameUpload: boolean;
    restrictedGames: string[];
    description: string;
    saveMP4: boolean;
    saveHLS: boolean;
  };
  kick?: { enabled: boolean; channelName?: string };
  database: { url: string; connectionLimit?: number };
  timezone: string;
  alerts: {
    enabled: boolean;
  };
}
