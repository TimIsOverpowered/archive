import type { Platform, SourceType } from '../../../types/platforms.js';

export interface TenantParams {
  tenantId: string;
}

export type StatsParams = TenantParams;
export type CreateVodParams = TenantParams;
export type DeleteVodParams = TenantParams;

export interface CreateVodBody {
  vodId: string;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform: Platform;
}

export interface DeleteVodBody {
  vodId: string;
  platform: Platform;
}

// Download jobs types
export interface VodRecordBase {
  id: number;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  platform: Platform | string; // Allow string for legacy data compatibility
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
