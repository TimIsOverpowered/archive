import { connect } from 'puppeteer-real-browser';
import type { Browser, Page } from 'puppeteer';
import type { PuppeteerExtraPlugin } from 'puppeteer-extra';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'puppeteer-manager' });

type BrowserResult = Awaited<ReturnType<typeof connect>>;

export type NavigationErrorCode = 'NAVIGATION_TIMEOUT' | 'CAPTCHA_DETECTED' | 'INVALID_JSON_RESPONSE' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'MAX_RETRIES_EXCEEDED';

interface FailureResult {
  success: false;
  error: string;
  code?: NavigationErrorCode;
}

export interface SuccessResult<T> {
  success: true;
  page: Page;
  data?: T;
  status?: number;
}

export type NavigationResult<T> = FailureResult | SuccessResult<T>;

export interface NavigateOptions {
  timeoutMs?: number;
  maxRetries?: number;
  dontSaveCookies?: boolean;
  isJsonUrl?: boolean;
}

export interface MemoryStats {
  nodeHeapMb: number;
  externalMb: number;
  chromiumJSHeapMb: number;
  totalRssMb: number;
}

let browserInstance: BrowserResult | null = null;
const GLOBAL_NAV_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Gets or initializes the singleton browser instance.
 * Uses 'unknown' casts to bridge the gap between puppeteer-real-browser and standard Puppeteer types.
 */
export async function getBrowser(): Promise<{ browser: Browser }> {
  if (browserInstance && browserInstance.browser.connected) {
    return { browser: browserInstance.browser as unknown as Browser };
  }

  const memoryLimit = parseInt(process.env.PUPPETEER_MEMORY_LIMIT_MB || '512', 10);

  const pluginMod = (await import('puppeteer-extra-plugin-click-and-wait')) as {
    default: () => PuppeteerExtraPlugin;
  };
  const clickAndWaitPlugin = pluginMod.default;

  browserInstance = await connect({
    headless: 'auto' as unknown as boolean,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    customConfig: {
      chromeFlags: [`--js-flags=--max-old-space-size=${memoryLimit}`],
    } as unknown as object,
    turnstile: true,
    connectOption: { defaultViewport: null },
    plugins: [clickAndWaitPlugin()],
  });

  return { browser: browserInstance.browser as unknown as Browser };
}

export async function navigateToUrl<T = unknown>(url: string, options?: NavigateOptions): Promise<NavigationResult<T>> {
  const timeoutMs = options?.timeoutMs ?? GLOBAL_NAV_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const isJsonEndpoint = options?.isJsonUrl ?? false;
  const browserData = await getBrowser();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ... (Jitter/Backoff logic same as before)

    let page: Page | null = null;

    try {
      page = await browserData.browser.newPage();
      page.setDefaultNavigationTimeout(timeoutMs);

      // 1. Initial Navigation
      const response = await page.goto(url, { waitUntil: 'networkidle2' });
      const status = response?.status();

      if (status && status >= 400) {
        await page.close();
        return { success: false, error: `HTTP ${status}`, code: 'HTTP_ERROR' };
      }

      // 2. INLINE VALIDATION GATE
      // We poll for the JSON content or a Captcha presence simultaneously
      try {
        await page.waitForFunction(
          () => {
            const text = document.body.innerText.trim();
            const hasJson = text.startsWith('[') || text.startsWith('{');
            const isBlocked = !!document.querySelector('#turnstile-wrapper') || document.title.includes('Just a moment');

            // Return true if we found data OR if we are definitely blocked
            return hasJson || isBlocked;
          },
          { timeout: 10000 }
        );
      } catch (error) {
        log.debug({ error: extractErrorDetails(error).message }, 'waitForFunction timed out');
      }

      // 3. FINAL STATE CHECK
      const pageState = await page.evaluate(() => {
        const text = document.body.innerText.trim();
        return {
          hasJson: text.startsWith('[') || text.startsWith('{'),
          isBlocked: !!document.querySelector('#turnstile-wrapper') || document.title.includes('Just a moment'),
          content: text,
        };
      });

      if (pageState.isBlocked) {
        await page.close();
        if (attempt === maxRetries) {
          return { success: false, error: 'Cloudflare wall persists', code: 'CAPTCHA_DETECTED' };
        }
        continue; // Retry
      }

      if (isJsonEndpoint && !pageState.hasJson) {
        await page.close();
        if (attempt === maxRetries) {
          return { success: false, error: 'No JSON found in response', code: 'INVALID_JSON_RESPONSE' };
        }
        continue; // Retry
      }

      // 4. DATA EXTRACTION
      let finalData: T | undefined;
      if (isJsonEndpoint) {
        try {
          finalData = await response?.json();
        } catch (error) {
          log.debug({ error: extractErrorDetails(error).message }, 'JSON.parse failed, falling back to page content');
        }
      }

      return { success: true, page, data: finalData, status };
    } catch (error) {
      const details = extractErrorDetails(error);
      if (page) await page.close();
      if (attempt === maxRetries) {
        return { success: false, error: details.message, code: 'NETWORK_ERROR' };
      }
    }
  }

  return { success: false, error: 'MAX_RETRIES_EXCEEDED', code: 'MAX_RETRIES_EXCEEDED' };
}

export async function getFullMemoryStats(browser?: Browser): Promise<MemoryStats> {
  const mem = process.memoryUsage();
  let chromiumJSHeapMb = 0;

  if (browser && browser.connected) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const metrics = await pages[0].metrics();
        chromiumJSHeapMb = Math.round((metrics.JSHeapUsedSize || 0) / (1024 * 1024));
      }
    } catch {
      // Silently ignore - browser or page might have closed during metric collection
    }
  }

  return {
    nodeHeapMb: Math.round(mem.heapUsed / (1024 * 1024)),
    externalMb: Math.round(mem.external / (1024 * 1024)),
    chromiumJSHeapMb,
    totalRssMb: Math.round(mem.rss / (1024 * 1024)),
  };
}

export async function releaseBrowser(): Promise<void> {
  if (!browserInstance) return;
  try {
    await (browserInstance.browser as unknown as Browser).close();
  } catch (error) {
    const details = extractErrorDetails(error);
    log.warn({ details }, 'Failed to close browser instance during shutdown');
  } finally {
    browserInstance = null;
  }
}
