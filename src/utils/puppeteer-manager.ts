import { connect } from 'puppeteer-real-browser';
import type { Browser, Page } from 'puppeteer';
import clickAndWaitPlugin from 'puppeteer-extra-plugin-click-and-wait';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';
import { limit, getPuppeteerQueueStats } from './puppeteer-limiter.js';
import { sleep, getRetryDelay } from './delay.js';

const log = logger.child({ module: 'puppeteer-manager' });

type BrowserResult = Awaited<ReturnType<typeof connect>>;

export type NavigationErrorCode =
  | 'NAVIGATION_TIMEOUT'
  | 'CAPTCHA_DETECTED'
  | 'INVALID_JSON_RESPONSE'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'MAX_RETRIES_EXCEEDED';

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
let chromePid: number | null = null;
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

  browserInstance = await connect({
    headless: 'auto' as unknown as boolean,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    customConfig: {
      chromeFlags: [`--js-flags=--max-old-space-size=${memoryLimit}`],
    } as object,
    turnstile: true,
    connectOption: { defaultViewport: null },
    plugins: [clickAndWaitPlugin()],
  });

  chromePid = browserInstance.browser.process()?.pid ?? null;

  if (chromePid === null) {
    log.trace('Chromium PID not available (expected with puppeteer-real-browser connect())');
  }

  return { browser: browserInstance.browser as unknown as Browser };
}

export async function navigateToUrl<T = unknown>(url: string, options?: NavigateOptions): Promise<NavigationResult<T>> {
  const timeoutMs = options?.timeoutMs ?? GLOBAL_NAV_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const isJsonEndpoint = options?.isJsonUrl ?? false;
  const browserData = await getBrowser();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptResult: {
      success?: boolean;
      page?: Page;
      data?: T;
      status?: number;
      error?: string;
      code?: NavigationErrorCode;
    } = {};

    let page: Page | null = null;
    let pageToClose: Page | null = null;

    const queueStats = getPuppeteerQueueStats();
    if (queueStats.pending > 0) {
      log.debug({ url, attempt, ...queueStats }, 'Puppeteer queue is backing up');
    } else {
      log.trace({ url, attempt, ...queueStats }, 'Queuing Puppeteer navigation');
    }

    try {
      await limit(async () => {
        page = await browserData.browser.newPage();
        pageToClose = page;
        page.setDefaultNavigationTimeout(timeoutMs);

        const response = await page.goto(url, { waitUntil: 'networkidle2' });
        const status = response?.status();

        if (status && status >= 400) {
          attemptResult.error = `HTTP ${status}`;
          attemptResult.code = 'HTTP_ERROR';
          await page.close();
          return;
        }

        try {
          await page.waitForFunction(
            () => {
              const text = document.body.innerText.trim();
              const hasJson = text.startsWith('[') || text.startsWith('{');
              const isBlocked =
                !!document.querySelector('#turnstile-wrapper') || document.title.includes('Just a moment');
              return hasJson || isBlocked;
            },
            { timeout: 10000 }
          );
        } catch (error) {
          log.debug({ error: extractErrorDetails(error).message }, 'waitForFunction timed out');
        }

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
            attemptResult.error = 'Cloudflare wall persists';
            attemptResult.code = 'CAPTCHA_DETECTED';
          }
          return;
        }

        if (isJsonEndpoint && !pageState.hasJson) {
          await page.close();
          if (attempt === maxRetries) {
            attemptResult.error = 'No JSON found in response';
            attemptResult.code = 'INVALID_JSON_RESPONSE';
          }
          return;
        }

        let finalData: T | undefined;
        if (isJsonEndpoint) {
          try {
            finalData = await response?.json();
          } catch {
            if (pageState.content.startsWith('{') || pageState.content.startsWith('[')) {
              try {
                finalData = JSON.parse(pageState.content);
              } catch (parseError) {
                log.debug({ error: extractErrorDetails(parseError).message }, 'Failed to parse innerText as JSON');
              }
            }

            if (!finalData && pageState.content.length > 0) {
              const preContent = await page.evaluate(() => document.querySelector('pre')?.textContent || '');

              if (preContent.startsWith('{') || preContent.startsWith('[')) {
                try {
                  finalData = JSON.parse(preContent);
                } catch (parseError) {
                  log.debug(
                    { error: extractErrorDetails(parseError).message },
                    'Failed to parse <pre> content as JSON'
                  );
                }
              } else if (!finalData && pageState.content.length === 0) {
                log.trace('No valid JSON found in response or DOM extraction failed');
              }
            }
          }
        }

        attemptResult.success = true;
        attemptResult.page = page;
        attemptResult.data = finalData;
        attemptResult.status = status;
      });

      if (attemptResult.error) {
        return { success: false, error: attemptResult.error, code: attemptResult.code! };
      }

      if (attemptResult.success) {
        return { success: true, page: attemptResult.page!, data: attemptResult.data, status: attemptResult.status };
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      if (pageToClose) await (pageToClose as Page).close();
      if (attempt === maxRetries) {
        return { success: false, error: details.message, code: 'NETWORK_ERROR' };
      }
    }

    if (attempt < maxRetries) {
      const delayMs = getRetryDelay(attempt, 2000, 3, true);
      log.trace({ attempt, delayMs }, 'Applying backoff delay before next retry');
      await sleep(delayMs);
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

  const browser = browserInstance.browser as unknown as Browser;
  const pid = chromePid;
  const timeoutMs = parseInt(process.env.PUPPETEER_SHUTDOWN_TIMEOUT_MS || '5000', 10);

  try {
    log.info({ pid }, 'Attempting graceful browser shutdown...');

    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser close timed out')), timeoutMs)),
    ]);

    log.info('Browser closed gracefully');
  } catch (error) {
    const details = extractErrorDetails(error);
    log.warn({ error: details.message, pid }, 'Graceful shutdown failed or timed out');

    if (pid) {
      try {
        log.info({ pid }, 'Sending SIGKILL to browser process');
        process.kill(pid, 'SIGKILL');
      } catch (killError) {
        log.debug({ pid, error: extractErrorDetails(killError).message }, 'Process already dead or cannot be killed');
      }
    }
  } finally {
    browserInstance = null;
    chromePid = null;
  }
}

export function getChromePid(): number | null {
  return chromePid;
}
