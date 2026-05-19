import { YouTube } from '../constants.js';
import { getMetaClient } from '../db/meta-client.js';
import type { InsertableTenants, SelectableTenants, UpdateableTenants } from '../db/meta-types.js';
import { encryptObject, encryptScalar } from '../utils/encryption.js';

const tenantColumns = [
  'id',
  'display_name',
  'profile_image_url',
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
  created_at: Date;
  status: string;
  platforms: Array<{ name: string; enabled: boolean; id: string | null }>;
  social_media: Array<{ name: string; url: string }>;
  default_delay: number;
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
    for (const [name, url] of Object.entries(sm)) {
      if (typeof url === 'string' && url !== '') {
        social_media.push({ name, url });
      }
    }
  }

  let default_delay: number = YouTube.DEFAULT_SPLIT_DURATION;
  const youtube = tenant.youtube;
  if (youtube != null && typeof youtube === 'object' && !Array.isArray(youtube)) {
    const sd = youtube.splitDuration;
    if (typeof sd === 'number') {
      default_delay = sd;
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
    created_at: tenant.created_at,
    status: tenant.status,
    platforms,
    social_media,
    default_delay,
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

/** Update an existing tenant record by ID. */
export async function updateTenant(
  id: string,
  data: Partial<InsertableTenants>
): Promise<SelectableTenants | undefined> {
  const encrypted = encryptYoutubeInData(data);

  return getMetaClient()
    .updateTable('tenants')
    .set({ ...encrypted, updated_at: new Date() } as UpdateableTenants)
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
}): Promise<{ tenants: PublicTenant[]; total: number }> {
  const { page, limit } = opts;
  const offset = (page - 1) * limit;

  const [result, totalRow] = await Promise.all([
    getMetaClient()
      .selectFrom('tenants')
      .selectAll()
      .limit(limit + 1)
      .offset(offset)
      .execute(),
    getMetaClient()
      .selectFrom('tenants')
      .select((eb) => [eb.fn.count('id').as('cnt')])
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
