import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEdge, BrainNode } from '@ai-edu/core';

/**
 * The brain's read routes.
 *
 * The loader and the rebuild are mocked; the graph and detail functions from
 * packages/core are real, so these tests cover what the routes own — query
 * validation, scoping every load to the caller, and the error shapes.
 */

const { mockLoadProjection, mockScheduleRebuild, mockFindQuestionRecall, mockLoadBrainEvents } = vi.hoisted(() => ({
  mockLoadProjection: vi.fn(),
  mockScheduleRebuild: vi.fn(async () => {}),
  mockFindQuestionRecall: vi.fn(),
  mockLoadBrainEvents: vi.fn(),
}));

vi.mock('../src/brain.js', () => ({
  loadProjection: mockLoadProjection,
  scheduleRebuild: mockScheduleRebuild,
  findQuestionRecall: mockFindQuestionRecall,
  loadBrainEvents: mockLoadBrainEvents,
}));

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...original,
    requireAuth: vi.fn(async (request: { user?: unknown }) => {
      request.user = { id: 'user-1', email: 'learner@example.com' };
    }),
  };
});

type App = ReturnType<typeof Fastify>;
let app: App;

// Built once: importing Fastify and the route module is the slow part, and on
// a cold machine it alone can exceed a single test's five-second budget.
beforeAll(async () => {
  const { brainRoutes } = await import('../src/routes/brain.js');
  app = Fastify();
  await app.register(brainRoutes);
  await app.ready();
}, 60_000);

const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();

function node(id: string, kind: BrainNode['kind'], lastSeenAt: string, score: number | null = null): BrainNode {
  return { id, kind, key: id.split(':').slice(1).join(':'), label: id, score, confidence: null, metadata: {}, firstSeenAt: lastSeenAt, lastSeenAt };
}

const nodes: BrainNode[] = [
  node('concept:closures', 'concept', recent, 0.7),
  node('concept:old-thing', 'concept', ancient, 0.2),
  node('session:thread:t1', 'session', recent),
];
const edges: BrainEdge[] = [
  { src: 'session:thread:t1', dst: 'concept:closures', kind: 'ACTIVATED', weight: 1, sourceId: 't1', metadata: { order: 0 }, createdAt: recent },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadProjection.mockResolvedValue({ nodes, edges });
});

describe('GET /api/brain/graph', () => {
  it('returns the styled graph for the caller, and only the caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brain/graph' });
    expect(res.statusCode).toBe(200);
    expect(mockLoadProjection).toHaveBeenCalledWith('user-1');
    const body = res.json();
    expect(body.nodes).toHaveLength(3);
    expect(body.nodes[0].style).toEqual(expect.objectContaining({ tone: expect.any(String), radius: expect.any(Number) }));
    expect(body.links).toEqual([expect.objectContaining({ source: 'session:thread:t1', target: 'concept:closures', order: 0 })]);
    expect(body.meta).toEqual({ total: 3, truncated: false, focus: null });
  });

  it('applies the time window', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brain/graph?window=90' });
    expect(res.json().nodes.map((n: BrainNode) => n.id)).not.toContain('concept:old-thing');
  });

  it('focuses on a node given by its full id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/brain/graph?focus=${encodeURIComponent('concept:closures')}&depth=1`,
    });
    const body = res.json();
    expect(body.meta.focus).toBe('concept:closures');
    expect(body.nodes.map((n: BrainNode) => n.id).sort()).toEqual(['concept:closures', 'session:thread:t1']);
  });

  it('rejects a nonsense window or depth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/brain/graph?window=-3' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/brain/graph?depth=99' })).statusCode).toBe(400);
  });

  it('reports a load failure without leaking it', async () => {
    mockLoadProjection.mockRejectedValue(new Error('relation "brain_nodes" does not exist'));
    const res = await app.inject({ method: 'GET', url: '/api/brain/graph' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'brain_unavailable', message: 'Could not load your brain.' });
  });
});

describe('GET /api/brain/node/:id', () => {
  it('returns the detail for one of the caller’s nodes', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/brain/node/${encodeURIComponent('concept:closures')}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.node.id).toBe('concept:closures');
    expect(body.sessions).toEqual([expect.objectContaining({ source: 'thread', sourceId: 't1' })]);
    expect(mockLoadProjection).toHaveBeenCalledWith('user-1');
  });

  it('is a 404 for a node the caller does not have', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/brain/node/${encodeURIComponent('concept:nope')}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/brain/rebuild', () => {
  it('rebuilds the caller’s own brain', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/brain/rebuild' });
    expect(res.statusCode).toBe(200);
    expect(mockScheduleRebuild).toHaveBeenCalledWith('user-1');
  });
});

describe('POST /api/brain/recall', () => {
  const THREAD = '22222222-2222-4222-8222-222222222222';

  it('asks on behalf of the caller, excluding the conversation they are in', async () => {
    const match = { threadId: 'other', canonical: 'closures', askedAt: recent, exact: true, similarity: 1, title: 'Closures', nodeId: 'session:thread:other' };
    mockFindQuestionRecall.mockResolvedValue(match);
    const res = await app.inject({ method: 'POST', url: '/api/brain/recall', payload: { query: 'closures?', threadId: THREAD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ match });
    expect(mockFindQuestionRecall).toHaveBeenCalledWith('user-1', 'closures?', THREAD);
  });

  it('treats a missing thread as a brand-new conversation', async () => {
    mockFindQuestionRecall.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/api/brain/recall', payload: { query: 'closures?' } });
    expect(res.json()).toEqual({ match: null });
    expect(mockFindQuestionRecall).toHaveBeenCalledWith('user-1', 'closures?', null);
  });

  it('rejects an empty question or a malformed thread id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/brain/recall', payload: { query: '' } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/brain/recall', payload: { query: 'x', threadId: 'nope' } })).statusCode,
    ).toBe(400);
  });

  it('answers "no match" rather than an error when recall itself fails', async () => {
    mockFindQuestionRecall.mockRejectedValue(new Error('fingerprints unavailable'));
    const res = await app.inject({ method: 'POST', url: '/api/brain/recall', payload: { query: 'closures?' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ match: null });
  });
});

describe('GET /api/brain/events', () => {
  it('returns the caller’s own event log, for replay', async () => {
    const events = [{ id: 'e1', kind: 'offer_dismissed', sourceKind: 'thread', sourceId: 't', dedupeKey: 'k', createdAt: recent, payload: { conceptKey: 'closures' } }];
    mockLoadBrainEvents.mockResolvedValue(events);
    const res = await app.inject({ method: 'GET', url: '/api/brain/events' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events });
    expect(mockLoadBrainEvents).toHaveBeenCalledWith('user-1');
  });

  it('reports a load failure without leaking it', async () => {
    mockLoadBrainEvents.mockRejectedValue(new Error('relation does not exist'));
    const res = await app.inject({ method: 'GET', url: '/api/brain/events' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('brain_unavailable');
  });
});
