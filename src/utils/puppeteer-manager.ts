import puppeteer from 'puppeteer-core';

let browserInstance: any | null = null;

export async function getKickBrowser(): Promise<any> {
  if (browserInstance) {
    return browserInstance;
  }

  const memoryLimit = parseInt(process.env.KICK_PUPPETEER_MEMORY_LIMIT_MB || '512', 10);

  const stealthPluginModule: any = await import('puppeteer-extra-plugin-stealth');
  (puppeteer as any).use(stealthPluginModule.default());

  browserInstance = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--js-flags=--max-old-space-size=${memoryLimit}`],
  });

  return browserInstance;
}

export async function releaseKickBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export function getMemoryUsage(): number {
  if (!browserInstance) {
    return 0;
  }
  const used = process.memoryUsage().heapUsed;
  return Math.round(used / (1024 * 1024));
}
