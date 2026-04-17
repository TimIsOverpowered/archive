export { getYoutubeCredentials, updateYoutubeTokenInDb, REDIRECT_URI } from './auth.js';
export type { AuthObject, DecryptedYoutubeCreds } from './auth.js';

export { createYoutubeClient } from './client.js';
export type { YoutubeClient } from './client.js';

export { uploadVideo } from './upload.js';
export type { UploadProgressCallbackData, YoutubeUploadProgress } from './upload.js';

export { linkParts } from './metadata.js';
