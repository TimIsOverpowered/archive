import { PrismaClient } from '../../generated/streamer';
import { StreamerConfig } from '../config/types';
export declare function getClient(streamerId: string): PrismaClient | undefined;
export declare function createClient(config: StreamerConfig): Promise<PrismaClient>;
export declare function closeClient(streamerId: string): Promise<void>;
export declare function closeAllClients(): Promise<void>;
//# sourceMappingURL=client.d.ts.map