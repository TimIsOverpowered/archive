type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface FetchMockOptions {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  error?: unknown;
}

let originalFetch: typeof globalThis.fetch | undefined;

const handlers = new Map<string, FetchMock>();

export function mockFetch(options: FetchMockOptions = {}): { cleanup: () => void } {
  const { status = 200, body = {}, headers = { 'Content-Type': 'application/json' }, error } = options;

  if (originalFetch === undefined) {
    originalFetch = globalThis.fetch;
  }

  const mock: FetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : String(input);

    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) {
        return handler(input, init);
      }
    }

    if (error != null) {
      throw error;
    }

    return new Response(JSON.stringify(body), { status, headers });
  };

  globalThis.fetch = mock;

  return {
    cleanup: () => {
      handlers.clear();
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
        originalFetch = undefined;
      }
    },
  };
}

export function mockFetchFor(urlPattern: string, options: FetchMockOptions = {}): { cleanup: () => void } {
  const { cleanup } = mockFetch(options);

  const url = typeof urlPattern === 'string' ? urlPattern : String(urlPattern);
  const mock: FetchMock = async (input: RequestInfo | URL) => {
    const target = input instanceof URL ? input.href : typeof input === 'string' ? input : String(input);
    if (!target.includes(url)) {
      throw new Error(`Fetch mock expected URL to contain "${url}", got: ${target}`);
    }
    const { status = 200, body = {}, headers = { 'Content-Type': 'application/json' }, error } = options;
    if (error != null) throw error;
    return new Response(JSON.stringify(body), { status, headers });
  };

  handlers.set(url, mock);

  return { cleanup };
}

export function restoreFetch(): void {
  handlers.clear();
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
