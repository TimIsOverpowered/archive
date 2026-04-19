import { getMetaClient } from '../db/meta-client.js';

export async function validateApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey || !apiKey.startsWith('archive_')) {
    return false;
  }

  const admin = await getMetaClient().admin.findFirst({
    where: { api_key: apiKey },
  });

  return admin !== null;
}
