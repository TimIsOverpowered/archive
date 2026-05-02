/** Options for building a conditional VOD job response. */
export interface BuildVodJobResponseOptions {
  /** Whether a download job was queued (true = needs download, false = file already exists) */
  hasDownload: boolean;
  /** Path to the VOD file (used when hasDownload is false) */
  filePath?: string | undefined;
  /** ID of the downstream job (DMCA processing, YouTube upload, etc.) */
  downstreamJobId: string;
  /** Label for the downstream job (e.g. 'DMCA processing', 'YouTube upload') */
  downstreamLabel: string;
  /** Base fields included in all responses (dbId, vodId, gameId, etc.) */
  base?: Record<string, unknown> | undefined;
  /** Additional fields to include in both response branches */
  extra?: Record<string, unknown> | undefined;
}

/**
 * Builds a conditional response based on whether a VOD download was queued.
 *
 * When download is needed: returns message indicating downstream job will run after download completes.
 * When file already exists: returns message indicating downstream job is queued.
 */
export function buildVodJobResponse(opts: BuildVodJobResponseOptions): { data: Record<string, unknown> } {
  const { hasDownload, filePath, downstreamJobId, downstreamLabel, base = {}, extra = {} } = opts;

  if (hasDownload) {
    return {
      data: {
        message: `VOD download queued, ${downstreamLabel} will be triggered after completion`,
        downloadJobId: null,
        downstreamJobId,
        ...base,
        ...extra,
      },
    };
  }

  return {
    data: {
      message: `${downstreamLabel} queued!`,
      filePath,
      downstreamJobId,
      ...base,
      ...extra,
    },
  };
}
