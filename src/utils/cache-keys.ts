function buildVodQueryKey(
  tenantId: string,
  query: Record<string, string | number | undefined>,
  page: number,
  limit: number
): string {
  const sorted = Object.keys(query).sort();
  const queryParts = sorted
    .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
    .map((k) => `${k}:${encodeURIComponent(String(query[k]))}`);
  return ['vods', `{${tenantId}}`, ...queryParts, `page:${page}`, `limit:${limit}`].join(':');
}

export const CacheKeys = {
  vodStatic: (tenantId: string, dbId: number) => `vod:{${tenantId}}:${dbId}`,
  vodVolatile: (tenantId: string, dbId: number) => `vod:volatile:{${tenantId}}:${dbId}`,
  vodTags: (tenantId: string, dbId: number) => `vods:tags:{${tenantId}}:${dbId}`,
  bucketSize: (tenantId: string, vodId: number) => `{${tenantId}}:${vodId}:bucketSize`,
  bucket: (tenantId: string, vodId: number, bucket: number) => `{${tenantId}}:${vodId}:bucket:${bucket}`,
  cursor: (tenantId: string, vodId: number, cursor: string) => `{${tenantId}}:${vodId}:cursor:${cursor}`,
  emotes: (tenantId: string, vodId: number) => `emotes:{${tenantId}}:${vodId}`,
  vodPlatform: (tenantId: string, platform: string, platformVodId: string) =>
    `vod:platform:{${tenantId}}:${platform}:${platformVodId}`,
  vodQuery: buildVodQueryKey,
} as const;
