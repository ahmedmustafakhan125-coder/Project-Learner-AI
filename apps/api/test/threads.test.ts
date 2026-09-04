import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The conversation-history routes.
 *
 * Only `db()` and `requireAuth` are mocked; the route module itself is real, so
 * these tests cover the thing that actually matters about this file — that
 * every query is scoped to the calling user, and that a transcript always
 * replays as four panes whatever the stored rows look like.
 */

/* ------------------------------------------------------------------ *
 * A chainable Supabase double
 *
 * The real client is a builder that is also a thenable: some calls end at
 * `.maybeSingle()`, others are awaited straight off `.limit()` or `.eq()`.
 * Responses are therefore queued in the order the handler awaits them.
 * ------------------------------------------------------------------ */

interface Response {
  data: unknown;
  error?: { message: string } | null;
}

let responses: Response[] = [];
let cursor = 0;
/** Every table touched, in order — the assertion surface for user scoping. */
let tables: string[] = [];
/** Every `.eq()` filter applied, so tests can prove `user_id` was one of them. */
let filters: Array<[string, unknown]> = [];

function nextResponse(): Promise<Response> {
  const response = responses[cursor] ?? { data: null, error: null };
  cursor += 1;
  return Promise.resolve({ error: null, ...response });
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'in', 'order', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain['eq'] = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return chain;
  });
  chain['maybeSingle'] = vi.fn(() => nextResponse());
  chain['single'] = vi.fn(() => nextResponse());
  // Awaiting the builder itself resolves the next queued response.
  chain['then'] = (resolve: (v: Response) => unknown, reject: (e: unknown) => unknown) =>
    nextResponse().then(resolve, reject);
  return chain;
}

const mockDb = {
  from: vi.fn((table: string) => {
    tables.push(table);
    return makeChain();
  }),
};

vi.mock('../src/db.js', () => ({ db: () => mockDb }));

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...original,
    requireAuth: vi.fn(async (request: { user?: unknown }) => {
      request.user = { id: 'user-1', email: 'learner@example.com' };
    }),
  };
});

async function buildApp() {
  const { threadRoutes } = await import('../src/routes/threads.js');
  const app = Fastify();
  await app.register(threadRoutes);
  return app;
}

function queue(...items: Response[]): void {
  responses = items;
  cursor = 0;
}

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  responses = [];
  cursor = 0;
  tables = [];
  filters = [];
});

/* ------------------------------------------------------------------ *
 * GET /api/threads
 * ------------------------------------------------------------------ */

