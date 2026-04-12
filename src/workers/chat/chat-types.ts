import type { InputJsonValue } from '../../../generated/streamer/internal/prismaNamespace';

export interface ChatMessageCreateInput {
  id: string;
  vod_id: number;
  display_name: string | null;
  content_offset_seconds: string;
  createdAt: Date;
  message?: InputJsonValue;
  user_badges?: InputJsonValue;
  user_color: string | null;
}
