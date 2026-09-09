import type { Platform, SourceType } from '../../../types/platforms.ts';

/** Params containing tenant ID. */
export interface TenantParams {
  tenantId: string;
}

/** Alias for tenant params used by stats endpoint. */
export type StatsParams = TenantParams;
/** Alias for tenant params used by create VOD endpoint. */
export type CreateVodParams = TenantParams;
/** Alias for tenant params used by delete VOD endpoint. */
export type DeleteVodParams = TenantParams;

/** Body for creating a VOD record manually. */
export interface CreateVodBody {
  vodId: string;
  title?: string;
  createdAt?: string;
  duration?: number;
  platform: Platform;
  source: 'manual' | 'api';
}

/** Body for deleting a VOD and related data. */
export interface DeleteVodBody {
  vodId: string;
  platform: Platform;
}

/** Params for the admin "update VOD" endpoint (tenant scoped). */
export type UpdateVodParams = TenantParams;

/**
 * Body for the admin "update VOD" endpoint (partial update).
 * Identify the target VOD with either `dbId` OR the `platform` + `vodId` pair.
 */
export interface UpdateVodBody {
  dbId?: number;
  platform?: Platform;
  vodId?: string;
  title?: string | null;
  duration?: number;
  created_at?: string;
  is_live?: boolean;
  started_at?: string | null;
  platform_vod_id?: string | null;
  platform_stream_id?: string | null;
}

/** Base VOD record shape used by download job helpers. */
export interface VodRecordBase {
  id: number;
  title: string | null;
  created_at: Date;
  duration: number;
  platformStreamId: string | null;
  platform: Platform;
}

/** Body for queuing a VOD download job. */
export interface VODDownloadJobBody {
  vodId?: number;
  type?: SourceType;
  platform?: Platform;
  path?: string;
}

/** Body for triggering an HLS download. */
export interface HLSDownloadBody {
  vodId: number;
  platform?: Platform;
  skipEmotes?: boolean;
}
