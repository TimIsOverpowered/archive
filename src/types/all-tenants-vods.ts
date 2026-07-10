import type { Platform } from './platforms.js';

export interface AllTenantsVod {
  tenantId: string;
  displayName: string | null;
  id: number;
  platform_vod_id: string | null;
  platform: Platform;
  title: string | null;
  duration: number;
  platform_stream_id: string | null;
  created_at: Date;
  updated_at: Date;
  is_live: boolean;
  started_at: Date | null;
  vod_uploads: Array<{
    id: number;
    upload_id: string;
    type: string | null;
    duration: number;
    part: number;
    status: string;
    thumbnail_url: string | null;
    created_at: string;
  }>;
  chapters: Array<{
    name: string | null;
    image: string | null;
    duration: string | null;
    start: number;
    end: number | null;
  }>;
  games: Array<{
    start: number;
    duration: number;
    end: number;
    video_provider: string | null;
    video_id: string | null;
    thumbnail_url: string | null;
    game_id: string | null;
    game_name: string | null;
    title: string | null;
    chapter_image: string | null;
  }>;
}
