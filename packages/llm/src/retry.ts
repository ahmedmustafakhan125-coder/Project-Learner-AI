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
  /**
   * Extra veto applied on top of the error's own `retryable` flag.
   *
   * Retrying is only safe when the previous attempt had no observable effect.
   * A streaming caller that has already handed tokens to the client cannot
   * retry without replaying text the reader can already see, so it vetoes here
   * rather than silently duplicating output.
   */
  shouldRetry?: (err: unknown) => boolean;
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

      // Only retry on errors explicitly marked as retryable, and only when the
      // caller agrees the previous attempt left nothing behind.
      const retryable = (err as { retryable?: boolean })?.retryable;
      const vetoed = options.shouldRetry ? !options.shouldRetry(err) : false;
      if (!retryable || vetoed || attempt >= maxRetries) {
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
