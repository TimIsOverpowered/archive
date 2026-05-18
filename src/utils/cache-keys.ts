function buildPaginatedQueryKey(
  namespace: string,
  tenantId: string,
  query: Record<string, string | number | undefined>,
  page: number,
  limit: number
): string {
  const sorted = Object.keys(query).sort();
  const parts = sorted
    .filter((k) => query[k] != null && query[k] !== '')
    .map((k) => `${k}:${encodeURIComponent(String(query[k]))}`);
  return [namespace, `{${tenantId}}`, ...parts, `page:${page}`, `limit:${limit}`].join(':');
}

export type SWRKey = string & { readonly __swr: unique symbol };
export type SimpleKey = string & { readonly __simple: unique symbol };

function swrKey(s: string): SWRKey {
  return s as SWRKey;
}

function simpleKey(s: string): SimpleKey {
  return s as SimpleKey;
}

const baseKeys = {
  vodStatic: (tenantId: string, dbId: number) => `vod:{${tenantId}}:${dbId}`,
  vodMeta: (tenantId: string, dbId: number) => `vod:meta:{${tenantId}}:${dbId}`,
  vodVolatile: (tenantId: string, dbId: number) => `vod:volatile:{${tenantId}}:${dbId}`,
  vodTags: (tenantId: string, dbId: number) => `vods:tags:{${tenantId}}:${dbId}`,
  bucketSize: (tenantId: string, vodId: number) => `{${tenantId}}:${vodId}:bucketSize`,
  bucket: (tenantId: string, vodId: number, bucket: number) => `{${tenantId}}:${vodId}:bucket:${bucket}`,
  cursor: (tenantId: string, vodId: number, cursor: string) => `{${tenantId}}:${vodId}:cursor:${cursor}`,
  emotes: (tenantId: string, vodId: number) => `emotes:{${tenantId}}:${vodId}`,
  badges: (tenantId: string) => `badges:{${tenantId}}`,
  vodPlatform: (tenantId: string, platform: string, platformVodId: string) =>
    `vod:platform:{${tenantId}}:${platform}:${platformVodId}`,
  vodQuery: (t: string, q: Record<string, string | number | undefined>, p: number, l: number) =>
    buildPaginatedQueryKey('vods', t, q, p, l),
  gameQuery: (t: string, q: Record<string, string | number | undefined>, p: number, l: number) =>
    buildPaginatedQueryKey('games', t, q, p, l),
  gameStatic: (tenantId: string, dbId: number) => `game:{${tenantId}}:${dbId}`,
  chapterLibrary: (t: string, q: Record<string, string | number | undefined>, p: number, l: number) =>
    buildPaginatedQueryKey('chapters', t, q, p, l),
  gameLibrary: (t: string, q: Record<string, string | number | undefined>, p: number, l: number) =>
    buildPaginatedQueryKey('games-library', t, q, p, l),
  stats: (tenantId: string) => `stats:${tenantId}`,
  tenantList: () => 'tenants:list',
  tenantDetail: (tenantId: string) => `tenants:detail:{${tenantId}}`,
};

export const CacheKeys = baseKeys;

function prefixKeys<T extends Record<string, (...args: never[]) => string>>(
  prefix: string,
  keys: T
): { [K in keyof T]: (...args: Parameters<T[K]>) => string } {
  const result = {} as { [K in keyof T]: (...args: Parameters<T[K]>) => string };
  for (const k of Object.keys(keys) as (keyof T)[]) {
    const fn = keys[k];
    if (fn == null) continue;
    result[k] = (...args: Parameters<T[typeof k]>) => `${prefix}${fn(...args)}`;
  }
  return result;
}

const swrRaw = prefixKeys('swr:', baseKeys);
const simpleRaw = prefixKeys('simple:', baseKeys);

