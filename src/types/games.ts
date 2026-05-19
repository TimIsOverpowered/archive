/** Shape of a game neighbor returned in prev/next arrays. */
export type GameNeighbor = {
  id: number;
  vod_id: number;
  start: number;
  duration: number;
  end: number;
  game_name: string | null;
  game_id: string | null;
  title: string | null;
  thumbnail_url: string | null;
  chapter_image: string | null;
  created_at: Date | null;
};

/** Shape of a game entry returned by the games list API. */
export interface GameResponse {
  id: number;
  vod_id: number;
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
  created_at: Date | null;
  updated_at: Date | null;
  prev: GameNeighbor[];
  next: GameNeighbor[];
}
