import { PrismaClient } from '../../generated/streamer';
interface ChatMessage {
    id: string;
    vod_id: string;
    display_name: string | null;
    content_offset_seconds: number;
    message: any;
    user_badges: any;
    user_color: string;
}
export declare function getLogsByOffset(client: PrismaClient, streamerId: string, vodId: string, offsetSeconds: number): Promise<{
    comments: ChatMessage[];
    cursor?: string;
}>;
export declare function getLogsByCursor(client: PrismaClient, streamerId: string, vodId: string, cursor: string): Promise<{
    comments: ChatMessage[];
    cursor?: string;
}>;
export {};
//# sourceMappingURL=logs.service.d.ts.map