export const swrKeys = {
  vodStatic: (...a: Parameters<typeof baseKeys.vodStatic>): SWRKey => swrKey(swrRaw.vodStatic(...a)),
  vodMeta: (...a: Parameters<typeof baseKeys.vodMeta>): SWRKey => swrKey(swrRaw.vodMeta(...a)),
  vodVolatile: (...a: Parameters<typeof baseKeys.vodVolatile>): SWRKey => swrKey(swrRaw.vodVolatile(...a)),
  vodTags: (...a: Parameters<typeof baseKeys.vodTags>): SWRKey => swrKey(swrRaw.vodTags(...a)),
  bucketSize: (...a: Parameters<typeof baseKeys.bucketSize>): SWRKey => swrKey(swrRaw.bucketSize(...a)),
  bucket: (...a: Parameters<typeof baseKeys.bucket>): SWRKey => swrKey(swrRaw.bucket(...a)),
  cursor: (...a: Parameters<typeof baseKeys.cursor>): SWRKey => swrKey(swrRaw.cursor(...a)),
  emotes: (...a: Parameters<typeof baseKeys.emotes>): SWRKey => swrKey(swrRaw.emotes(...a)),
  vodPlatform: (...a: Parameters<typeof baseKeys.vodPlatform>): SWRKey => swrKey(swrRaw.vodPlatform(...a)),
  vodQuery: (...a: Parameters<typeof baseKeys.vodQuery>): SWRKey => swrKey(swrRaw.vodQuery(...a)),
  gameQuery: (...a: Parameters<typeof baseKeys.gameQuery>): SWRKey => swrKey(swrRaw.gameQuery(...a)),
  gameStatic: (...a: Parameters<typeof baseKeys.gameStatic>): SWRKey => swrKey(swrRaw.gameStatic(...a)),
  chapterLibrary: (...a: Parameters<typeof baseKeys.chapterLibrary>): SWRKey => swrKey(swrRaw.chapterLibrary(...a)),
  gameLibrary: (...a: Parameters<typeof baseKeys.gameLibrary>): SWRKey => swrKey(swrRaw.gameLibrary(...a)),
  stats: (...a: Parameters<typeof baseKeys.stats>): SWRKey => swrKey(swrRaw.stats(...a)),
} as const;

export const simpleKeys = {
  vodStatic: (...a: Parameters<typeof baseKeys.vodStatic>): SimpleKey => simpleKey(simpleRaw.vodStatic(...a)),
  vodMeta: (...a: Parameters<typeof baseKeys.vodMeta>): SimpleKey => simpleKey(simpleRaw.vodMeta(...a)),
  vodVolatile: (...a: Parameters<typeof baseKeys.vodVolatile>): SimpleKey => simpleKey(simpleRaw.vodVolatile(...a)),
  vodTags: (...a: Parameters<typeof baseKeys.vodTags>): SimpleKey => simpleKey(simpleRaw.vodTags(...a)),
  bucketSize: (...a: Parameters<typeof baseKeys.bucketSize>): SimpleKey => simpleKey(simpleRaw.bucketSize(...a)),
  bucket: (...a: Parameters<typeof baseKeys.bucket>): SimpleKey => simpleKey(simpleRaw.bucket(...a)),
  cursor: (...a: Parameters<typeof baseKeys.cursor>): SimpleKey => simpleKey(simpleRaw.cursor(...a)),
  emotes: (...a: Parameters<typeof baseKeys.emotes>): SimpleKey => simpleKey(simpleRaw.emotes(...a)),
  badges: (...a: Parameters<typeof baseKeys.badges>): SimpleKey => simpleKey(simpleRaw.badges(...a)),
  vodPlatform: (...a: Parameters<typeof baseKeys.vodPlatform>): SimpleKey => simpleKey(simpleRaw.vodPlatform(...a)),
  vodQuery: (...a: Parameters<typeof baseKeys.vodQuery>): SimpleKey => simpleKey(simpleRaw.vodQuery(...a)),
  gameQuery: (...a: Parameters<typeof baseKeys.gameQuery>): SimpleKey => simpleKey(simpleRaw.gameQuery(...a)),
  gameStatic: (...a: Parameters<typeof baseKeys.gameStatic>): SimpleKey => simpleKey(simpleRaw.gameStatic(...a)),
  chapterLibrary: (...a: Parameters<typeof baseKeys.chapterLibrary>): SimpleKey =>
    simpleKey(simpleRaw.chapterLibrary(...a)),
  gameLibrary: (...a: Parameters<typeof baseKeys.gameLibrary>): SimpleKey => simpleKey(simpleRaw.gameLibrary(...a)),
  stats: (...a: Parameters<typeof baseKeys.stats>): SimpleKey => simpleKey(simpleRaw.stats(...a)),
  tenantList: (...a: Parameters<typeof baseKeys.tenantList>): SimpleKey => simpleKey(simpleRaw.tenantList(...a)),
  tenantDetail: (...a: Parameters<typeof baseKeys.tenantDetail>): SimpleKey => simpleKey(simpleRaw.tenantDetail(...a)),
} as const;
