import type {
  ColumnType,
  Generated,
  JSONColumnType,
  Kysely,
  Selectable,
  Insertable,
  Updateable,
  Transaction,
} from 'kysely';

export interface StreamerDB {
  vods: VodsTable;
  vod_uploads: VodUploadsTable;
  emotes: EmotesTable;
  games: GamesTable;
  chapters: ChaptersTable;
  chat_messages: ChatMessagesTable;
}

export interface VodsTable {
  id: Generated<number>;
  platform_vod_id: string | null;
  platform: string;
  title: string | null;
  duration: number;
  platform_stream_id: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, never, never>;
  is_live: boolean;
  started_at: Date | null;
}

export interface VodUploadsTable {
  vod_id: number;
  upload_id: string;
  type: string | null;
  duration: number;
  part: number;
  status: string;
  thumbnail_url: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface EmoteData {
  id: string;
  code: string;
  flags?: number;
}

export interface EmotesTable {
  id: Generated<number>;
  vod_id: number;
  ffz_emotes: JSONColumnType<EmoteData[]> | null;
  bttv_emotes: JSONColumnType<EmoteData[]> | null;
  seventv_emotes: JSONColumnType<EmoteData[]> | null;
}

export interface GamesTable {
  id: Generated<number>;
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

export interface ChaptersTable {
  id: Generated<number>;
  vod_id: number;
  game_id: string | null;
  name: string | null;
  image: string | null;
  start: number;
  end: number | null;
}

export interface ChatMessagesTable {
  id: string;
  vod_id: number;
  display_name: string | null;
  content_offset_seconds: number;
  user_color: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  message: JSONColumnType<Record<string, unknown>> | null;
  user_badges: JSONColumnType<Record<string, unknown>> | null;
}

// Utility types
export type SelectableVods = Selectable<VodsTable>;
export type InsertableVods = Insertable<VodsTable>;
export type UpdateableVods = Updateable<VodsTable>;

export type SelectableVodUploads = Selectable<VodUploadsTable>;
export type InsertableVodUploads = Insertable<VodUploadsTable>;
export type UpdateableVodUploads = Updateable<VodUploadsTable>;

export type SelectableEmotes = Selectable<EmotesTable>;
export type InsertableEmotes = Insertable<EmotesTable>;
export type UpdateableEmotes = Updateable<EmotesTable>;

export type SelectableGames = Selectable<GamesTable>;
export type InsertableGames = Insertable<GamesTable>;
export type UpdateableGames = Updateable<GamesTable>;

export type SelectableChapters = Selectable<ChaptersTable>;
export type InsertableChapters = Insertable<ChaptersTable>;
export type UpdateableChapters = Updateable<ChaptersTable>;

export type SelectableChatMessages = Selectable<ChatMessagesTable>;
export type InsertableChatMessages = Insertable<ChatMessagesTable>;
export type UpdateableChatMessages = Updateable<ChatMessagesTable>;

// DBClient accepts either the main Kysely instance or a transaction context.
// Transaction<DB> and Kysely<DB> are distinct classes in Kysely — both share
// the query-building API but TS treats them as incompatible without a union.
export type DBClient = Kysely<StreamerDB> | Transaction<StreamerDB>;
