import { PrismaClient } from '../../generated/streamer';
interface TenantStats {
    tenant: {
        id: string;
        display_name: string | null;
        platforms: string[];
        created_at: Date;
    };
    database: {
        status: string;
        lastChecked: Date;
    };
    vods: {
        totalCount: number;
        byPlatform: Record<string, number>;
        totalHours: number;
        lastVodDate: Date | null;
        thisMonthCount: number;
    };
    youtube: {
        totalUploads: number;
        failedUploads: number;
        lastUploadDate: Date | null;
        uploadSuccessRate: number;
    };
    chat: {
        totalMessages: number;
        messagesThisMonth: number;
    };
    chapters: {
        totalChapters: number;
        gamesCount: number;
    };
}
export declare function getTenantStats(client: PrismaClient, streamerId: string): Promise<TenantStats>;
export declare function getAllTenants(): Promise<Array<{
    id: string;
    display_name: string | null;
    platforms: string[];
    created_at: Date;
}>>;
export {};
//# sourceMappingURL=tenants.service.d.ts.map