import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Writing to the brain: events in, projection out.
 *
 * The projection's own logic is packages/core's and is tested there. What this
 * suite owns is the plumbing around it — that an event row is written in the
 * shape the migration expects, that a duplicate is a quiet no-op, that the log
 * is paged past PostgREST's row cap, that the projection reaches the database
 * through the one RPC allowed to write it, and that distillation spends money
 * only behind the budget check.
 */

/* ------------------------------------------------------------------ *
 * A Supabase double
 * ------------------------------------------------------------------ */

const state = {
  inserts: [] as Array<Record<string, unknown>>,
  insertError: null as { code?: string; message: string } | null,
  /** Pages of event rows, served one per `.range()` call. */
  pages: [] as unknown[][],
  ranges: [] as Array<[number, number]>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcResult: { data: true as unknown, error: null as { message: string } | null },
};

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  c['insert'] = vi.fn((row: Record<string, unknown>) => {
    state.inserts.push(row);
    return Promise.resolve({ error: state.insertError });
  });
  for (const method of ['select', 'eq', 'order']) c[method] = vi.fn(() => c);
  c['range'] = vi.fn((from: number, to: number) => {
    state.ranges.push([from, to]);
    return Promise.resolve({ data: state.pages.shift() ?? [], error: null });
  });
  return c;
}

const mockDb = {
  from: vi.fn(() => chain()),
  rpc: vi.fn((name: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ name, args });
    return Promise.resolve(state.rpcResult);
  }),
};

const { mockCheckBudget, mockRecordUsage, mockCreateProvider } = vi.hoisted(() => ({
  mockCheckBudget: vi.fn(),
  mockRecordUsage: vi.fn(),
  mockCreateProvider: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  db: () => mockDb,
  checkBudget: mockCheckBudget,
  recordUsage: mockRecordUsage,
}));

vi.mock('../src/knowledge.js', () => ({
  knowledgeBundle: () => ({
    index: null,
    concepts: [
      { path: '/concepts/closures.md', type: 'concept', title: 'Closures', tags: [], status: 'stable', body: '' },
      { path: '/concepts/old.md', type: 'concept', title: 'Old', tags: [], status: 'deprecated', body: '' },
    ],
  }),
}));

vi.mock('@ai-edu/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/llm')>()),
  createProviderForTask: mockCreateProvider,
}));

const brain = await import('../src/brain.js');

const USER = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';

function questionRow(id: string, minute: number) {
  return {
    id,
    kind: 'question_asked',
    source_kind: 'thread',
    source_id: THREAD,
    dedupe_key: `question:${id}`,
    payload: { threadId: THREAD, messageId: `m-${id}`, canonical: 'closures', fingerprint: 'fp', query: 'closures?' },
    created_at: new Date(Date.UTC(2026, 9, 21, 9, minute)).toISOString(),
  };
}

beforeEach(() => {
  state.inserts = [];
  state.insertError = null;
  state.pages = [];
  state.ranges = [];
  state.rpcCalls = [];
  state.rpcResult = { data: true, error: null };
  vi.clearAllMocks();
  mockCheckBudget.mockResolvedValue({ exceeded: false, spentUSD: 0, limitUSD: 10, hasUnpricedUsage: false });
});

/* ------------------------------------------------------------------ */

