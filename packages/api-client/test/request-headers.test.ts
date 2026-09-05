import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../src/client.js';

/**
 * What goes on the wire for a request with no body.
 *
 * Every DELETE this client made was rejected with a 400 before it reached its
 * route. `request()` declared `Content-Type: application/json` unconditionally,
 * and Fastify runs its JSON parser on any request whose content-type says JSON
 * and whose method may carry a body — so an empty DELETE body failed with
 * "Body cannot be empty when content-type is set to 'application/json'".
 *
 * The symptom is entirely server-side and looks like a route bug, which is why
 * this is pinned here rather than left to an integration test: nothing about
 * the client's own behaviour looked wrong.
 */

const originalFetch = globalThis.fetch;

let calls: Array<{ url: string; init: RequestInit }>;

function headersOf(index = 0): Record<string, string> {
  return (calls[index]!.init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): ApiClient {
  return new ApiClient({ baseUrl: 'http://api.test', getToken: async () => 'token-123' });
}

describe('request headers', () => {
  it('omits Content-Type on a DELETE, which carries no body', async () => {
    await client().deleteProject('11111111-1111-1111-1111-111111111111');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf()['Content-Type']).toBeUndefined();
  });

  it('omits Content-Type on a GET', async () => {
    await client().listProjects();
    expect(headersOf()['Content-Type']).toBeUndefined();
  });

  it('still declares Content-Type when there is a body to describe', async () => {
    await client().saveProgress('proj-1', 0, { revealed: true });

    expect(calls[0]!.init.body).toBeTypeOf('string');
    expect(headersOf()['Content-Type']).toBe('application/json');
  });

  it('always sends the bearer token', async () => {
    await client().deleteProject('11111111-1111-1111-1111-111111111111');
    expect(headersOf()['Authorization']).toBe('Bearer token-123');
  });
});
