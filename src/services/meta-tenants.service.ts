import type { ExpressionBuilder } from 'kysely';
import { YouTube } from '../constants.ts';
import { getMetaClient } from '../db/meta-client.ts';
import type { InsertableTenants, MetaDB, SelectableTenants, UpdateableTenants } from '../db/meta-types.ts';
import { encryptObject, encryptScalar } from '../utils/encryption.ts';

const tenantColumns = [
  'id',
  'display_name',
  'profile_image_url',
  'banner_image_url',
  'background_image_url',
  'twitch',
  'youtube',
  'kick',
  'social_media',
  'database_name',
  'settings',
  'status',
  'created_at',
  'updated_at',
] as const;

export interface PublicTenantCdn {
  enabled: boolean;
  baseUrl: string;
}

export interface PublicTenant {
  id: string;
  display_name: string | null;
  profile_image_url: string | null;
  banner_image_url: string | null;
  background_image_url: string | null;
  created_at: Date;
  status: string;
  platforms: Array<{ name: string; enabled: boolean; id: string | null }>;
  social_media: Array<{ name: string; url: string }>;
  default_delay: number;
  games: boolean;
  vods: boolean;
  cdn: PublicTenantCdn;
}

function toPublicTenant(tenant: SelectableTenants): PublicTenant {
  const platforms: PublicTenant['platforms'] = [];

  const twitch = tenant.twitch;
  if (twitch != null && typeof twitch === 'object' && !Array.isArray(twitch)) {
    const t = twitch;
    platforms.push({
      name: 'twitch',
      enabled: t.enabled === true,
      id: (typeof t.id === 'string' ? t.id : null) ?? null,
    });
  }

  const kick = tenant.kick;
  if (kick != null && typeof kick === 'object' && !Array.isArray(kick)) {
    const k = kick;
    platforms.push({
      name: 'kick',
      enabled: k.enabled === true,
      id: (typeof k.id === 'string' ? k.id : null) ?? null,
    });
  }

  const social_media: PublicTenant['social_media'] = [];
  const sm = tenant.social_media;
  if (sm != null && typeof sm === 'object' && !Array.isArray(sm)) {
    for (const [name, url] of Object.entries(sm).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (typeof url === 'string' && url !== '') {
        social_media.push({ name, url });
      }
    }
  }

  let default_delay: number = YouTube.DEFAULT_SPLIT_DURATION;
  let games: boolean = false;
  let vods: boolean = false;
  const youtube = tenant.youtube;
  if (youtube != null && typeof youtube === 'object' && !Array.isArray(youtube)) {
    const sd = youtube.splitDuration;
    if (typeof sd === 'number') {
      default_delay = sd;
    }
    if (youtube.perGameUpload === true) {
      games = true;
    }
    if (youtube.vodUpload === true || youtube.multiTrack === true) {
      vods = true;
    }
  }

  const cdn: PublicTenantCdn = { enabled: false, baseUrl: '' };
  const settings = tenant.settings;
  if (settings != null && typeof settings === 'object' && !Array.isArray(settings)) {
    const sCdn = settings.cdn;
    if (sCdn != null && typeof sCdn === 'object' && !Array.isArray(sCdn)) {
      const cdnObj = sCdn as Record<string, unknown>;
      if (cdnObj.enabled === true) cdn.enabled = true;
      if (typeof cdnObj.baseUrl === 'string' && cdnObj.baseUrl !== '') cdn.baseUrl = cdnObj.baseUrl;
    }
  }

  return {
    id: tenant.id,
    display_name: tenant.display_name,
    profile_image_url: tenant.profile_image_url,
    banner_image_url: tenant.banner_image_url,
    background_image_url: tenant.background_image_url,
    created_at: tenant.created_at,
    status: tenant.status,
    platforms,
    social_media,
    default_delay,
    games,
    vods,
    cdn,
  };
}

function encryptYoutubeFields(youtube: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (youtube == null) return undefined;

  const result = { ...youtube };

  if (result.auth != null && typeof result.auth === 'object' && !Array.isArray(result.auth)) {
    result.auth = encryptObject(result.auth);
  }

  if (typeof result.apiKey === 'string' && result.apiKey !== '') {
    result.apiKey = encryptScalar(result.apiKey);
  }

  return result;
}

function encryptYoutubeInData(data: InsertableTenants): InsertableTenants;
function encryptYoutubeInData(data: Partial<InsertableTenants>): Partial<InsertableTenants>;
function encryptYoutubeInData(data: Partial<InsertableTenants>): Partial<InsertableTenants> {
  const encrypted = { ...data };

  if (encrypted.youtube != null && typeof encrypted.youtube === 'object') {
    if (typeof encrypted.youtube === 'string') {
      try {
        const parsed = JSON.parse(encrypted.youtube) as Record<string, unknown>;
        encrypted.youtube = JSON.stringify(encryptYoutubeFields(parsed));
      } catch {
        // not valid JSON, leave as-is
      }
    } else {
      encrypted.youtube = JSON.stringify(encryptYoutubeFields(encrypted.youtube));
    }
  }

  return encrypted;
}

function stripEncryptedFields(tenant: SelectableTenants): SelectableTenants {
  const youtube = tenant.youtube;
  if (youtube != null) {
    const { auth: _auth, apiKey: _apiKey, ...safeYoutube } = youtube;
    return { ...tenant, youtube: Object.keys(safeYoutube).length > 0 ? safeYoutube : null };
  }
  return tenant;
}

