import ipaddr from 'ipaddr.js';
import { getBaseConfig } from '../config/env.js';
import { Cloudflare } from '../constants.js';
import { RedisService } from '../utils/redis-service.js';
import { request } from './http-client.js';
import { getLogger } from './logger.js';

const CF_IP_RANGES_KEY = 'cloudflare:ip_ranges';
const CF_IP_V4_URL = 'https://www.cloudflare.com/ips-v4';
const CF_IP_V6_URL = 'https://www.cloudflare.com/ips-v6';

export interface CloudflareIpRanges {
  v4: string[];
  v6: string[];
  lastUpdated: number;
}

export interface CloudflareCacheInfo {
  status: 'ok' | 'missing' | 'error';
  lastUpdated?: number;
  ttlRemaining?: number;
  v4Count?: number;
  v6Count?: number;
}

/** Fetch Cloudflare IP ranges from official source */
async function fetchCloudflareIpRanges(): Promise<CloudflareIpRanges> {
  const [v4Response, v6Response] = await Promise.all([
    request(CF_IP_V4_URL, { responseType: 'text' }),
    request(CF_IP_V6_URL, { responseType: 'text' }),
  ]);

  return {
    v4: v4Response
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    v6: v6Response
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    lastUpdated: Date.now(),
  };
}

/** Get from Redis cache or fetch fresh */
export async function getCloudflareIpRanges(): Promise<CloudflareIpRanges | null> {
  const client = RedisService.getActiveClient();
  if (client) {
    try {
      const cached = await client.get(CF_IP_RANGES_KEY);
      if (cached != null && cached !== '') {
        return JSON.parse(cached) as CloudflareIpRanges;
      }
    } catch {
      // Ignore cache errors
    }
  }

  const ranges = await fetchCloudflareIpRanges();

  if (client) {
    try {
      await client.set(CF_IP_RANGES_KEY, JSON.stringify(ranges), 'EX', Cloudflare.IP_RANGES_TTL);
    } catch {
      // Ignore cache errors
    }
  }

  return ranges;
}

/** Check if IP is within Cloudflare ranges */
function isFromCloudflare(ip: string, ranges?: CloudflareIpRanges): boolean {
  try {
    const parsed = ipaddr.parse(ip);
    const ipKind = parsed.kind();
    const cidrList = ranges != null ? (ipKind === 'ipv6' ? ranges.v6 : ranges.v4) : null;

    if (cidrList == null || cidrList.length === 0) {
      return false;
    }

    return cidrList.some((cidr) => {
      try {
        const [rangeIp, rangeMask] = cidr.split('/');
        if (rangeIp == null || rangeIp === '') return false;
        const rangeParsed = ipaddr.parse(rangeIp);
        if (rangeParsed.kind() !== ipKind) {
          return false;
        }
        const subnet = ipaddr.parseCIDR(cidr);
        return parsed.match(subnet, Number(rangeMask ?? 0));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Validate request is actually from Cloudflare */
export async function validateCloudflareRequest(request: {
  headers: Record<string, string | string[] | undefined>;
  raw: { socket?: { remoteAddress?: string | undefined } };
  url?: string | undefined;
  ips?: string[];
}): Promise<boolean> {
  if (getBaseConfig().NODE_ENV !== 'production') {
    return true;
  }

  if (getBaseConfig().REQUIRE_CLOUDFLARE_IP === false) {
    return true;
  }

  const cfIp = request.headers['cf-connecting-ip'] as string | undefined;
  if (cfIp == null || cfIp === '') {
    return true;
  }

  const ranges = await getCloudflareIpRanges();
  if (!ranges) {
    return true;
  }

  // 1. Check the proxy chain first (supports: Cloudflare -> Nginx -> App)
  if (request.ips && request.ips.length > 0) {
    for (const ip of request.ips) {
      if (isFromCloudflare(ip, ranges)) {
        return true;
      }
    }
  }

  // 2. Check the raw socket (supports: Cloudflare -> App directly)
  const remoteAddress = request.raw.socket?.remoteAddress;
  if (remoteAddress != null && remoteAddress !== '' && isFromCloudflare(remoteAddress, ranges)) {
    return true;
  }

  getLogger().warn(
    { component: 'cloudflare-ip-validator', ip: cfIp, remoteAddress },
    'Request not from Cloudflare IP range'
  );

  return false;
}

/** Get cache info for health endpoint */
export async function getCachedRangeInfo(): Promise<CloudflareCacheInfo | null> {
  const client = RedisService.getActiveClient();
  if (!client) {
    return null;
  }

  try {
    const cached = await client.get(CF_IP_RANGES_KEY);
    if (cached == null || cached === '') {
      return { status: 'missing' };
    }

    const ranges = JSON.parse(cached) as CloudflareIpRanges;
    const age = Date.now() - ranges.lastUpdated;
    const ttlRemaining = Math.max(0, Cloudflare.IP_RANGES_TTL * 1000 - age);

    return {
      status: 'ok',
      lastUpdated: ranges.lastUpdated,
      ttlRemaining: Math.floor(ttlRemaining / 1000),
      v4Count: ranges.v4.length,
      v6Count: ranges.v6.length,
    };
  } catch {
    return { status: 'error' };
  }
}

/** Manual refresh trigger (for cron) */
export async function refreshCloudflareRanges(): Promise<void> {
  const ranges = await fetchCloudflareIpRanges();
  const client = RedisService.getActiveClient();

  if (client) {
    await client.set(CF_IP_RANGES_KEY, JSON.stringify(ranges), 'EX', Cloudflare.IP_RANGES_TTL);
  }

  getLogger().info({ v4Count: ranges.v4.length, v6Count: ranges.v6.length }, 'Cloudflare IP ranges refreshed');
}
