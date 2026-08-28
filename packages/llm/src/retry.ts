/**
 * Retry with exponential backoff.
 *
 * Wraps an async function and retries on errors that carry `retryable: true`,
 * which every `LLMError` subclass that could plausibly succeed on retry sets
 * (rate limits, transient 5xx, connection resets). Non-retryable errors
 * propagate immediately — there is no point re-sending a request that failed
 * because the prompt is too long or the API key is invalid.
 *
 * When the error exposes `retryAfterMs` (rate-limit 429 with a Retry-After
 * header) that value is honoured exactly; otherwise the delay doubles from
 * 1 s on each attempt.
 */

export interface RetryOptions {
  /** Maximum number of retries (not including the initial attempt). Default: 2. */
  maxRetries?: number;
  /** Initial backoff delay in ms. Default: 1000. */
  baseDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1_000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Only retry on errors explicitly marked as retryable.
      const retryable = (err as { retryable?: boolean })?.retryable;
      if (!retryable || attempt >= maxRetries) {
        throw err;
      }

      // Honour a provider-supplied Retry-After when present.
      const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
      const delay = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt);

      await sleep(delay);
    }
  }

  // Unreachable in practice (the loop always either returns or throws),
  // but TypeScript needs the return path.
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