/** Retrieve all tenants from the metadata database (encrypted fields stripped for API responses). */
export async function getAllTenants(): Promise<SelectableTenants[]> {
  const tenants = await getMetaClient().selectFrom('tenants').selectAll().execute();
  return tenants.map(stripEncryptedFields);
}

/** Retrieve all tenants from the metadata database without stripping encrypted fields. */
export async function getAllTenantsRaw(): Promise<SelectableTenants[]> {
  const tenants = await getMetaClient().selectFrom('tenants').selectAll().execute();
  return tenants;
}

/** Look up a tenant by ID from the metadata database (encrypted fields stripped for API responses). */
export async function getTenantById(id: string): Promise<SelectableTenants | undefined> {
  const tenant = await getMetaClient().selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  return tenant ? stripEncryptedFields(tenant) : undefined;
}

/** Look up a tenant by ID from the metadata database without stripping encrypted fields. */
export async function getTenantByIdRaw(id: string): Promise<SelectableTenants | undefined> {
  const tenant = await getMetaClient().selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  return tenant;
}

/** Create a new tenant record in the metadata database. */
export async function createTenant(data: InsertableTenants): Promise<SelectableTenants> {
  const encrypted = encryptYoutubeInData(data);

  return getMetaClient()
    .insertInto('tenants')
    .values({
      ...encrypted,
      updated_at: new Date(),
    })
    .returning(tenantColumns)
    .executeTakeFirstOrThrow();
}

/**
 * Merge an incoming (plaintext) youtube payload with the existing (already-encrypted)
 * row. Only the auth/apiKey sub-keys the client actually supplied are encrypted;
 * carried-over encrypted values are left untouched so they are never re-encrypted.
 * Returns the merged value as a JSON string for the jsonb column.
 */
function mergeYoutube(existing: Record<string, unknown> | null, incoming: Record<string, unknown>): string {
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...incoming };

  if (incoming.auth != null && typeof incoming.auth === 'object' && !Array.isArray(incoming.auth)) {
    merged.auth = encryptObject(incoming.auth);
  }

  if (typeof incoming.apiKey === 'string' && incoming.apiKey !== '') {
    merged.apiKey = encryptScalar(incoming.apiKey);
  }

  return JSON.stringify(merged);
}

/** Update an existing tenant record by ID. */
export async function updateTenant(
  id: string,
  data: Partial<InsertableTenants>
): Promise<SelectableTenants | undefined> {
  const existing = await getTenantByIdRaw(id);

  const incomingYoutube = data.youtube;
  if (incomingYoutube != null && typeof incomingYoutube === 'object' && !Array.isArray(incomingYoutube)) {
    const existingYoutube =
      existing?.youtube != null && typeof existing.youtube === 'object' && !Array.isArray(existing.youtube)
        ? existing.youtube
        : null;
    (data as Record<string, unknown>).youtube = mergeYoutube(existingYoutube, incomingYoutube);
  }

  const jsonbFields: Array<'twitch' | 'kick' | 'settings' | 'social_media'> = [
    'twitch',
    'kick',
    'settings',
    'social_media',
  ];
  for (const field of jsonbFields) {
    if (data[field] != null && existing?.[field] != null) {
      const existingRaw = existing[field];
      if (typeof existingRaw === 'object' && !Array.isArray(existingRaw)) {
        (data as Record<string, unknown>)[field] = {
          ...(existingRaw as unknown as Record<string, unknown>),
          ...(data[field] as unknown as Record<string, unknown>),
        };
      }
    }
  }

  return getMetaClient()
    .updateTable('tenants')
    .set({ ...data, updated_at: new Date() } as UpdateableTenants)
    .where('id', '=', id)
    .returning(tenantColumns)
    .executeTakeFirst();
}

/** Delete a tenant record by ID. */
export async function deleteTenant(id: string): Promise<void> {
  await getMetaClient().deleteFrom('tenants').where('id', '=', id).execute();
}

/** Retrieve all tenants with only public fields (no platform configs, no encrypted fields). */
export async function getAllPublicTenants(): Promise<PublicTenant[]> {
  const tenants = await getMetaClient().selectFrom('tenants').selectAll().execute();
  return tenants.map(toPublicTenant);
}

/** Retrieve tenants with only public fields, paginated. */
export async function getAllPublicTenantsPaginated(opts: {
  page: number;
  limit: number;
  search?: string;
}): Promise<{ tenants: PublicTenant[]; total: number }> {
  const { page, limit, search } = opts;
  const offset = (page - 1) * limit;

  const searchWhere =
    search != null && search !== ''
      ? (eb: ExpressionBuilder<MetaDB, 'tenants'>) => eb('id', 'ilike', `%${search}%`)
      : undefined;

  const [result, totalRow] = await Promise.all([
    getMetaClient()
      .selectFrom('tenants')
      .selectAll()
      .where(searchWhere ?? ((eb) => eb.lit(true)))
      .orderBy('id', 'asc')
      .limit(limit + 1)
      .offset(offset)
      .execute(),
    getMetaClient()
      .selectFrom('tenants')
      .select((eb) => [eb.fn.count('id').as('cnt')])
      .where(searchWhere ?? ((eb) => eb.lit(true)))
      .executeTakeFirst(),
  ]);

  const total = Number(totalRow?.cnt ?? 0);
  const hasMore = result.length > limit;
  const tenants = hasMore ? result.slice(0, limit) : result;

  return { tenants: tenants.map(toPublicTenant), total };
}

/** Retrieve a single tenant by ID with only public fields. */
export async function getPublicTenantById(id: string): Promise<PublicTenant | undefined> {
  const tenant = await getMetaClient().selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  return tenant ? toPublicTenant(tenant) : undefined;
}