describe('fingerprints', () => {
  it('are sha256 of the canonical form', () => {
    expect(brain.fingerprintOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('match across polite rephrasings of one question', () => {
    const a = brain.describeQuestion('Can you explain closures?');
    const b = brain.describeQuestion('closures, please');
    expect(a).toEqual({ canonical: 'closures', fingerprint: brain.fingerprintOf('closures') });
    expect(b).toEqual(a);
  });

  it('are empty for a question that was only filler', () => {
    expect(brain.describeQuestion('please explain')).toEqual({ canonical: '', fingerprint: '' });
  });
});

describe('appendBrainEvent', () => {
  const input = {
    userId: USER,
    kind: 'offer_dismissed' as const,
    sourceKind: 'thread' as const,
    sourceId: THREAD,
    dedupeKey: 'dismiss:1',
    payload: { conceptKey: 'closures' },
  };

  it('writes the row in the shape the migration defines', async () => {
    await expect(brain.appendBrainEvent(input)).resolves.toBe(true);
    expect(state.inserts).toEqual([
      {
        user_id: USER,
        kind: 'offer_dismissed',
        source_kind: 'thread',
        source_id: THREAD,
        dedupe_key: 'dismiss:1',
        payload: { conceptKey: 'closures' },
      },
    ]);
  });

  it('treats an already-recorded occurrence as a quiet no-op', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.insertError = { code: '23505', message: 'duplicate key value' };
    await expect(brain.appendBrainEvent(input)).resolves.toBe(false);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('reports any other failure without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.insertError = { code: '42501', message: 'permission denied' };
    await expect(brain.appendBrainEvent(input)).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('rebuildProjection', () => {
  it('writes the projection through the one RPC allowed to, with the watermark', async () => {
    state.pages = [[questionRow('e1', 0), questionRow('e2', 1)]];
    await expect(brain.rebuildProjection(USER)).resolves.toBe(true);

    expect(state.rpcCalls).toHaveLength(1);
    const { name, args } = state.rpcCalls[0] as { name: string; args: Record<string, unknown> };
    expect(name).toBe('brain_replace_projection');
    expect(args['p_user_id']).toBe(USER);
    expect(args['p_watermark_id']).toBe('e2');
    expect(args['p_nodes']).toEqual([
      expect.objectContaining({
        id: `session:thread:${THREAD}`,
        kind: 'session',
        first_seen_at: questionRow('e1', 0).created_at,
        last_seen_at: questionRow('e2', 1).created_at,
      }),
    ]);
    expect(args['p_fingerprints']).toEqual([
      expect.objectContaining({ fingerprint: 'fp', thread_id: THREAD, message_id: 'm-e1' }),
    ]);
  });

  it('pages through the log past the row cap', async () => {
    state.pages = [
      Array.from({ length: 1000 }, (_, i) => questionRow(`a${String(i).padStart(4, '0')}`, 0)),
      [questionRow('z', 5)],
    ];
    await brain.rebuildProjection(USER);
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect((state.rpcCalls[0]?.args as Record<string, unknown>)['p_watermark_id']).toBe('z');
  });

  it('skips a malformed event rather than losing the whole brain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.pages = [[{ ...questionRow('bad', 0), payload: { broken: true } }, questionRow('ok', 1)]];
    await brain.rebuildProjection(USER);
    expect((state.rpcCalls[0]?.args as Record<string, unknown>)['p_watermark_id']).toBe('ok');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not touch the database for an empty log', async () => {
    await expect(brain.rebuildProjection(USER)).resolves.toBe(true);
    expect(state.rpcCalls).toEqual([]);
  });

  it('reports a snapshot that lost the race as false, not as an error', async () => {
    state.pages = [[questionRow('e1', 0)]];
    state.rpcResult = { data: false, error: null };
    await expect(brain.rebuildProjection(USER)).resolves.toBe(false);
  });
});

describe('recordBrainEvent', () => {
  const input = {
    userId: USER,
    kind: 'question_asked' as const,
    sourceKind: 'thread' as const,
    sourceId: THREAD,
    dedupeKey: 'question:e1',
    payload: questionRow('e1', 0).payload,
  };

  it('rebuilds after recording a new event', async () => {
    state.pages = [[questionRow('e1', 0)]];
    await brain.recordBrainEvent(input);
    expect(state.inserts).toHaveLength(1);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('does not rebuild for a duplicate', async () => {
    state.insertError = { code: '23505', message: 'duplicate' };
    await brain.recordBrainEvent(input);
    expect(state.rpcCalls).toEqual([]);
  });

  it('never throws, even when the rebuild fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.pages = [[questionRow('e1', 0)]];
    state.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(brain.recordBrainEvent(input)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('distillQa', () => {
  const args = {
    userId: USER,
    threadId: THREAD,
    messageId: 'msg-1',
    question: '<learner_question>what is a closure?</learner_question>',
    conceptsAnswer: '- **Closures**: …',
  };

  function fakeProvider(data: unknown) {
    return {
      id: 'openai-compatible',
      modelId: 'gemini-3.7-flash',
      structured: vi.fn(async () => ({
        data,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'gemini',
        strategy: 'native-schema',
        repaired: false,
      })),
    };
  }

  it('records a normalised extraction as a qa_distilled event, and accounts for the call', async () => {
    const provider = fakeProvider({
      concepts: [{ label: 'Closures', okfPath: '/concepts/closures.md' }, { label: 'closures', okfPath: null }],
      insights: [],
      mistakes: [],
    });
    mockCreateProvider.mockReturnValue(provider);
    state.pages = [[]];

    await brain.distillQa(args);

    expect(mockCreateProvider).toHaveBeenCalledWith('utility');
    expect(mockRecordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, task: 'brain:extract' }));
    expect(state.inserts).toEqual([
      expect.objectContaining({
        kind: 'qa_distilled',
        dedupe_key: 'distill:msg-1',
        source_id: THREAD,
        payload: {
          threadId: THREAD,
          messageId: 'msg-1',
          extraction: { concepts: [{ label: 'Closures', okfPath: '/concepts/closures.md' }], insights: [], mistakes: [] },
        },
      }),
    ]);

    // The library offered to the model leaves deprecated concepts out.
    const request = (provider.structured.mock.calls[0] as unknown[])[0] as { messages: Array<{ content: string }> };
    expect(request.messages[0]?.content).toContain('/concepts/closures.md');
    expect(request.messages[0]?.content).not.toContain('/concepts/old.md');
  });

  it('spends nothing once the learner is over budget', async () => {
    mockCheckBudget.mockResolvedValue({ exceeded: true, spentUSD: 10, limitUSD: 10, hasUnpricedUsage: false });
    await brain.distillQa(args);
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
  });

  it('records nothing when the answer named no concepts', async () => {
    mockCreateProvider.mockReturnValue(fakeProvider({ concepts: [], insights: [], mistakes: [] }));
    await brain.distillQa(args);
    expect(state.inserts).toEqual([]);
  });

  it('swallows a provider failure — distillation must never break an answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateProvider.mockReturnValue({
      id: 'x',
      modelId: 'y',
      structured: vi.fn(async () => {
        throw new Error('upstream down');
      }),
    });
    await expect(brain.distillQa(args)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
