import { describe, expect, it, vi } from 'vitest';
import { bufferStream, collectStream, firstTokenOrTimeout } from '../src/stream-utils.js';
import type { LLMEvent, LLMResponse } from '../src/types.js';

const response: LLMResponse = {
  text: 'hi',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: 'end_turn',
  model: 'test',
};

async function* source(events: LLMEvent[], delayMs = 0): AsyncIterable<LLMEvent> {
  for (const e of events) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield e;
  }
}

async function* throwingSource(): AsyncIterable<LLMEvent> {
  yield { type: 'start', model: 'test' };
  throw new Error('provider exploded');
}

const happyPath: LLMEvent[] = [
  { type: 'start', model: 'test' },
  { type: 'text_delta', text: 'h' },
  { type: 'text_delta', text: 'i' },
  { type: 'done', response },
];

describe('bufferStream', () => {
  it('replays every event in order despite buffering', async () => {
    const buffered = bufferStream(source(happyPath));
    const seen: string[] = [];
    for await (const e of buffered.events) seen.push(e.type);
    expect(seen).toEqual(['start', 'text_delta', 'text_delta', 'done']);
  });

  it('resolves firstToken on the first text delta, without consuming it', async () => {
    const buffered = bufferStream(source(happyPath));
    await buffered.firstToken;

    // The consumer must still receive the token that released the gate.
    const seen: LLMEvent[] = [];
    for await (const e of buffered.events) seen.push(e);
    expect(seen.filter((e) => e.type === 'text_delta')).toHaveLength(2);
  });

  it('resolves firstToken when a stream ends without producing any text', async () => {
    // Otherwise a fan-out would hang forever behind an empty lead response.
    const buffered = bufferStream(source([{ type: 'start', model: 'test' }]));
    await expect(buffered.firstToken).resolves.toBeUndefined();
  });

  it('resolves rather than rejects firstToken when the source fails', async () => {
    // A failed lead must still release the rest of the fan-out, and an
    // un-awaited rejection here would surface as an unhandled rejection.
    const buffered = bufferStream(throwingSource());
    await expect(buffered.firstToken).resolves.toBeUndefined();
    // The error is still raised where the caller is actually handling it:
    await expect(async () => {
      for await (const _ of buffered.events) { /* drain */ }
    }).rejects.toThrow('provider exploded');
  });

  it('delivers events buffered before a failure, then throws', async () => {
    const buffered = bufferStream(throwingSource());
    const seen: string[] = [];
    await expect(async () => {
      for await (const e of buffered.events) seen.push(e.type);
    }).rejects.toThrow();
    expect(seen).toEqual(['start']);
  });
});

describe('firstTokenOrTimeout', () => {
  it('returns as soon as the first token arrives', async () => {
    const buffered = bufferStream(source(happyPath));
    const started = Date.now();
    await firstTokenOrTimeout(buffered, 5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up after the ceiling so a stalled lead cannot block the fan-out', async () => {
    vi.useFakeTimers();
    try {
      // A source that never yields anything.
      const buffered = bufferStream((async function* (): AsyncIterable<LLMEvent> {
        await new Promise(() => {});
      })());
      let settled = false;
      void firstTokenOrTimeout(buffered, 2000).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectStream', () => {
  it('returns the terminal response', async () => {
    await expect(collectStream(source(happyPath))).resolves.toMatchObject({ text: 'hi' });
  });

  it('throws when a stream ends with no done event', async () => {
    await expect(collectStream(source([{ type: 'start', model: 'test' }]))).rejects.toThrow(
      /without a terminal/i,
    );
  });
});