describe('GET /api/threads', () => {
  it('returns the learner’s conversations, newest first, scoped to their user id', async () => {
    queue(
      {
        data: [
          { id: THREAD_ID, title: 'Closures', created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-04T10:00:00Z' },
          { id: OTHER_ID, title: 'Rate limiters', created_at: '2026-08-30T10:00:00Z', updated_at: '2026-09-02T10:00:00Z' },
        ],
      },
      { data: [{ thread_id: THREAD_ID }, { thread_id: THREAD_ID }, { thread_id: OTHER_ID }] },
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/threads' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.threads).toHaveLength(2);
    expect(body.threads[0]).toMatchObject({ id: THREAD_ID, title: 'Closures', messageCount: 2 });
    expect(body.threads[1]).toMatchObject({ id: OTHER_ID, messageCount: 1 });

    // The service-role client bypasses RLS, so the WHERE clause is the only
    // thing keeping one learner out of another's history.
    expect(filters).toContainEqual(['user_id', 'user-1']);
    expect(tables).toEqual(['threads', 'messages']);
  });

  it('hides a thread whose question never persisted rather than offering an empty row', async () => {
    queue(
      {
        data: [
          { id: THREAD_ID, title: 'Real', created_at: 'x', updated_at: 'x' },
          { id: OTHER_ID, title: 'Orphan', created_at: 'x', updated_at: 'x' },
        ],
      },
      { data: [{ thread_id: THREAD_ID }] },
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/threads' });

    const body = JSON.parse(res.body);
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual([THREAD_ID]);
  });

  it('reports a query failure instead of returning an empty history', async () => {
    queue({ data: null, error: { message: 'connection reset' } });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/threads' });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('list_failed');
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/threads/:id
 * ------------------------------------------------------------------ */

describe('GET /api/threads/:id', () => {
  it('replays every turn as four panes in the canonical agent order', async () => {
    queue(
      { data: { id: THREAD_ID, title: 'Closures', created_at: 'x', updated_at: 'y' } },
      { data: [{ id: 'msg-1', role: 'user', content: 'How do closures work?', created_at: 'z' }] },
      {
        data: [
          { message_id: 'msg-1', agent: 'simple', status: 'complete', content_md: 'A closure is…', error: null },
          { message_id: 'msg-1', agent: 'industry', status: 'complete', content_md: 'In production…', error: null },
          { message_id: 'msg-1', agent: 'practice', status: 'complete', content_md: 'Try this…', error: null },
          { message_id: 'msg-1', agent: 'concepts', status: 'complete', content_md: 'Key facts…', error: null },
        ],
      },
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.thread.title).toBe('Closures');
    expect(body.turns).toHaveLength(1);
    expect(Object.keys(body.turns[0].panes)).toEqual(['simple', 'industry', 'practice', 'concepts']);
    expect(body.turns[0].panes.simple).toEqual({ status: 'complete', text: 'A closure is…', error: null });
  });

  it('renders a specialist that never finished as a failed pane, not a missing one', async () => {
    queue(
      { data: { id: THREAD_ID, title: 'Stopped early', created_at: 'x', updated_at: 'y' } },
      { data: [{ id: 'msg-1', role: 'user', content: 'Question', created_at: 'z' }] },
      {
        data: [
          { message_id: 'msg-1', agent: 'simple', status: 'complete', content_md: 'Done.', error: null },
          // `practice` was still pending when the learner hit stop; `industry`
          // and `concepts` have no row at all.
          { message_id: 'msg-1', agent: 'practice', status: 'pending', content_md: '', error: null },
        ],
      },
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/threads/${THREAD_ID}` });

    const panes = JSON.parse(res.body).turns[0].panes;
    expect(panes.simple.status).toBe('complete');
    expect(panes.practice.status).toBe('error');
    expect(panes.industry.status).toBe('error');
    expect(panes.concepts.status).toBe('error');
    expect(panes.concepts.error).toBeTruthy();
  });

  it('404s on a thread that is not the caller’s', async () => {
    queue({ data: null });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/threads/${OTHER_ID}` });

    expect(res.statusCode).toBe(404);
    expect(filters).toContainEqual(['user_id', 'user-1']);
  });

  it('rejects an id that is not a uuid before touching the database', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/threads/not-a-uuid' });

    expect(res.statusCode).toBe(400);
    expect(tables).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * PATCH + DELETE
 * ------------------------------------------------------------------ */

describe('PATCH /api/threads/:id', () => {
  it('renames a conversation the caller owns', async () => {
    queue({ data: { id: THREAD_ID } });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}`,
      payload: { title: 'Closures and memory' },
    });

    expect(res.statusCode).toBe(200);
    expect(filters).toContainEqual(['user_id', 'user-1']);
  });

  it('rejects an empty title', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${THREAD_ID}`,
      payload: { title: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(tables).toEqual([]);
  });
});

describe('DELETE /api/threads/:id', () => {
  it('deletes a conversation the caller owns', async () => {
    queue({ data: { id: THREAD_ID } });

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/threads/${THREAD_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(filters).toContainEqual(['user_id', 'user-1']);
  });

  it('404s rather than reporting success when the row belonged to someone else', async () => {
    queue({ data: null });

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/threads/${OTHER_ID}` });

    expect(res.statusCode).toBe(404);
  });
});
