import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, streamSSE } from '../src/sse.js';

/**
 * A hand-rolled wire-format parser is exactly the kind of code that works on
 * the happy path and fails on a chunk boundary in production. These tests feed
 * it deliberately awkward framing: events split mid-line, multi-byte characters
 * split across chunks, CRLF line endings, keep-alive comments.
 */

/** Serve a fixed sequence of byte chunks as a fetch Response. */
function mockFetch(chunks: (string | Uint8Array)[], init: { status?: number; body?: unknown } = {}) {
  const { status = 200 } = init;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      controller.close();
    },
  });

  const response =
    status === 200
      ? new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
      : new Response(JSON.stringify(init.body ?? {}), { status });

  return vi.fn(async () => response);
}

const collect = async () => {
  const messages = [];
  for await (const message of streamSSE({ url: 'http://x/y', body: {}, token: 't' })) {
    messages.push(message);
  }
  return messages;
};

afterEach(() => vi.unstubAllGlobals());

describe('SSE framing', () => {
  it('parses well-formed events', async () => {
    vi.stubGlobal('fetch', mockFetch(['event: agent\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n']));
    const messages = await collect();

    expect(messages).toEqual([
      { event: 'agent', data: '{"a":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('reassembles an event split across chunk boundaries', async () => {
    // The network decides where chunks break, not the server.
    vi.stubGlobal('fetch', mockFetch(['event: age', 'nt\ndata: {"a"', ':1}\n', '\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: '{"a":1}' }]);
  });

  it('does not corrupt a multi-byte character split across chunks', async () => {
    // "é" is two bytes in UTF-8. Decoding each chunk independently would emit a
    // replacement character; streaming decode stitches it back together.
    const bytes = new TextEncoder().encode('event: agent\ndata: {"t":"café"}\n\n');
    const splitAt = bytes.indexOf(0xc3); // first byte of é
    vi.stubGlobal('fetch', mockFetch([bytes.slice(0, splitAt + 1), bytes.slice(splitAt + 1)]));

    const messages = await collect();
    expect(JSON.parse(messages[0]!.data).t).toBe('café');
  });

  it('handles CRLF line endings from proxies that rewrite them', async () => {
    vi.stubGlobal('fetch', mockFetch(['event: agent\r\ndata: {"a":1}\r\n\r\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: '{"a":1}' }]);
  });

  it('ignores keep-alive comment lines', async () => {
    vi.stubGlobal('fetch', mockFetch([': keep-alive\n\nevent: agent\ndata: 1\n\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: '1' }]);
  });

  it('joins multi-line data fields with newlines', async () => {
    vi.stubGlobal('fetch', mockFetch(['event: agent\ndata: line one\ndata: line two\n\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: 'line one\nline two' }]);
  });

  it('strips exactly one framing space, preserving intentional leading space', async () => {
    // "data:  x" means the payload is " x" — the first space is framing.
    vi.stubGlobal('fetch', mockFetch(['event: agent\ndata:  indented\n\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: ' indented' }]);
  });

  it('defaults to the "message" event when no event field is present', async () => {
    vi.stubGlobal('fetch', mockFetch(['data: bare\n\n']));
    expect(await collect()).toEqual([{ event: 'message', data: 'bare' }]);
  });

  it('drops an event carrying no data field', async () => {
    vi.stubGlobal('fetch', mockFetch(['event: ping\n\nevent: agent\ndata: 1\n\n']));
    expect(await collect()).toEqual([{ event: 'agent', data: '1' }]);
  });

  it('discards a trailing partial event rather than emitting it half-parsed', async () => {
    vi.stubGlobal('fetch', mockFetch(['event: agent\ndata: 1\n\nevent: truncated\ndata: incom']));
    expect(await collect()).toEqual([{ event: 'agent', data: '1' }]);
  });
});

describe('error handling', () => {
  it('raises a typed error for a JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([], {
        status: 429,
        body: { error: 'budget_exceeded', message: 'Daily allowance reached.' },
      }),
    );

    await expect(collect()).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'budget_exceeded',
      message: 'Daily allowance reached.',
    });
  });

  it('still raises when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    await expect(collect()).rejects.toBeInstanceOf(ApiError);
  });

  it('carries the payload so callers can read structured fields', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([], { status: 429, body: { error: 'budget_exceeded', spentUSD: 2.5 } }),
    );
    await expect(collect()).rejects.toMatchObject({
      payload: { spentUSD: 2.5 },
    });
  });
});
