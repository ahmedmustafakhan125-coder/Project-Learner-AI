import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEdge, BrainNode, NavSummary } from '@ai-edu/core';

/**
 * GET /api/me/nav-summary — the signed-in top bar's one request.
 *
 * `db()`, the brain loader and auth are mocked; the ranking functions from
 * packages/core are real. These cover what the route owns: every query scoped
 * to the caller, each source failing on its own, the caps, and no model call.
 */

/* ------------------------------------------------------------------ *
 * A Supabase double keyed by table
 *
 * The route loads its sources in parallel, so responses are looked up by
 * table rather than queued in await order.
 * ------------------------------------------------------------------ */

interface Response {
  data: unknown;
  error?: { message: string } | null;
}

let byTable: Record<string, Response> = {};
/** Every `.eq()` filter, per table — the assertion surface for user scoping. */
let filters: Array<{ table: string; column: string; value: unknown }> = [];

function makeChain(table: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'order', 'limit']) chain[method] = vi.fn(() => chain);
  chain['eq'] = vi.fn((column: string, value: unknown) => {
    filters.push({ table, column, value });
    return chain;
  });
  chain['then'] = (resolve: (v: Response) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, ...(byTable[table] ?? { data: [] }) }).then(resolve, reject);
  return chain;
}

const mockDb = { from: vi.fn((table: string) => makeChain(table)) };
vi.mock('../src/db.js', () => ({ db: () => mockDb }));

const { mockLoadProjection } = vi.hoisted(() => ({ mockLoadProjection: vi.fn() }));
vi.mock('../src/brain.js', () => ({ loadProjection: mockLoadProjection, forgetSource: vi.fn() }));

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...original,
    requireAuth: vi.fn(async (request: { user?: unknown }) => {
      request.user = { id: 'user-1', email: 'learner@example.com' };
    }),
  };
});

// Recommendations are rules. If anything here reached for a model, this would say so.
const { mockResolveModel } = vi.hoisted(() => ({ mockResolveModel: vi.fn() }));
vi.mock('@ai-edu/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/llm')>()),
  resolveModel: mockResolveModel,
}));

type App = ReturnType<typeof Fastify>;
let app: App;

beforeAll(async () => {
  const { meRoutes } = await import('../src/routes/me.js');
  app = Fastify();
  await app.register(meRoutes);
  await app.ready();
}, 60_000);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function concept(key: string, score: number): BrainNode {
  return {
    id: `concept:${key}`, kind: 'concept', key, label: key, score, confidence: null,
    metadata: {}, firstSeenAt: daysAgo(1), lastSeenAt: daysAgo(1),
  };
}

const activated = (thread: string, key: string): BrainEdge => ({
  src: `session:thread:${thread}`, dst: `concept:${key}`, kind: 'ACTIVATED', weight: 1,
  sourceId: thread, metadata: { order: 0 }, createdAt: daysAgo(1),
});

const threadRows = Array.from({ length: 8 }, (_, i) => ({
  id: `t${i}`, title: i === 7 ? null : `Thread ${i}`, updated_at: daysAgo(i),
}));

function standardData(): void {
  byTable = {
    threads: { data: threadRows },
    // t6 never had a question persist; it must not show.
    messages: { data: threadRows.filter((t) => t.id !== 't6').map((t) => ({ thread_id: t.id })) },
    projects: {
      data: [
        { id: 'p-done', title: 'Pixel editor', status: 'completed', updated_at: daysAgo(0) },
        { id: 'p-live', title: 'Weather CLI', status: 'active', updated_at: daysAgo(2) },
        { id: 'p-draft', title: 'Draft', status: 'draft', updated_at: daysAgo(3) },
        { id: 'p-old', title: 'Old', status: 'completed', updated_at: daysAgo(9) },
      ],
    },
    enrollments: { data: [{ project_id: 'p-live', current_step_index: 2 }] },
    project_steps: { data: Array.from({ length: 8 }, () => ({ project_id: 'p-live' })) },
  };
  mockLoadProjection.mockResolvedValue({
    nodes: [concept('closures', 0.3), concept('scope', 0.2)],
    edges: [activated('t1', 'closures'), activated('t2', 'closures'), activated('t1', 'scope')],
  });
}

async function summary(): Promise<{ status: number; body: NavSummary }> {
  const res = await app.inject({ method: 'GET', url: '/api/me/nav-summary' });
  return { status: res.statusCode, body: res.json() as NavSummary };
}

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  standardData();
});

describe('GET /api/me/nav-summary', () => {
  it('scopes every user-owned query to the caller', async () => {
    await summary();
    for (const table of ['threads', 'projects', 'enrollments', 'project_steps']) {
      expect(filters.filter((f) => f.table === table && f.column === 'user_id').map((f) => f.value)).toEqual(['user-1']);
    }
    expect(mockLoadProjection).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('lists recent conversations, capped, without empty threads', async () => {
    const { status, body } = await summary();
    expect(status).toBe(200);
    expect(body.workspace?.recent.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(body.workspace?.recent[0]).toEqual({
      id: 't0',
      title: 'Thread 0',
      updatedAt: threadRows[0]!.updated_at,
      messageCount: 1,
    });
  });

  it('counts built and learned, and puts the active project first with its step', async () => {
    const { body } = await summary();
    expect(body.projects).toMatchObject({ built: 3, learned: 2 });
    expect(body.projects?.recent.map((p) => p.id)).toEqual(['p-live', 'p-done', 'p-draft']);
    expect(body.projects?.recent[0]).toMatchObject({ currentStep: 2, stepCount: 8 });
    expect(body.projects?.recent[1]).toMatchObject({ currentStep: null, stepCount: null });
  });

  it('names interests and recommends from the same history', async () => {
    const { body } = await summary();
    expect(body.brain?.conceptCount).toBe(2);
    expect(body.brain?.interests[0]?.nodeId).toBe('concept:closures');
    expect(body.recommendations.map((r) => r.id)).toContain('continue_project:p-live');
    expect(body.recommendations.map((r) => r.id)).toContain('strengthen:concept:closures');
  });

  it('returns a failed source as null and still fills the rest', async () => {
    byTable['projects'] = { data: null, error: { message: 'boom' } };
    mockLoadProjection.mockRejectedValue(new Error('brain down'));
    const { status, body } = await summary();
    expect(status).toBe(200);
    expect(body.projects).toBeNull();
    expect(body.brain).toBeNull();
    expect(body.workspace?.recent).toHaveLength(5);
    expect(body.recommendations).toEqual([]);
  });

  it('keeps the projects section when only the step progress fails', async () => {
    byTable['enrollments'] = { data: null, error: { message: 'boom' } };
    const { body } = await summary();
    expect(body.projects?.recent[0]).toMatchObject({ id: 'p-live', currentStep: null, stepCount: 8 });
  });

  it('gives a new learner empty lists, not errors', async () => {
    byTable = {};
    mockLoadProjection.mockResolvedValue({ nodes: [], edges: [] });
    const { body } = await summary();
    expect(body).toMatchObject({
      workspace: { recent: [] },
      projects: { built: 0, learned: 0, recent: [] },
      brain: { interests: [], conceptCount: 0 },
      recommendations: [],
    });
  });

  it('never resolves a model', async () => {
    await summary();
    expect(mockResolveModel).not.toHaveBeenCalled();
  });
});
