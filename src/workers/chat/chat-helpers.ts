import type { TwitchChatMessageNode } from '../../services/twitch.js';

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
export function extractEdges(commentsObj: Record<string, unknown>): Array<{ node: TwitchChatMessageNode | null | undefined; cursor: string | null }> {
  const rawEdges = commentsObj.edges;

  if (!Array.isArray(rawEdges)) {
    return [];
  }

  return rawEdges.filter((item): item is { node: TwitchChatMessageNode | null | undefined; cursor: string | null } => item !== null && typeof item === 'object' && 'node' in item && 'cursor' in item);
}
