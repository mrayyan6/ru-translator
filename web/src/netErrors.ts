/**
 * Was this failure the network, or the model?
 *
 * The distinction decides what to do next, and getting it wrong is expensive.
 * A dtype fallback exists for the case where a quantisation will not create a
 * session on this runtime — retrying with larger weights is the right answer
 * there. When the download itself failed, escalating to a four-times-larger
 * file on a connection that just dropped is the worst possible response, and
 * that is exactly what was happening.
 */
const NETWORK_PATTERNS = [
  'failed to fetch',
  'network error',
  'networkerror',
  'load failed',
  'err_network',
  'err_internet_disconnected',
  'err_connection',
  'err_timed_out',
  'the network connection was lost',
  'aborted',
  'unable to load',
  'could not locate file',
  'status code 5',
  'status code 429',
];

export function isNetworkError(e: unknown): boolean {
  const message = String((e as any)?.message ?? e).toLowerCase();
  return NETWORK_PATTERNS.some((p) => message.includes(p));
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Retry only network failures, with backoff.
 *
 * Worth doing because model files are cached individually as they land, so a
 * retry resumes at file granularity rather than starting the whole download
 * again. On a flaky connection that is the difference between eventually
 * finishing and never finishing.
 */
export async function retryOnNetworkError<T>(
  work: () => Promise<T>,
  { attempts = 3, baseDelayMs = 1500, onRetry }: RetryOptions = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (e) {
      lastError = e;
      if (!isNetworkError(e) || attempt === attempts) throw e;
      const delay = baseDelayMs * attempt;
      onRetry?.(attempt, delay, e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
