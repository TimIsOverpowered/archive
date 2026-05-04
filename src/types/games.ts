/** Shape of a game entry returned by the games list API. */
export interface GameResponse {
  id: number;
  vod_id: number;
  start_time: number;
  end_time: number;
  video_provider: string | null;
  video_id: string | null;
  thumbnail_url: string | null;
  game_id: string | null;
  game_name: string | null;
  title: string | null;
  chapter_image: string | null;
}
