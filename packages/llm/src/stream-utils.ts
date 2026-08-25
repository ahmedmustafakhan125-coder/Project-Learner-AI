/**
 * Stream plumbing for the fan-out.
 *
 * `bufferStream` starts draining a provider stream immediately and lets a
 * caller await the arrival of the first token *without* consuming it. That is
 * what makes the prompt-cache stagger possible: a cache entry only becomes
 * readable once the first request is already in flight, so the fan-out fires
 * one request, waits for its first token, then fires the rest so they can read
 * the cache the leader just wrote. Firing all of them at once means none can
 * read what the others are still writing, and every one pays full price.
 */

import type { LLMEvent, LLMResponse } from './types.js';

/* ------------------------------------------------------------------ *
 * Async queue
 * ------------------------------------------------------------------ */

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (err: unknown) => void;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private ended = false;
  private failure: unknown = null;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length) {
      this.waiters.shift()?.resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    this.failure = err;
    this.ended = true;
    while (this.waiters.length) {
      this.waiters.shift()?.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Buffered items are delivered before a pending failure, so a consumer
        // still sees everything that arrived before the stream broke.
        if (this.items.length) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * Buffered stream
 * ------------------------------------------------------------------ */

export interface BufferedStream {
  /**
   * Resolves on the first text token, or when the stream ends or fails.
   *
   * It never rejects: a failed lead request should still release the rest of
   * the fan-out, and an un-awaited rejection here would surface as an unhandled
   * rejection. The actual error is raised when `events` is iterated, where the
   * caller is already handling it.
   */
  readonly firstToken: Promise<void>;
  readonly events: AsyncIterable<LLMEvent>;
}

export function bufferStream(source: AsyncIterable<LLMEvent>): BufferedStream {
  const queue = new AsyncQueue<LLMEvent>();

  let releaseFirstToken!: () => void;
  const firstToken = new Promise<void>((resolve) => {
    releaseFirstToken = resolve;
  });

  // Start pumping eagerly — the request must actually be in flight for the
  // cache stagger to mean anything.
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === 'text_delta') releaseFirstToken();
        queue.push(event);
      }
      queue.end();
    } catch (err) {
      queue.fail(err);
    } finally {
      // No-op if already released.
      releaseFirstToken();
    }
  })();

  return { firstToken, events: queue };
}

/**
 * Wait for the lead request to be far enough along that its cache entry is
 * readable, but never longer than `timeoutMs` — a slow or stalled leader must
 * not hold up the other agents. Losing the cache read costs money; blocking the
 * whole fan-out costs the user their answer.
 */
export function firstTokenOrTimeout(stream: BufferedStream, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void stream.firstToken.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Drain a stream and return its terminal response. */
export async function collectStream(source: AsyncIterable<LLMEvent>): Promise<LLMResponse> {
  let response: LLMResponse | undefined;
  for await (const event of source) {
    if (event.type === 'done') response = event.response;
  }
  if (!response) {
    throw new Error('Stream ended without a terminal `done` event.');
  }
  return response;
}
