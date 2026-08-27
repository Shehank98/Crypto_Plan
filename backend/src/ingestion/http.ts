// Minimal fetch helpers with retry + backoff, tuned for free-tier rate limits.

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  /** Max attempts on 429 / 5xx / network error. Default 5. */
  maxRetries?: number;
  /** Base backoff in ms (doubled each retry). Default 2000. */
  baseDelayMs?: number;
}

/**
 * GET JSON with exponential backoff. Honors a `Retry-After` header when the
 * server sends one (CoinGecko does on 429).
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { headers = {}, maxRetries = 5, baseDelayMs = 2000 } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * 2 ** attempt;
        if (attempt < maxRetries) {
          await sleep(delay);
          continue;
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GET ${url} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
