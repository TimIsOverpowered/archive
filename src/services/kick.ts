import axios from 'axios';
import fsPromises from 'fs/promises';
import { getKickBrowser } from '../utils/puppeteer-manager.js';
import { downloadM3u8 } from '../utils/ffmpeg.js';
import path from 'path';

export interface KickVod {
  id: number;
  slug: string;
  title: string;
  duration: number;
  views: number;
  published_at: string;
  created_at: string;
  source?: string;
  thumbnail?: {
    url: string;
  };
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

      return videos.map((edge: any) => ({
        id: edge.node.id,
        slug: edge.node.slug,
        title: edge.node.title,
        duration: edge.node.duration,
        views: edge.node.views,
        published_at: edge.node.publishedAt,
        created_at: edge.node.createdAt,
        source: edge.node.source,
        thumbnail: edge.node.thumbnail ? { url: edge.node.thumbnail.url } : undefined,
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
        id: video.id,
        slug: video.slug,
        title: video.title,
        duration: video.duration,
        views: video.views,
        published_at: video.publishedAt,
        created_at: video.createdAt,
        source: video.source,
        thumbnail: video.thumbnail ? { url: video.thumbnail.url } : undefined,
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

  const m3u8Response = await axios.get(vod.source, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const m3u8Content = m3u8Response.data;
  const variantMatch = m3u8Content.match(/#EXT-X-STREAM-INF:[^\\n]*\\n(.+\.m3u8)/);

  if (!variantMatch) {
    throw new Error('Failed to parse HLS playlist');
  }

  const variantUrl = variantMatch[1];

  await downloadM3u8(variantUrl, outputPath);

  return outputPath;
}
