import { z } from 'zod';
import type { Tenant } from '../../prisma/generated/meta/client.js';
import { TwitchAuthSchema, TwitchSchema, YoutubeAuthSchema, YoutubeSchema, KickSchema } from '../config/schemas.js';

export function getTwitchConfig(tenant: Tenant): z.infer<typeof TwitchSchema> | null {
  if (!tenant.twitch) {
    return null;
  }

  try {
    return TwitchSchema.parse(tenant.twitch);
  } catch {
    return null;
  }
}

export function getTwitchAuth(tenant: Tenant): z.infer<typeof TwitchAuthSchema> | null {
  const twitchConfig = getTwitchConfig(tenant);

  if (!twitchConfig || !twitchConfig.auth) {
    return null;
  }

  try {
    const decrypted = JSON.parse(twitchConfig.auth);
    return TwitchAuthSchema.parse(decrypted);
  } catch {
    return null;
  }
}

export function getYoutubeConfig(tenant: Tenant): z.infer<typeof YoutubeSchema> | null {
  if (!tenant.youtube) {
    return null;
  }

  try {
    return YoutubeSchema.parse(tenant.youtube);
  } catch {
    return null;
  }
}

export function getYoutubeAuth(tenant: Tenant): z.infer<typeof YoutubeAuthSchema> | null {
  const youtubeConfig = getYoutubeConfig(tenant);

  if (!youtubeConfig || !youtubeConfig.auth) {
    return null;
  }

  try {
    const decrypted = JSON.parse(youtubeConfig.auth);
    return YoutubeAuthSchema.parse(decrypted);
  } catch {
    return null;
  }
}

export function getKickConfig(tenant: Tenant): z.infer<typeof KickSchema> | null {
  if (!tenant.kick) {
    return null;
  }

  try {
    return KickSchema.parse(tenant.kick);
  } catch {
    return null;
  }
}
