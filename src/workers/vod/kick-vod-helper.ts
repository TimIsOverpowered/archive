import { getVod } from '../../services/kick.js';
import type { TenantConfig } from '../../config/types.js';

export async function getKickSourceUrl(config: TenantConfig, vodId: string): Promise<string | undefined> {
  const username = config?.kick?.username;

  if (!username) {
    throw new Error('Kick username not configured for streamer');
  }

  const vodMetadata = await getVod(username, vodId);

  if (!vodMetadata?.source) {
    throw new Error('VOD source URL not available');
  }

  return vodMetadata.source;
}
