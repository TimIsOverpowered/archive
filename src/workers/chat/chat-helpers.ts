import type { TwitchChatEdge, TwitchChatMessageNode, TwitchCommentsConnection } from '../../services/twitch/index.js';
import type { PrismaClient } from '../../../generated/streamer/client';
import { InputJsonValue } from '../../../generated/streamer/internal/prismaNamespace.js';

/**
 * Removes __typename fields from GraphQL response objects recursively.
 * Useful for cleaning GraphQL responses before storing in database.
 */
export function stripTypename(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => stripTypename(item));
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '__typename') {
        cleaned[key] = stripTypename(value);
      }
    }
    return cleaned;
  }
  return obj;
}

/**
 * Extracts edges from GraphQL pagination response.
 * Type-safe extraction that filters valid edges at runtime.
 */
export function extractEdges(commentsObj: TwitchCommentsConnection): Array<{ node: TwitchChatMessageNode | null | undefined; cursor: string | null }> {
  const rawEdges = commentsObj.edges;

  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges.filter((item): item is TwitchChatEdge => item !== null && typeof item === 'object' && 'node' in item && 'cursor' in item);
}

/**
 * Calculates the effective resume offset for chat download.
 * If no manual startOffset is provided, checks for existing chat data and resumes from the last saved offset.
 */
export async function calculateResumeOffset(db: PrismaClient, vodId: number, manualStartOffset?: number): Promise<{ offset: number; hasExistingData: boolean; lastMessageId?: string }> {
  if (manualStartOffset) {
    return { offset: manualStartOffset, hasExistingData: false };
  }

  const lastSavedRecord = await db.chatMessage.findFirst({
    where: { vod_id: vodId },
    orderBy: { content_offset_seconds: 'desc' },
    select: { id: true, content_offset_seconds: true },
  });

  if (!lastSavedRecord?.content_offset_seconds) {
    return { offset: 0, hasExistingData: false };
  }

  const resumeOffset = lastSavedRecord.content_offset_seconds;
  return { offset: resumeOffset, hasExistingData: true, lastMessageId: lastSavedRecord.id };
}

export function extractMessageData(node: TwitchChatMessageNode | null | undefined): { message: InputJsonValue; userBadges?: InputJsonValue } {
  if (!node || !node.message) {
    return { message: { content: '', fragments: [] }, userBadges: undefined };
  }

  const rawFragments = node.message.fragments || [];
  const cleanFragments = stripTypename(rawFragments);
  const badgesRaw = node.message.userBadges ?? null;

  return {
    message: {
      content: (Array.isArray(cleanFragments) ? cleanFragments : [])
        .map((f: unknown) => {
          if (typeof f !== 'object' || f === null) return '';
          const text = (f as Record<string, unknown>).text;
          return String(text ?? '');
        })
        .join(''),
      fragments: Array.isArray(cleanFragments) ? cleanFragments.map((frag) => ({ ...frag })) : [],
    },
    userBadges: badgesRaw && typeof stripTypename(badgesRaw) === 'object' ? (stripTypename(badgesRaw) as InputJsonValue) : undefined,
  };
}
