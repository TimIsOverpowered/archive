import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';
import type {
  TwitchChatEdge,
  TwitchChatMessageNode,
  TwitchCommentsConnection,
  TwitchEmoteFragment,
  TwitchUserBadgesArray,
} from '../../services/twitch/index.js';

/**
 * Extracts edges from GraphQL pagination response.
 * Type-safe extraction that filters valid edges at runtime.
 */
export function extractEdges(
  commentsObj: TwitchCommentsConnection
): Array<{ node: TwitchChatMessageNode | null | undefined; cursor: string | null }> {
  const rawEdges = commentsObj.edges;

  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges.filter(
    (item): item is TwitchChatEdge => item !== null && typeof item === 'object' && 'node' in item && 'cursor' in item
  );
}

/**
 * Calculates the effective resume offset for chat download.
 * If no manual startOffset is provided, checks for existing chat data and resumes from the last saved offset.
 */
export async function calculateResumeOffset(
  db: Kysely<StreamerDB>,
  vodId: number,
  manualStartOffset?: number,
  forceRerun?: boolean
): Promise<{ offset: number; hasExistingData: boolean; lastMessageId?: string }> {
  if (manualStartOffset != null) {
    return { offset: manualStartOffset, hasExistingData: false };
  }

  if (forceRerun === true) {
    return { offset: 0, hasExistingData: false };
  }

  const lastSavedRecord = await db
    .selectFrom('chat_messages')
    .select(['id', 'content_offset_seconds'])
    .where('vod_id', '=', vodId)
    .orderBy('content_offset_seconds', 'desc')
    .executeTakeFirst();

  if (
    lastSavedRecord == null ||
    lastSavedRecord.content_offset_seconds == null ||
    lastSavedRecord.content_offset_seconds <= 0
  ) {
    return { offset: 0, hasExistingData: false };
  }

  const resumeOffset = lastSavedRecord.content_offset_seconds;
  return { offset: resumeOffset, hasExistingData: true, lastMessageId: lastSavedRecord.id };
}

export function extractMessageData(node: TwitchChatMessageNode | null | undefined): {
  message: TwitchEmoteFragment[];
  userBadges?: TwitchUserBadgesArray | undefined;
} {
  if (!node || !node.message) {
    return { message: [], userBadges: undefined };
  }

  const fragments = Array.isArray(node.message.fragments) ? node.message.fragments : [];
  const badgesRaw =
    node.message.userBadges && typeof node.message.userBadges === 'object' ? node.message.userBadges : undefined;

  return {
    message: fragments,
    userBadges: badgesRaw,
  };
}
