export type JsonValue = unknown;

export interface ChatMessageCreateInput {
  id: string;
  vod_id: number;
  display_name: string | null;
  content_offset_seconds: number;
  createdAt: Date;
  message?: JsonValue;
  user_badges?: JsonValue;
  user_color: string | null;
}
