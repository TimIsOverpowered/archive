import { StreamerConfig } from './types';
export declare function loadStreamerConfigs(): Promise<StreamerConfig[]>;
export declare function getStreamerConfig(streamerId: string): StreamerConfig | undefined;
export declare function getConfigById(streamerId: string): StreamerConfig | undefined;
export declare function clearConfigCache(): void;
//# sourceMappingURL=loader.d.ts.map