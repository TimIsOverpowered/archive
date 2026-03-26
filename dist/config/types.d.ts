export interface StreamerConfig {
    id: string;
    twitch?: {
        clientId?: string | undefined;
        clientSecret?: string | undefined;
        channelName?: string;
    };
    youtube?: {
        clientId?: string | undefined;
        clientSecret?: string | undefined;
        refreshToken?: string;
    };
    kick?: {
        enabled: boolean;
        channelName?: string;
    };
    database: {
        url: string;
        connectionLimit?: number;
    };
}
//# sourceMappingURL=types.d.ts.map