import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../src/retry.js';

/**
 * Retry tests use fake timers so the exponential backoff (1 s, 2 s) does not
 * actually block the test runner. `vi.useFakeTimers()` replaces setTimeout,
 * and `vi.runAllTimersAsync()` drains pending timers as microtasks.
 *
 * To avoid unhandled-rejection warnings with fake timers, every rejected
 * promise is caught immediately with `.catch(() => {})` at creation time. The
 * assertion is then made separately on the already-settled promise.
 */

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = withRetry(fn, { baseDelayMs: 1000 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a retryable error and returns the eventual success', async () => {
    const retryableError = Object.assign(new Error('rate limited'), { retryable: true });
    const fn = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { baseDelayMs: 1000 });
    // Prevent unhandled rejection during timer advancement.
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates non-retryable errors immediately without retrying', async () => {
    const authError = Object.assign(new Error('invalid key'), { retryable: false });
    const fn = vi.fn().mockRejectedValue(authError);

    const promise = withRetry(fn, { baseDelayMs: 1000 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('invalid key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates plain errors (no retryable property) immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network'));

    const promise = withRetry(fn, { baseDelayMs: 1000 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('network');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts all retries and throws the last error', async () => {
    const retryableError = Object.assign(new Error('unavailable'), { retryable: true });
    const fn = vi.fn().mockRejectedValue(retryableError);

    // maxRetries=2 → 3 total attempts
    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 100 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('unavailable');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours retryAfterMs when the error provides it', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Track actual delay requested via setTimeout.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void, ms?: number) => {
        if (ms !== undefined) delays.push(ms);
        return originalSetTimeout(fn, ms);
      }) as typeof setTimeout,
    );

    const rateLimitError = Object.assign(
      new Error('rate limited'),
      { retryable: true, retryAfterMs: 5_000 },
    );
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { baseDelayMs: 1000 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    // Should have used the explicit retryAfterMs (5000) rather than baseDelayMs (1000).
    expect(delays).toContain(5000);
  });

  it('uses exponential backoff (1s, 2s) when retryAfterMs is absent', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void, ms?: number) => {
        if (ms !== undefined) delays.push(ms);
        return originalSetTimeout(fn, ms);
      }) as typeof setTimeout,
    );

    const retryableError = Object.assign(new Error('unavailable'), { retryable: true });
    const fn = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 1000 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    // First retry: 1000ms (baseDelayMs * 2^0)
    // Second retry: 2000ms (baseDelayMs * 2^1)
    expect(delays).toEqual([1000, 2000]);
  });

  it('respects custom maxRetries=0 (no retries)', async () => {
    const retryableError = Object.assign(new Error('unavailable'), { retryable: true });
    const fn = vi.fn().mockRejectedValue(retryableError);

    const promise = withRetry(fn, { maxRetries: 0, baseDelayMs: 1000 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('unavailable');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
