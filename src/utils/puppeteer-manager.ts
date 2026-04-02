import { connect } from 'puppeteer-real-browser';

type BrowserResult = Awaited<ReturnType<typeof connect>>;

export type NavigationErrorCode = 'NAVIGATION_TIMEOUT' | 'CAPTCHA_DETECTED' | 'INVALID_JSON_RESPONSE' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'MAX_RETRIES_EXCEEDED';

interface FailureResult {
  success: false;
  error: string;
  code?: NavigationErrorCode;
}

export interface SuccessResult<T = any> {
  success: true;
  page: any;
  data?: T;
  status?: number;
}

export type NavigationResult<T = any> = FailureResult | SuccessResult<T>;

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

export async function getBrowser(): Promise<{ browser: any }> {
  if (browserInstance && browserInstance.browser.connected) {
    return { browser: browserInstance.browser };
  }

  const memoryLimit = parseInt(process.env.PUPPETEER_MEMORY_LIMIT_MB || '512', 10);

  type PluginModule = { default: () => unknown };
  const pluginMod = (await import('puppeteer-extra-plugin-click-and-wait')) as PluginModule;
  const clickAndWaitPlugin = pluginMod.default;

  browserInstance = await connect({
    headless: 'auto' as any,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    customConfig: { chromeFlags: [`--js-flags=--max-old-space-size=${memoryLimit}`] } as any,
    turnstile: true,
    connectOption: { defaultViewport: null },
    plugins: [clickAndWaitPlugin()] as any,
  });

  const initialPage = await browserInstance.browser.newPage();
  initialPage.setDefaultNavigationTimeout(GLOBAL_NAV_TIMEOUT_MS);
  await initialPage.close();

  return { browser: browserInstance.browser };
}

/**
 * Navigate to URL with Turnstile/Cloudflare protection and retry logic.
 *
 * CRITICAL: Caller MUST close returned page in a finally block!
 * Failure to call await result.page.close() will cause memory leaks.
 *
 * Example usage pattern:
 *   const result = await navigateToUrl(url);
 *   try {
 *     if (!result.success) return;
 *     // Use result.page...
 *   } finally {
 *     await result.page?.close(); // ← REQUIRED to prevent memory leaks!
 *   }
 */
export async function navigateToUrl<T = any>(url: string, options?: NavigateOptions): Promise<NavigationResult<T>> {
  const timeoutMs = options?.timeoutMs ?? GLOBAL_NAV_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const isJsonEndpoint = options?.isJsonUrl ?? false;

  let browserData: Awaited<ReturnType<typeof getBrowser>> | null = null;

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

    try {
      const page = await browserData.browser.newPage();
      page.setDefaultNavigationTimeout(timeoutMs);

      const response = await page.goto(url, { waitUntil: 'networkidle2' });

      // Check for HTTP error status codes (4xx/5xx) - "Hard" failures
      const status = response?.status();
      if (status && status >= 400) {
        await page.close();
        return { success: false, error: `HTTP ${status}`, code: 'HTTP_ERROR' };
      }

      // Check for Cloudflare/Turnstile blocking pages
      const isBlocked = await page.evaluate(() => {
        return !!document.querySelector('#turnstile-wrapper') || document.title.includes('Just a moment') || document.title.includes('Attention Required!');
      });

      if (isBlocked) {
        await page.close();

        if (attempt === maxRetries) {
          return { success: false, error: 'Turnstile/Cloudflare wall detected', code: 'CAPTCHA_DETECTED' };
        }

        continue; // Retry with backoff on next iteration
      }

      if (isJsonEndpoint) {
        const contentType = response?.headers()['content-type'] || '';

        if (!contentType.includes('application/json')) {
          await page.close();

          if (attempt === maxRetries) {
            return { success: false, error: 'Expected JSON but got HTML/content', code: 'INVALID_JSON_RESPONSE' };
          }

          continue; // Retry with backoff on next iteration
        }

        try {
          // FAST PATH: Try native response.json() first (avoids page.evaluate overhead for large payloads)
          const jsonData = await response?.json();

          if (jsonData !== undefined) {
            return { success: true, page, data: jsonData as T, status };
          }

          // FALLBACK: DOM-based extraction only when native fails (<pre> tag or body text)
          const fallbackData = await page.evaluate(() => {
            const preTag = document.querySelector('pre')?.innerText;
            if (preTag) return JSON.parse(preTag);

            const bodyText = document.body.innerText.trim();
            return JSON.parse(bodyText);
          });

          return { success: true, page, data: fallbackData as T, status };
        } catch {
          await page.close(); // CRITICAL cleanup on parse failure to prevent memory leaks

          if (attempt === maxRetries) {
            return {
              success: false,
              error: `Failed to parse JSON response from ${url}`,
              code: 'INVALID_JSON_RESPONSE',
            };
          }

          // Continue retry loop for transient parsing issues - will automatically continue to next iteration
        }
      }

      // For non-JSON endpoints (HTML pages), return immediately on success
      if (!isJsonEndpoint) {
        return { success: true, page, status };
      }
    } catch (navError) {
      const err = navError as Error;

      if (attempt === maxRetries) {
        return {
          success: false,
          error: `Navigation failed after ${maxRetries + 1} attempts: ${err.message}`,
          code: err.message.includes('timeout') ? 'NAVIGATION_TIMEOUT' : 'NETWORK_ERROR',
        };
      }

      console.debug(`[Navigate] Attempt ${attempt + 1}/${maxRetries + 1} failed for ${url}:`, err.message);

      // Loop continues to next retry iteration automatically - no break needed!
    }
  }

  return { success: false, error: 'MAX_RETRIES_EXCEEDED', code: 'MAX_RETRIES_EXCEEDED' };
}

export function getMemoryUsage(): MemoryStats {
  const mem = process.memoryUsage();

  return {
    nodeHeapMb: Math.round(mem.heapUsed / (1024 * 1024)),
    externalMb: Math.round(mem.external / (1024 * 1024)),
    chromiumJSHeapMb: 0,
    totalRssMb: Math.round(mem.rss / (1024 * 1024)),
  };
}

export async function getFullMemoryStats(browser?: any): Promise<MemoryStats> {
  const mem = process.memoryUsage();

  let chromiumJSHeapMb = 0;

  if (browser) {
    try {
      const pages: any[] = await browser.pages();
      if (pages.length > 0) {
        const metrics = await pages[0].metrics();
        chromiumJSHeapMb = Math.round((metrics.JSHeapUsedSize || 0) / (1024 * 1024));
      }
    } catch {}
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
    const pages = await browserInstance.browser.pages();

    if (pages.length > 0) {
      console.debug(`[Browser] Closing ${pages.length} page(s)...`);
      await Promise.all(pages.map((p: any) => p.close()));
    }

    await browserInstance.browser.close();
    console.info('[Browser] Browser closed successfully');
  } catch (err) {
    console.error('[Browser] Error during shutdown:', err);
  } finally {
    browserInstance = null;
  }
}
