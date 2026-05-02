interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Parse DMCA claims from array or string representation.
 * Lenient - no validation, returns raw unknown[] for downstream processing.
 */
export function parseDmcaClaims(claims: DmcaClaim[] | string): unknown[] {
  return Array.isArray(claims)
    ? claims
    : (JSON.parse(typeof claims === 'string' ? claims : JSON.stringify(claims)) as unknown[]);
}
