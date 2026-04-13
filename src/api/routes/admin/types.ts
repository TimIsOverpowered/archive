import type { Platform, SourceType } from '../../../types/platforms.js';

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
  platformStats: Record<Platform, VodStats>;
  overallStats: VodStats;
}

export interface CreateVodParams {
  id: string;
}

export interface DeleteVodParams {
  id: string;
  vodId: number;
}

export interface StatsParams {
  id: string;
}

export interface CreateVodBody {
  vodId?: number;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform?: Platform;
}

// Download jobs types
export interface VodRecordBase {
  id: number;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: Platform | string; // Allow string for Prisma compatibility
}

export interface VODDownloadJobBody {
  vodId?: number;
  type?: SourceType;
  platform?: Platform;
  path?: string;
}

export interface HLSDownloadBody {
  vodId: number;
  platform?: Platform;
  skipEmotes?: boolean;
}
