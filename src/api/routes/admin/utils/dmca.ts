interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Parse DMCA claims from array or string representation.
 * Coerces matchDetails numeric fields (returned as strings by YouTube API) to integers at deserialization time.
 */
export function parseDmcaClaims(claims: DmcaClaim[] | string): unknown[] {
  const arr: DmcaClaim[] = Array.isArray(claims) ? claims : (JSON.parse(claims) as DmcaClaim[]);
  return arr.map((claim) => {
    const md = claim.matchDetails as Record<string, unknown> | undefined;
    if (!md) return claim;

    return {
      ...claim,
      matchDetails: {
        ...md,
        longestMatchStartTimeSeconds: parseInt(String(md.longestMatchStartTimeSeconds), 10),
        longestMatchDurationSeconds: parseInt(String(md.longestMatchDurationSeconds), 10),
      },
    };
  });
}
