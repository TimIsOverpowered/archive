/**
 * Kick livestream data structure from /api/v2/channels/{username}/livestream endpoint
 * Unified interface consolidating definitions from kick.ts and kick-live.ts
 */
export interface KickStreamStatus {
  id: string;
  session_title?: string | null;
  created_at: string;
  playback_url?: string | null;
  viewers?: number | null;
  slug?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  category?: {
    id: number;
    name?: string | null;
    slug?: string | null;
  } | null;
  thumbnail?: {
    src?: string | null;
    srcset?: string | null;
  } | null;
}
