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

export type SWRKey = string & { readonly __swr: unique symbol };
export type SimpleKey = string & { readonly __simple: unique symbol };

function swrKey(s: string): SWRKey {
  return s as SWRKey;
}

function simpleKey(s: string): SimpleKey {
  return s as SimpleKey;
}

export const swrKeys = {
  vodStatic: (tenantId: string, dbId: number): SWRKey => swrKey(`vod:{${tenantId}}:${dbId}`),
  vodVolatile: (tenantId: string, dbId: number): SWRKey => swrKey(`vod:volatile:{${tenantId}}:${dbId}`),
  vodTags: (tenantId: string, dbId: number): SWRKey => swrKey(`vods:tags:{${tenantId}}:${dbId}`),
  bucketSize: (tenantId: string, vodId: number): SWRKey => swrKey(`{${tenantId}}:${vodId}:bucketSize`),
  bucket: (tenantId: string, vodId: number, bucket: number): SWRKey =>
    swrKey(`{${tenantId}}:${vodId}:bucket:${bucket}`),
  cursor: (tenantId: string, vodId: number, cursor: string): SWRKey =>
    swrKey(`{${tenantId}}:${vodId}:cursor:${cursor}`),
  emotes: (tenantId: string, vodId: number): SWRKey => swrKey(`emotes:{${tenantId}}:${vodId}`),
  vodPlatform: (tenantId: string, platform: string, platformVodId: string): SWRKey =>
    swrKey(`vod:platform:{${tenantId}}:${platform}:${platformVodId}`),
  vodQuery: (
    tenantId: string,
    query: Record<string, string | number | undefined>,
    page: number,
    limit: number
  ): SWRKey => swrKey(buildVodQueryKey(tenantId, query, page, limit)),
  stats: (tenantId: string): SWRKey => swrKey(`stats:${tenantId}`),
} as const;

export const simpleKeys = {
  vodStatic: (tenantId: string, dbId: number): SimpleKey => simpleKey(`vod:{${tenantId}}:${dbId}`),
  vodVolatile: (tenantId: string, dbId: number): SimpleKey => simpleKey(`vod:volatile:{${tenantId}}:${dbId}`),
  vodTags: (tenantId: string, dbId: number): SimpleKey => simpleKey(`vods:tags:{${tenantId}}:${dbId}`),
  bucketSize: (tenantId: string, vodId: number): SimpleKey => simpleKey(`{${tenantId}}:${vodId}:bucketSize`),
  bucket: (tenantId: string, vodId: number, bucket: number): SimpleKey =>
    simpleKey(`{${tenantId}}:${vodId}:bucket:${bucket}`),
  cursor: (tenantId: string, vodId: number, cursor: string): SimpleKey =>
    simpleKey(`{${tenantId}}:${vodId}:cursor:${cursor}`),
  emotes: (tenantId: string, vodId: number): SimpleKey => simpleKey(`emotes:{${tenantId}}:${vodId}`),
  vodPlatform: (tenantId: string, platform: string, platformVodId: string): SimpleKey =>
    simpleKey(`vod:platform:{${tenantId}}:${platform}:${platformVodId}`),
  vodQuery: (
    tenantId: string,
    query: Record<string, string | number | undefined>,
    page: number,
    limit: number
  ): SimpleKey => simpleKey(buildVodQueryKey(tenantId, query, page, limit)),
  stats: (tenantId: string): SimpleKey => simpleKey(`stats:${tenantId}`),
} as const;

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
