// Auth
export { getAppAccessToken, updateTwitchTokenInDb } from './auth.js';

// Client
export { createTwitchClient, type TwitchClient } from './client.js';

// VOD
export { getVodData, getVodTokenSig, getM3u8, type VodData } from './vod.js';

// Chapters
export { getChapters, getChapter, getGameData, saveVodChapters } from './chapters.js';

// Chat
export {
  fetchComments,
  fetchNextComments,
  type TwitchEmoteFragment,
  type TwitchBadgeSetItem,
  type TwitchUserBadgesArray,
  type TwitchCommentMessageNode,
  type TwitchCommenterProfile,
  type TwitchChatMessageNode,
  type TwitchChatEdge,
  type TwitchCommentsConnection,
  type TwitchVideoCommentResponse,
} from './chat.js';

// Badges
export { getChannelBadges, getGlobalBadges } from './badges.js';

// Live
export { getTwitchStreamStatus, getLatestTwitchVodObject, type TwitchStreamStatus } from './live.js';
