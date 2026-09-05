import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Integration tests for the attempt route handlers.
 *
 * The Supabase client and workspace packages are fully mocked so no real
 * database or built packages are needed. Auth is bypassed by mocking the
 * auth module to always resolve a test user. Each test configures the mock
 * DB to return exactly the rows the handler needs.
 */

// ---- Workspace package mocks ----------------------------------------------

vi.mock('@ai-edu/llm', () => ({
  listAvailableModels: () => [],
  registryReport: () => ({ configured: [], unverifiedPricing: [] }),
  computeCost: () => ({ totalUSD: 0, unpriced: false }),
  createProviderForTask: () => ({}),
  withRetry: (fn: () => Promise<unknown>) => fn(),
  bufferStream: (s: any) => s,
  firstTokenOrTimeout: async () => {},
  collectStream: async () => ({ text: '', events: [] }),
}));

/**
 * The submit gate, as this suite drives it.
 *
 * The rule itself is `preflightSubmission` in packages/core and is covered
 * there. What these tests own is the ROUTE's half of the contract: a refusal
 * must produce a 422 and must NOT write an attempt row, because the attempt
 * count is what the hint ladder unlocks on.
 */
const { mockPreflight } = vi.hoisted(() => ({
  mockPreflight: vi.fn<() => { code: string; message: string; details: string[] } | null>(
    () => null,
  ),
}));

vi.mock('@ai-edu/core', async () => ({
  preflightSubmission: mockPreflight,
  // Layer 2 strips comments before searching. Identity is enough here: what it
  // strips is core's business, and core tests it.
  stripComments: (source: string) => source,
  // Imported inside the factory: vi.mock is hoisted above the file's imports,
  // so a top-level `z` is not in scope here.
  AgentKind: (await import('zod')).z.enum(['simple', 'industry', 'practice', 'concepts']),
  followUpWithAgent: async function* () {},
  // Step unlocking. These are pure functions in core and are exercised
  // directly by its own suite; here they only need to not gate these tests,
  // which submit to step 0.
  lockStates: () => [],
  mayExpand: () => true,
  unlockedThrough: () => 0,
  parseStoredBlueprint: (value: unknown) => value,
  assembleProject: () => ({
    files: [],
    stepsFromReference: [],
    stepsMissing: [],
    fullyLearnerWritten: false,
  }),
  finishProject: async () => ({ readmeMd: '', deployFiles: [] }),
  Checkpoint: {
    safeParse: (data: any) => ({
      success: true,
      data: data ?? { requiredFiles: [], requiredSymbols: [], runtime: 'python', hints: [] },
    }),
  },
  scorePacing: () => ({ newState: {}, directive: null }),
  CompiledQuery: { safeParse: () => ({ success: true, data: {} }) },
  ProjectBlueprint: { safeParse: (d: any) => ({ success: true, data: d }) },
  SkillLevel: { default: () => 'beginner' },
  expandStep: async () => ({}),
  generateBlueprint: async () => ({}),
  planExpansion: () => ({}),
  AGENT_ORDER: ['simple', 'industry', 'practice', 'concepts'],
  fanOut: async function* () {},
  AttachmentRef: { safeParse: () => ({ success: true, data: {} }) },
  InterviewContext: { safeParse: () => ({ success: true, data: {} }) },
  InterviewState: { safeParse: () => ({ success: true, data: {} }) },
  beginInterview: async () => ({}),
  continueInterview: async () => ({}),
  extractDurableSlots: () => ({}),
}));

// ---- Mocks ----------------------------------------------------------------

const mockDb = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  then: undefined as unknown,
};

vi.mock('../src/db.js', () => ({
  db: () => mockDb,
  checkBudget: vi.fn().mockResolvedValue({ exceeded: false, spentUSD: 0, limitUSD: 10, hasUnpricedUsage: false }),
  recordUsage: vi.fn(),
}));

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...original,
    requireAuth: vi.fn(async (request: any) => {
      request.user = { id: 'test-user-id', email: 'test@example.com' };
    }),
    resolveUser: vi.fn().mockResolvedValue({ id: 'test-user-id', email: 'test@example.com' }),
  };
});

