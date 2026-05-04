/** Shape of a VOD record with all its relations (uploads, chapters, games). */
export interface VodResponse {
  id: number;
  platformVodId: string | null;
  platform: string;
  title: string | null;
  duration: number;
  platformStreamId: string | null;
  created_at: Date;
  updated_at: Date;
  is_live: boolean;
  started_at: Date | null;
  vod_uploads: Array<{
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
    start_time: number;
    end_time: number;
    video_provider: string | null;
    video_id: string | null;
    thumbnail_url: string | null;
    game_id: string | null;
    game_name: string | null;
    title: string | null;
    chapter_image: string | null;
  }>;
  prev?: { id: number; title: string | null; platform: string } | null;
  next?: { id: number; title: string | null; platform: string } | null;
}
