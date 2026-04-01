export interface VodStats {
  totalVods: number;
  completedDownloads: number;
  failedDownloads: number;
  pendingUploads: number;
  successfulUploads: number;
  lastActivity?: Date | null;
}

export interface TenantInfo {
  id: string;
  displayName: string;
  platformStats: Record<'twitch' | 'kick', VodStats>;
  overallStats: VodStats;
}

export interface CreateVodParams {
  id: string;
}

export interface DeleteVodParams {
  id: string;
  vodId: string;
}

export interface StatsParams {
  id: string;
}

export interface CreateVodBody {
  vodId?: string;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform?: 'twitch' | 'kick';
}

// Download jobs types
export interface VodRecordBase {
  id: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: 'twitch' | 'kick' | string; // Allow string for Prisma compatibility
}

export interface VODDownloadJobBody {
  vodId?: string;
  type?: 'live' | 'vod';
  platform?: 'twitch' | 'kick';
  path?: string;
}

export interface HLSDownloadBody {
  vodId: string;
  platform?: 'twitch' | 'kick';
  skipEmotes?: boolean;
}

export type Platform = 'twitch' | 'kick';
