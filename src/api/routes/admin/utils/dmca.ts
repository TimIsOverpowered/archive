import type { DMCAClaim } from '../../../../workers/dmca/dmca.js';

interface NewDmcaClaimInput {
  matchType: string;
  videoSegment: { startMillis: number | string; endMillis: number | string };
  claimId?: string;
  assetId?: string;
  asset?: Record<string, unknown>;
}

/**
 * Parse DMCA claims from array or string representation.
 * Expects the new format: { matchType, videoSegment: { startMillis, endMillis } }.
 */
export function parseDmcaClaims(claims: NewDmcaClaimInput[] | string): DMCAClaim[] {
  const arr: NewDmcaClaimInput[] = Array.isArray(claims) ? claims : (JSON.parse(claims) as NewDmcaClaimInput[]);

  return arr.map(
    (claim): DMCAClaim => ({
      matchType: claim.matchType as DMCAClaim['matchType'],
      videoSegment: {
        startMillis: Number(claim.videoSegment.startMillis),
        endMillis: Number(claim.videoSegment.endMillis),
      },
      ...(claim.claimId != null && { claimId: claim.claimId }),
      ...(claim.assetId != null && { assetId: claim.assetId }),
      ...(claim.asset != null && { asset: claim.asset }),
    })
  );
}
