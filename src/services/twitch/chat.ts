import type { InputJsonValue } from '../../../generated/streamer/internal/prismaNamespace.js';
import { createTwitchGqlClient } from './client.js';
import { stripTypename } from '../../workers/chat/chat-helpers.js';

function getTwitchGqlClient(tenantId?: string) {
  return createTwitchGqlClient(tenantId);
}

export interface TwitchEmoteFragment {
  __typename?: 'EmoteFragment';
  id: string;
  text: string | null;
}

export interface TwitchBadgeSetItem {
  __typename?: 'BadgeSetItem';
  badgeVersionId: string;
  setID: string;
}

export type TwitchUserBadgesArray = TwitchBadgeSetItem[];

export interface TwitchCommentMessageNode {
  __typename?: 'CommentMessageNode';
  emote: boolean | null;
  fragments: TwitchEmoteFragment[] | null;
  userBadges: TwitchUserBadgesArray | null;
  userColor: string | null;
}

export interface TwitchCommenterProfile {
  __typename?: 'UserProfile';
  displayName: string | null;
}

export interface TwitchChatMessageNode {
  __typename?: 'ChatMessageNode';
  id: string;
  commenter: TwitchCommenterProfile | null;
  contentOffsetSeconds: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  message: TwitchCommentMessageNode | null;
}

export interface TwitchChatEdge {
  __typename?: 'ChatEdge';
  cursor: string | null;
  node: TwitchChatMessageNode | null;
}

export interface TwitchCommentsConnection {
  __typename?: 'VideoCommentsConnection';
  edges: TwitchChatEdge[] | null;
}

export interface TwitchVideoCommentResponse {
  __typename?: 'VideoObject';
  id: string | null;
  comments: TwitchCommentsConnection | null;
}

export function extractMessageData(node: TwitchChatMessageNode | null | undefined): { message: InputJsonValue; userBadges?: InputJsonValue | undefined } {
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

export async function fetchComments(vodId: string, offset = 0, tenantId?: string): Promise<TwitchVideoCommentResponse | null> {
  const client = getTwitchGqlClient(tenantId);
  const data = await client.post<{ data?: { video?: TwitchVideoCommentResponse } }>({
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: {
      videoID: vodId,
      contentOffsetSeconds: offset,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
      },
    },
  });
  return data.data?.video || null;
}

export async function fetchNextComments(vodId: string, cursor: string, tenantId?: string): Promise<TwitchVideoCommentResponse | null> {
  const client = getTwitchGqlClient(tenantId);
  const data = await client.post<{ data?: { video?: TwitchVideoCommentResponse } }>({
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: {
      videoID: vodId,
      cursor: cursor,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
      },
    },
  });
  return data.data?.video || null;
}
