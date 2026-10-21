import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMEvent, LLMRequest } from '@ai-edu/llm';

/**
 * Memory, end to end through the fan-out route.
 *
 * The placement rules are proven in packages/core (prompt-stability). What
 * this suite owns is the wiring: that the route recalls the learner's memory,
 * hands the SAME block to all four agents, tells the browser what was
 * recalled, and still answers when recall comes back empty.
 *
 * The real route and the real fan-out run; the provider, database, gateway
 * and brain loader are doubles.
 */

const { mockRecallMemory, requests } = vi.hoisted(() => ({
  mockRecallMemory: vi.fn(),
  requests: [] as LLMRequest[],
}));

const fakeProvider = {
  id: 'fake',
  modelId: 'fake-model',
  capabilities: {
    explicitCaching: false,
    structuredOutput: 'native-schema',
    midConversationSystem: true,
    reasoningControl: 'effort',
    maxContext: 100_000,
    maxOutputTokens: 8_000,
    supportsFileUpload: false,
    supportsImages: false,
  },
  stream: (request: LLMRequest): AsyncIterable<LLMEvent> => {
    requests.push(request);
    return (async function* () {
      yield { type: 'start', model: 'fake-model' };
      yield { type: 'text_delta', text: 'answer' };
      yield {
        type: 'done',
        response: {
          text: 'answer',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: 'end_turn',
          model: 'fake-model',
        },
      };
    })();
  },
};

vi.mock('@ai-edu/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/llm')>()),
  createProviderForTask: () => fakeProvider,
}));

vi.mock('../src/gateway.js', () => ({
  screenOrThrow: async (text: string) => text,
  gatewayErrorReply: () => null,
}));

/** Every insert resolves, and `.select().single()` hands back an id. */
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'select', 'eq']) c[m] = vi.fn(() => c);
  c['single'] = vi.fn(async () => ({ data: { id: '44444444-4444-4444-8444-444444444444' }, error: null }));
  c['maybeSingle'] = vi.fn(async () => ({ data: null, error: null }));
  c['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
  return c;
}

vi.mock('../src/db.js', () => ({
  db: () => ({ from: () => chain() }),
  checkBudget: async () => ({ exceeded: false, spentUSD: 0, limitUSD: 10, hasUnpricedUsage: false }),
  recordUsage: async () => {},
}));

vi.mock('../src/knowledge.js', () => ({ knowledgeBundle: () => null }));

vi.mock('../src/brain.js', () => ({
  recallMemory: mockRecallMemory,
  memoryQueryFor: (compiled: { originalQuery: string }) => compiled.originalQuery,
  describeQuestion: () => ({ canonical: '', fingerprint: '' }),
  recordBrainEvent: async () => {},
  distillQa: async () => {},
}));

vi.mock('../src/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth.js')>()),
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: 'user-1', email: 'learner@example.com' };
  }),
}));

type App = ReturnType<typeof Fastify>;
let app: App;

beforeAll(async () => {
  const { agentRoutes } = await import('../src/routes/agents.js');
  app = Fastify();
  await app.register(agentRoutes);
  await app.ready();
}, 60_000);

beforeEach(() => {
  requests.length = 0;
  mockRecallMemory.mockReset();
});

const compiled = {
  intent: 'concept_question',
  originalQuery: 'how do closures work?',
  text: '<learner_question>\nhow do closures work?\n</learner_question>',
  slots: {},
  attachments: [],
  partial: false,
};

/** The SSE body as a list of { event, data }. */
function events(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine!.slice('event: '.length), data: JSON.parse(dataLine!.slice('data: '.length)) };
    });
}

const userTurnTexts = (request: LLMRequest): string[] =>
  ((request.messages.at(-2)?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '');

describe('POST /api/agents/ask with memory', () => {
  const block = {
    text: '<learner_memory>\nMastery — explain fully: Closures (0.30)\n</learner_memory>',
    items: [{ nodeId: 'concept:closures', kind: 'concept', label: 'Closures', sourceId: null }],
    tokens: 20,
  };

  it('recalls for the caller and gives all four agents the same memory block', async () => {
    mockRecallMemory.mockResolvedValue(block);
    const res = await app.inject({ method: 'POST', url: '/api/agents/ask', payload: { compiled } });

    expect(res.statusCode).toBe(200);
    expect(mockRecallMemory).toHaveBeenCalledWith('user-1', 'how do closures work?');
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      const texts = userTurnTexts(request);
      expect(texts).toContain(block.text);
      expect(texts.indexOf(block.text)).toBeLessThan(texts.indexOf(compiled.text));
    }
  });

  it('tells the browser what was recalled, in the meta event', async () => {
    mockRecallMemory.mockResolvedValue(block);
    const res = await app.inject({ method: 'POST', url: '/api/agents/ask', payload: { compiled } });
    const meta = events(res.body).find((e) => e.event === 'meta');
    expect(meta?.data['memory']).toEqual(block.items);
  });

  it('answers exactly as before when there is nothing to recall', async () => {
    mockRecallMemory.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/api/agents/ask', payload: { compiled } });

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(userTurnTexts(request).some((t) => t.includes('<learner_memory>'))).toBe(false);
    }
    const meta = events(res.body).find((e) => e.event === 'meta');
    expect(meta?.data['memory']).toEqual([]);
    expect(events(res.body).some((e) => e.event === 'done')).toBe(true);
  });
});
