import { PrismaClient } from '../../generated/streamer';
interface VodResponse {
    id: string;
    platform: string;
    title: string | null;
    duration: number;
    thumbnail_url: string | null;
    created_at: Date;
    downloaded_at: Date | null;
    vod_uploads?: Array<{
        upload_id: string;
        platform: string;
        status: string;
    }>;
    chapters?: Array<{
        name: string | null;
        duration: string | null;
        start: number;
    }>;
}
interface VodQuery {
    platform?: 'twitch' | 'kick';
    from?: string;
    to?: string;
    uploaded?: 'youtube';
    game?: string;
    page?: number;
    limit?: number;
    sort?: 'created_at' | 'duration' | 'uploaded_at';
    order?: 'asc' | 'desc';
}
export declare function getVods(client: PrismaClient, streamerId: string, query: VodQuery): Promise<{
    vods: VodResponse[];
    total: number;
}>;
export declare function getVodById(client: PrismaClient, streamerId: string, vodId: string): Promise<VodResponse | null>;
export {};
//# sourceMappingURL=vods.service.d.ts.map