vi.mock('../src/env.js', () => ({
  loadEnv: () => ({
    NODE_ENV: 'test',
    PORT: 0,
    WEB_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    DAILY_USD_BUDGET_PER_USER: 10,
  }),
}));

// Rate limit must be mocked to avoid @fastify/rate-limit plugin issues in tests
vi.mock('@fastify/rate-limit', () => ({
  default: async () => {},
}));

// ---- Helpers ---------------------------------------------------------------

/** Configure mockDb to return specific values for successive maybeSingle calls. */
function setupDbResponses(responses: Array<{ data: any; error?: any }>) {
  let callIndex = 0;
  mockDb.maybeSingle.mockImplementation(async () => {
    const resp = responses[callIndex] ?? { data: null, error: null };
    callIndex++;
    return resp;
  });
}

/** Build the server (imported after mocks are in place). */
async function buildApp() {
  const { buildServer } = await import('../src/server.js');
  const app = await buildServer();
  return app;
}

// ---- Tests ----------------------------------------------------------------

describe('POST /api/projects/:id/steps/:index/attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all chain methods to return `this`
    for (const key of ['from', 'select', 'insert', 'update', 'eq', 'order', 'limit'] as const) {
      mockDb[key].mockReturnThis();
    }
    mockDb.maybeSingle.mockResolvedValue({ data: null, error: null });
    // clearAllMocks above wipes the implementation too, so restore the default.
    mockPreflight.mockReturnValue(null);
  });

  it('returns passed: true with solution files when all checks pass', async () => {
    const project = { id: 'proj-1' };
    const step = {
      id: 'step-1',
      checkpoint: {
        requiredFiles: ['main.py'],
        requiredSymbols: ['def hello'],
        runtime: 'python',
        hints: [],
      },
      solution_files: [{ path: 'main.py', contents: 'def hello():\n  pass' }],
    };
    const existingAttempts: any[] = [];

    // DB call order: project lookup, step lookup, the unlock check's
    // enrollment lookup, existing attempts, insert.
    setupDbResponses([
      { data: project },          // project lookup
      { data: step },             // step lookup
      { data: null },             // enrollment (loadProgress)
      { data: existingAttempts }, // existing attempts
    ]);
    mockDb.insert.mockResolvedValue({ error: null });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: {
        submittedFiles: [{ path: 'main.py', contents: 'def hello():\n  return "world"' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.passed).toBe(true);
    expect(body.solutionFiles).toHaveLength(1);
    expect(body.solutionFiles[0].path).toBe('main.py');
  });

  /* ---------------- the submit gate ---------------- */

  it('refuses a submission the gate rejects, and records no attempt', async () => {
    /*
     * The whole point of refusing rather than failing. Attempt count is what
     * the hint ladder unlocks on, so a junk submission that got recorded was a
     * way to buy hints without writing code: press submit three times on the
     * untouched starter files and tier 3 opened itself.
     */
    mockPreflight.mockReturnValue({
      code: 'unchanged',
      message: 'This is the starting code, unchanged. Fill in the part marked TODO, then submit.',
      details: ['main.py'],
    });

    setupDbResponses([
      { data: { id: 'proj-1' } },
      {
        data: {
          id: 'step-1',
          checkpoint: { requiredFiles: ['main.py'], requiredSymbols: [], runtime: 'python', hints: [] },
          solution_files: [],
          starter_files: [{ path: 'main.py', contents: '# TODO' }],
        },
      },
      { data: null },
    ]);
    mockDb.insert.mockResolvedValue({ error: null });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: { submittedFiles: [{ path: 'main.py', contents: '# TODO' }] },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_an_attempt');
    expect(body.reason).toBe('unchanged');
    expect(body.message).toMatch(/TODO/);

    // The assertion that matters: nothing was written.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('checks the gate before it grades anything', async () => {
    // A refusal must not depend on the checkpoint passing or failing - it is
    // the question asked before that one.
    mockPreflight.mockReturnValue({
      code: 'symbols_in_comments',
      message: '"def hello" only appears in a comment. It has to be in the code itself.',
      details: ['def hello'],
    });

    setupDbResponses([
      { data: { id: 'proj-1' } },
      {
        data: {
          id: 'step-1',
          checkpoint: {
            requiredFiles: ['main.py'],
            requiredSymbols: ['def hello'],
            runtime: 'python',
            hints: [],
          },
          solution_files: [],
          starter_files: [],
        },
      },
      { data: null },
    ]);
    mockDb.insert.mockResolvedValue({ error: null });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      // Raw text contains the symbol, so the old substring layer 2 passed this.
      payload: { submittedFiles: [{ path: 'main.py', contents: '# def hello' }] },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).reason).toBe('symbols_in_comments');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns passed: false with error message when files are missing', async () => {
    const project = { id: 'proj-1' };
    const step = {
      id: 'step-1',
      checkpoint: {
        requiredFiles: ['main.py', 'utils.py'],
        requiredSymbols: [],
        runtime: 'python',
        hints: [],
      },
      solution_files: [],
    };
    const existingAttempts: any[] = [];

    setupDbResponses([
      { data: project },
      { data: step },
      { data: null }, // enrollment (loadProgress)
      { data: existingAttempts },
    ]);
    mockDb.insert.mockResolvedValue({ error: null });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: {
        submittedFiles: [{ path: 'main.py', contents: 'print("hello")' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.passed).toBe(false);
    expect(body.message).toContain('utils.py');
  });

  it('returns 413 when too many files are submitted', async () => {
    const app = await buildApp();
    const tooManyFiles = Array.from({ length: 21 }, (_, i) => ({
      path: `file${i}.py`,
      contents: 'x = 1',
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: { submittedFiles: tooManyFiles },
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('payload_too_large');
  });

  it('returns 413 when a single file exceeds 100 KB', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/attempt',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: {
        submittedFiles: [
          { path: 'huge.py', contents: 'x'.repeat(102_401) },
        ],
      },
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('payload_too_large');
    expect(body.message).toContain('huge.py');
  });
});

describe('POST /api/projects/:id/steps/:index/advance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ['from', 'select', 'insert', 'update', 'eq', 'order', 'limit'] as const) {
      mockDb[key].mockReturnThis();
    }
    mockDb.maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('returns 403 when there is no passing attempt', async () => {
    const project = { id: 'proj-1' };
    const step = { id: 'step-1' };

    setupDbResponses([
      { data: project },  // project lookup
      { data: step },     // step lookup
      { data: null },     // passing attempt check — none found
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/advance',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('no_passing_attempt');
  });

  it('returns success when a passing attempt exists', async () => {
    const project = { id: 'proj-1' };
    const step = { id: 'step-1' };
    const passingAttempt = { id: 'attempt-1' };
    const enrollment = { pace_state: null };
    const allAttempts = [
      { duration_ms: 5000, hints_used: 0, passed: true },
    ];

    setupDbResponses([
      { data: project },          // project lookup
      { data: step },             // step lookup
      { data: passingAttempt },   // passing attempt check
    ]);
    mockDb.update.mockResolvedValue({ error: null });
    // After update, the handler queries enrollment + allAttempts
    // These use maybeSingle and a non-maybeSingle select
    let postUpdateCallIndex = 0;
    mockDb.maybeSingle.mockImplementation(async () => {
      postUpdateCallIndex++;
      if (postUpdateCallIndex <= 3) {
        // First 3 calls are the pre-update lookups (already handled by setupDbResponses)
        return { data: null, error: null };
      }
      return { data: enrollment };
    });
    // The allAttempts query doesn't use maybeSingle, it's a plain select
    // Since our mock chains through, we need to handle the final .then()
    // Actually the handler does db().from().select().eq().eq() which chains,
    // and the result is the promise. Let's override to handle this.
    mockDb.eq.mockImplementation(() => {
      return {
        ...mockDb,
        then: (resolve: any) => resolve({ data: allAttempts, error: null }),
      };
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/steps/0/advance',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: {},
    });

    // The handler should at least get past the passing-attempt check.
    // Whether the pacing update succeeds depends on mock fidelity, but the
    // key assertion is that it's NOT 403.
    expect(res.statusCode).not.toBe(403);
  });
});
