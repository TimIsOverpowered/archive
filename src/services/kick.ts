import fsPromises from 'fs/promises';
import { getKickBrowser } from '../utils/puppeteer-manager.js';
import { downloadM3u8 } from '../utils/ffmpeg.js';
import path from 'path';

export interface KickVod {
  id: string;
  slug?: string | null;
  channel_id?: number | null;
  title?: string | null;
  session_title?: string | null;
  duration?: number | null;
  views?: number | null;
  published_at?: string | null;
  created_at: string;
  source?: string | null;
  is_live?: boolean | null;
  start_time?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  viewer_count?: number | null;
  tags?: string[] | null;
  thumbnail?: {
    src?: string | null;
    srcset?: string | null;
  } | null;
}

export async function getVods(channelName: string): Promise<KickVod[]> {
  const browser = await getKickBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(`https://kick.com/${channelName}/videos`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const vodsData = await page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;

      const data = JSON.parse(script.innerHTML);
      const videos = data.props?.pageProps?.videos?.edges || [];

      return videos.map((edge: { node: Record<string, unknown> }) => ({
        id: String(edge.node.id),
        slug: edge.node.slug ?? null,
        title: edge.node.title ?? null,
        session_title: edge.node.session_title ?? null,
        duration: edge.node.duration ?? null,
        views: edge.node.views ?? null,
        published_at: edge.node.publishedAt ?? null,
        created_at: edge.node.createdAt || '',
        source: edge.node.source ?? null,
        thumbnail: edge.node.thumbnail
          ? { src: (edge.node.thumbnail as Record<string, string | null>)?.src ?? null, srcset: (edge.node.thumbnail as Record<string, string | null>)?.srcset ?? null }
          : null,
      }));
    });

    return vodsData || [];
  } finally {
    await page.close();
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const browser = await getKickBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(`https://kick.com/${channelName}/videos/${vodId}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const vodData = await page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;

      const data = JSON.parse(script.innerHTML);
      const video = data.props?.pageProps?.video;

      if (!video) return null;

      return {
        id: String(video.id),
        slug: video.slug ?? null,
        title: video.title ?? null,
        session_title: video.session_title ?? null,
        duration: video.duration ?? null,
        views: video.views ?? null,
        published_at: video.publishedAt ?? null,
        created_at: video.createdAt || '',
        source: video.source ?? null,
        thumbnail: video.thumbnail ? { src: video.thumbnail.src ?? null } : null,
      };
    });

    if (!vodData) {
      throw new Error(`VOD ${vodId} not found`);
    }

    return vodData;
  } finally {
    await page.close();
  }
}

export async function downloadMP4(_streamerId: string, vod: KickVod): Promise<string> {
  if (!vod.source) {
    throw new Error('VOD source URL not available');
  }

  const outputDir = path.join(process.cwd(), 'tmp', _streamerId);

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });
  } catch {}

  const outputPath = path.join(outputDir, `${vod.id}.mp4`);

  const response1 = await fetch(vod.source, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response1.ok) throw new Error(`Kick HLS fetch failed with status ${response1.status}`);

  const m3u8Content = await response1.text();
  const variantMatch = m3u8Content.match(/#EXT-X-STREAM-INF:[^\\n]*\\n(.+\.m3u8)/);

  if (!variantMatch) {
    throw new Error('Failed to parse HLS playlist');
  }

  const variantUrl = variantMatch[1];

  await downloadM3u8(variantUrl, outputPath);

  return outputPath;
}
