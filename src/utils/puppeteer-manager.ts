import { connect } from 'puppeteer-real-browser';
import type { Browser, Page, HTTPResponse, PuppeteerLifeCycleEvent } from 'puppeteer';
import type { PuppeteerExtraPlugin } from 'puppeteer-extra';

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

/**
 * Navigates to a URL and handles anti-bot/JSON extraction.
 * @template T The expected shape of the JSON response.
 */
export async function navigateToUrl<T = unknown>(url: string, options?: NavigateOptions): Promise<NavigationResult<T>> {
  const timeoutMs = options?.timeoutMs ?? GLOBAL_NAV_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const isJsonEndpoint = options?.isJsonUrl ?? false;
  const waitCondition: PuppeteerLifeCycleEvent = 'networkidle2';

  let browserData: { browser: Browser };

  try {
    browserData = await getBrowser();
  } catch (systemError) {
    console.error('[Navigate] Critical error getting browser:', systemError);
    return { success: false, error: String(systemError), code: 'NETWORK_ERROR' };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      const jitter = (Math.random() - 0.5) * 600;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }

    let page: Page | null = null;

    try {
      page = await browserData.browser.newPage();
      page.setDefaultNavigationTimeout(timeoutMs);

      const response: HTTPResponse | null = await page.goto(url, { waitUntil: waitCondition });
      const status = response?.status();

      // 1. Check HTTP Hard Errors
      if (status && status >= 400) {
        await page.close();
        return { success: false, error: `HTTP ${status}`, code: 'HTTP_ERROR' };
      }

      // 2. Check Cloudflare/Turnstile
      const isBlocked = await page.evaluate(() => {
        return !!document.querySelector('#turnstile-wrapper') || document.title.includes('Just a moment') || document.title.includes('Attention Required!');
      });

      if (isBlocked) {
        await page.close();
        if (attempt === maxRetries) {
          return { success: false, error: 'Turnstile wall detected', code: 'CAPTCHA_DETECTED' };
        }
        continue;
      }

      // 3. Handle JSON Endpoints
      if (isJsonEndpoint) {
        const contentType = response?.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) {
          await page.close();
          if (attempt === maxRetries) {
            return { success: false, error: 'Expected JSON but got HTML', code: 'INVALID_JSON_RESPONSE' };
          }
          continue;
        }

        let jsonData: T | null = null;
        try {
          // Attempt 1: Native JSON
          jsonData = (await response?.json()) as T;
        } catch {
          try {
            // Attempt 2: DOM Extraction (Fallback)
            const text = await page.evaluate(() => {
              const pre = document.querySelector('pre')?.innerText;
              return pre || document.body.innerText.trim();
            });
            jsonData = JSON.parse(text) as T;
          } catch (parseError) {
            await page.close();
            if (attempt === maxRetries) {
              return { success: false, error: `JSON Parse Failed: ${String(parseError)}`, code: 'INVALID_JSON_RESPONSE' };
            }
            continue;
          }
        }
        return { success: true, page, data: jsonData as T, status };
      }

      // 4. Handle HTML Success
      return { success: true, page, status };
    } catch (navError) {
      if (page) await page.close();
      const error = navError as Error;

      if (attempt === maxRetries) {
        return {
          success: false,
          error: `Failed after ${maxRetries + 1} attempts: ${error.message}`,
          code: error.message.includes('timeout') ? 'NAVIGATION_TIMEOUT' : 'NETWORK_ERROR',
        };
      }
      console.debug(`[Navigate] Attempt ${attempt + 1} failed:`, error.message);
    }
  }

  return { success: false, error: 'MAX_RETRIES_EXCEEDED', code: 'MAX_RETRIES_EXCEEDED' };
}

export const navigateToKickUrl = navigateToUrl;

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
      // Browser or page might have closed during metric collection
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
  } catch (err) {
    console.error('[Browser] Shutdown error:', err);
  } finally {
    browserInstance = null;
  }
}
