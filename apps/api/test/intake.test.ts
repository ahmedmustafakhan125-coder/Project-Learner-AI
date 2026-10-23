import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import tauri from '../../../packages/core/test/fixtures/briefs/tauri.json';

/**
 * The intake routes (docs/project-learner.md §12), end to end over an
 * in-memory database: scope by code, research, the brief and its two
 * regenerations, approval, the plan against the brief, and the project built
 * from the row alone. Then the template path: a very similar stored project
 * is adapted, its dossier and brief copied with no call, and its step 1
 * served when unchanged.
 *
 * Model calls are faked at the core functions; profile, tier, brief checks
 * and techStackFromBrief run for real.
 */

const KNOWN = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  recordUsage: vi.fn(),
  checkBudget: vi.fn(),
  classifyQuery: vi.fn(),
  generateBrief: vi.fn(),
  generatePlannedBlueprint: vi.fn(),
  runProjectResearch: vi.fn(),
  createProviderForStage: vi.fn(),
  user: { id: 'user-1' },
}));

/* ---------------- a small in-memory PostgREST ---------------- */

const DEFAULTS: Record<string, () => Row> = {
  project_intakes: () => ({
    signals: {},
    tier_reasons: [],
    dossier: null,
    research_summary: null,
    brief: null,
    brief_revisions: [],
    blueprint: null,
    blueprint_revisions: 0,
    generation_models: {},
    template_project_id: null,
    status: 'scoped',
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  }),
};

let clock = 0;
function from(table: string) {
  const rows = () => (mocks.tables[table] ??= []);
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row | Row[] = {};
  let limit = Infinity;
  let order: { column: string; ascending: boolean } | null = null;
  let done: Row[] | null = null;

  const run = (): Row[] => {
    if (done) return done;
    if (op === 'insert') {
      const inserted = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
        id: randomUUID(),
        created_at: new Date(1_000_000 + (clock += 1)).toISOString(),
        ...(DEFAULTS[table]?.() ?? {}),
        ...p,
      }));
      rows().push(...inserted);
      return (done = inserted);
    }
    let matched = rows().filter((r) => filters.every((f) => f(r)));
    if (op === 'update') matched.forEach((r) => Object.assign(r, structuredClone(payload)));
    if (op === 'delete') mocks.tables[table] = rows().filter((r) => !matched.includes(r));
    if (order) {
      const { column, ascending } = order;
      matched = [...matched].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    return (done = matched.slice(0, limit).map((r) => structuredClone(r)));
  };

  const chain: Record<string, unknown> = {
    select: () => chain,
    insert: (v: Row | Row[]) => ((op = 'insert'), (payload = structuredClone(v)), chain),
    update: (v: Row) => ((op = 'update'), (payload = v), chain),
    delete: () => ((op = 'delete'), chain),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
    not: (c: string) => (filters.push((r) => r[c] !== null && r[c] !== undefined), chain),
    order: (column: string, o: { ascending: boolean }) => ((order = { column, ascending: o.ascending }), chain),
    limit: (n: number) => ((limit = n), chain),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: run(), error: null }),
  };
  return chain;
}

vi.mock('../src/db.js', () => ({
  db: () => ({ from, rpc: async () => ({ data: 0, error: null }) }),
  checkBudget: mocks.checkBudget,
  recordUsage: mocks.recordUsage,
}));

vi.mock('../src/auth.js', () => ({
  requireAuth: async (request: { user?: unknown }) => {
    request.user = { id: mocks.user.id, email: null };
  },
  userOf: (request: { user: unknown }) => request.user,
}));

vi.mock('../src/gateway.js', () => ({
  screenOrThrow: async (text: string) => text,
  gatewayErrorReply: () => null,
}));

vi.mock('../src/brain.js', () => ({
  recallMemory: async () => null,
  memoryQueryFor: () => '',
  forgetSource: async () => {},
}));

vi.mock('../src/knowledge.js', () => ({ techCards: () => [], docSources: () => ({}) }));

vi.mock('../src/research.js', () => ({ runProjectResearch: mocks.runProjectResearch }));

vi.mock('../src/progress.js', () => ({ loadProgress: async () => ({ steps: [], locks: [], unlockedThrough: 0 }), canExpand: () => true }));

vi.mock('@ai-edu/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/llm')>()),
  createProviderForTask: () => ({
    id: 'openai-compatible',
    modelId: 'gemini-3.6-flash',
    structured: async () => ({ data: {}, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  }),
  createProviderForStage: mocks.createProviderForStage,
}));

vi.mock('@ai-edu/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/core')>()),
  classifyQuery: mocks.classifyQuery,
  generateBrief: mocks.generateBrief,
  generatePlannedBlueprint: mocks.generatePlannedBlueprint,
}));

const core = await import('@ai-edu/core');
const { PROJECT_TIERS } = await import('@ai-edu/llm');
const { resetEnvCache } = await import('../src/env.js');
const { intakeRoutes, MAX_REGENERATIONS } = await import('../src/routes/intake.js');
const { projectRoutes } = await import('../src/routes/projects.js');

const BRIEF = core.StackBrief.parse((tauri as { brief: unknown }).brief);
const DOSSIER = core.ResearchDossier.parse((tauri as { dossier: unknown }).dossier);

const compiled = (query: string) => ({
  intent: 'project_generation' as const,
  originalQuery: query,
  text: `<learner_question>\n${query}\n</learner_question>`,
  slots: {
    domain: { value: 'notes app', source: 'query' as const },
    tech: { value: 'Tauri', source: 'query' as const },
  },
  attachments: [],
  partial: false,
});

const SIGNALS = { domainWords: ['desktop', 'notes'], interfaces: ['desktop'], persistence: 'embedded-db' as const };

function planned(title = 'Notes') {
  const step = (t: string, creates: string[], edits: string[] = []) => ({
    title: t,
    objective: `${t} works.`,
    concepts: [],
    estMinutes: 45,
    creates,
    edits,
    docRefs: ['d1'],
  });
  return {
    title,
    summary: 'A notes app.',
    learningObjectives: ['IPC'],
    techStack: core.techStackFromBrief(BRIEF),
    prerequisites: [],
    estimatedHours: 6,
    finalFileTree: [
      { path: 'src-tauri/src/core/notes.rs', purpose: 'logic' },
      { path: 'src-tauri/src/commands.rs', purpose: 'IPC' },
      { path: 'src/main.ts', purpose: 'UI' },
    ],
    deployment: { target: 'local' as const, rationale: 'desktop', artifacts: [], taught: false },
    steps: [
      step('Core', ['src-tauri/src/core/notes.rs']),
      step('IPC', ['src-tauri/src/commands.rs']),
      step('UI', ['src/main.ts'], ['src-tauri/src/commands.rs']),
    ],
  };
}

async function server() {
  const app = Fastify();
  await app.register(intakeRoutes);
  await app.register(projectRoutes);
  return app;
}

type App = Awaited<ReturnType<typeof server>>;
const post = (app: App, url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: payload as object });

beforeEach(() => {
  process.env['SUPABASE_URL'] = 'http://127.0.0.1:54321';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role';
  process.env['PROJECT_LEARNER'] = 'on';
  resetEnvCache();
  vi.clearAllMocks();
  mocks.tables = {};
  mocks.user.id = 'user-1';
  mocks.checkBudget.mockResolvedValue({ exceeded: false, spentUSD: 0, limitUSD: 5, hasUnpricedUsage: false });
  mocks.classifyQuery.mockResolvedValue({ intent: 'project_generation', extracted: {}, reasoning: '', signals: SIGNALS });
  mocks.createProviderForStage.mockImplementation((stage: string) => ({
    provider: { id: 'anthropic', modelId: stage === 'blueprint' ? 'claude-opus-5-5' : 'claude-sonnet-5-5' },
    reasoning: 'medium',
    maxTokens: 8000,
  }));
  mocks.runProjectResearch.mockResolvedValue({
    dossier: DOSSIER,
    limitedSources: false,
    fromCards: ['tauri', 'sqlite'],
    fromCache: [],
    researched: [],
    failed: [],
    uncovered: [],
    violations: [],
    usage: KNOWN,
    model: 'claude-sonnet-5-5',
  });
  mocks.generateBrief.mockResolvedValue({ data: { brief: BRIEF, repaired: [], attempts: 1 }, usage: KNOWN });
  mocks.generatePlannedBlueprint.mockImplementation(async () => ({
    data: { blueprint: planned(), violations: [], attempts: 1 },
    usage: KNOWN,
  }));
});

afterEach(() => {
  delete process.env['PROJECT_LEARNER'];
  resetEnvCache();
});

/** Intake to an approved brief, returning the intake id. */
async function toApproved(app: App, query = 'A Tauri notes app'): Promise<string> {
  const scoped = await post(app, '/api/projects/intake', { compiled: compiled(query) });
  expect(scoped.statusCode, scoped.body).toBe(201);
  const { intakeId } = scoped.json();
  expect((await post(app, `/api/projects/intake/${intakeId}/research`)).statusCode).toBe(200);
  expect((await post(app, `/api/projects/intake/${intakeId}/stack-brief`)).statusCode).toBe(200);
  expect((await post(app, `/api/projects/intake/${intakeId}/stack-brief/approve`)).statusCode).toBe(200);
  return intakeId;
}

describe('POST /api/projects/intake', () => {
  it('scopes in code from the classify signals and stores the row', async () => {
    const app = await server();
    const response = await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') });
    expect(response.statusCode, response.body).toBe(201);

    const expected = core.detectProfile(core.ScopeSignals.parse(SIGNALS), compiled('x').slots);
    const score = core.scoreComplexity(core.ScopeSignals.parse(SIGNALS), core.getProfile(expected.profile), compiled('x').slots);
    expect(response.json()).toMatchObject({ profile: 'desktop-app', tier: score.tier, reasons: score.reasons, adapted: false });
    expect(mocks.classifyQuery.mock.calls[0]![0]).toMatchObject({ scoping: true });

    const [row] = mocks.tables['project_intakes']!;
    expect(row).toMatchObject({ user_id: 'user-1', project_profile: 'desktop-app', tier: score.tier, status: 'scoped' });
  });

  it('records what the scope call spent under project:scope, and never an all-zero row', async () => {
    mocks.classifyQuery.mockImplementation(async ({ provider }: { provider: { structured: (...a: unknown[]) => Promise<unknown> } }) => {
      await provider.structured({}, null);
      return { intent: 'project_generation', extracted: {}, reasoning: '', signals: SIGNALS };
    });
    const app = await server();
    await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'project:scope', model: 'gemini-3.6-flash', usage: KNOWN }),
    );

    vi.clearAllMocks();
    mocks.classifyQuery.mockResolvedValue({ intent: 'project_generation', extracted: {}, reasoning: '', signals: SIGNALS });
    await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('answers 429 over the weekly project allowance, before any call', async () => {
    mocks.checkBudget.mockResolvedValue({ exceeded: true, spentUSD: 6, limitUSD: 5, hasUnpricedUsage: false });
    const app = await server();
    const response = await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('project_budget_exceeded');
    expect(mocks.checkBudget).toHaveBeenCalledWith('user-1', 'project');
    expect(mocks.classifyQuery).not.toHaveBeenCalled();
  });

  it('refuses a body without a compiled query', async () => {
    const app = await server();
    expect((await post(app, '/api/projects/intake', {})).statusCode).toBe(400);
  });
});

describe('PATCH /api/projects/intake/:id/scope', () => {
  it('moves the tier one step from what was scored, never two, and clears what research wrote', async () => {
    const app = await server();
    const { intakeId, tier } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    await post(app, `/api/projects/intake/${intakeId}/research`);

    const up = (await app.inject({ method: 'PATCH', url: `/api/projects/intake/${intakeId}/scope`, payload: { tierStep: 1 } })).json();
    const again = (await app.inject({ method: 'PATCH', url: `/api/projects/intake/${intakeId}/scope`, payload: { tierStep: 1 } })).json();
    const next = PROJECT_TIERS[PROJECT_TIERS.indexOf(tier) + 1];
    expect(up.tier).toBe(next);
    expect(again.tier).toBe(next);
    expect(up.reasons.at(-1)).toMatch(/Moved up one step by you/);

    const [row] = mocks.tables['project_intakes']!;
    expect(row).toMatchObject({ status: 'scoped', dossier: null, brief: null });
  });

  it('changes the profile and rescores the tier for it', async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    const response = await app.inject({ method: 'PATCH', url: `/api/projects/intake/${intakeId}/scope`, payload: { profile: 'general' } });
    expect(response.json().profile).toBe('general');
  });

  it("will not touch another learner's intake", async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    mocks.user.id = 'user-2';
    const response = await app.inject({ method: 'PATCH', url: `/api/projects/intake/${intakeId}/scope`, payload: { tierStep: 1 } });
    expect(response.statusCode).toBe(404);
  });
});

describe('round 2: the questions a bigger project gets', () => {
  it('asks a desktop app at T3 its own questions, and nothing the message already said', async () => {
    mocks.classifyQuery.mockResolvedValue({ intent: 'project_generation', extracted: { target_os: 'Windows' }, reasoning: '', signals: SIGNALS });
    const app = await server();
    const response = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app for Windows') })).json();
    expect(response.tier).toBe('T3');

    const asked = response.questions.map((q: { slot: string }) => q.slot);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(core.INTERVIEW_BUDGET.T3.questionsPerRound);
    // Stated in the message (target_os) or its signals (where it runs, what it stores); the stack settles the UI.
    for (const slot of ['target_os', 'interface', 'data', 'offline_data', 'ui_tech', 'domain', 'tech']) expect(asked).not.toContain(slot);

    const [row] = mocks.tables['project_intakes']!;
    const stored = row!['compiled_query'] as { slots: Record<string, { value: string }>; text: string };
    expect(stored.slots['target_os']?.value).toBe('Windows');
    expect(stored.text).toContain('Windows');
  });

  it('asks a small project nothing more', async () => {
    mocks.classifyQuery.mockResolvedValue({ intent: 'project_generation', extracted: {}, reasoning: '', signals: { domainWords: ['website'], interfaces: [] } });
    const app = await server();
    const small = {
      ...compiled('A website for my bakery'),
      slots: { domain: { value: 'website', source: 'query' as const }, tech: { value: 'React', source: 'query' as const } },
    };
    const response = (await post(app, '/api/projects/intake', { compiled: small })).json();
    expect(response.tier).toBe('T1');
    expect(response.questions).toEqual([]);
  });

  it('takes only the answers round 2 asked, scores the tier again and renders them for the plan', async () => {
    const app = await server();
    const { intakeId, questions } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    expect(questions.map((q: { slot: string }) => q.slot)).toContain('integrations');

    const response = await post(app, `/api/projects/intake/${intakeId}/answers`, {
      answers: { integrations: 'Payments', target_os: 'Windows, macOS', domain: 'something else', made_up: 'x' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const [row] = mocks.tables['project_intakes']!;
    const stored = row!['compiled_query'] as { slots: Record<string, { value: string; source: string }>; text: string };
    expect(stored.slots['integrations']).toEqual({ value: 'Payments', source: 'answer' });
    expect(stored.slots['target_os']?.value).toBe('Windows, macOS');
    expect(stored.slots['domain']?.value).toBe('notes app');
    expect(stored.slots['made_up']).toBeUndefined();
    expect(stored.text).toContain('Payments');
    expect(row!['signals']).toMatchObject({ payments: true });

    const signals = core.answerSignals(core.ScopeSignals.parse(SIGNALS), { integrations: 'Payments' });
    const score = core.scoreComplexity(signals, core.getProfile('desktop-app'), core.Slots.parse(stored.slots));
    expect(response.json()).toMatchObject({ profile: 'desktop-app', tier: score.tier, reasons: score.reasons });
    expect(row).toMatchObject({ tier: score.tier, tier_reasons: score.reasons });
  });

  it('refuses answers once research has started, and another learner’s intake', async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();

    mocks.user.id = 'user-2';
    expect((await post(app, `/api/projects/intake/${intakeId}/answers`, { answers: {} })).statusCode).toBe(404);

    mocks.user.id = 'user-1';
    await post(app, `/api/projects/intake/${intakeId}/research`);
    const late = await post(app, `/api/projects/intake/${intakeId}/answers`, { answers: { integrations: 'Email' } });
    expect(late.statusCode).toBe(409);
    expect((await post(app, `/api/projects/intake/${intakeId}/answers`, {})).statusCode).toBe(400);
  });
});

describe('research, brief and approval', () => {
  it('researches once from the row and records its usage', async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    const first = await post(app, `/api/projects/intake/${intakeId}/research`);
    const second = await post(app, `/api/projects/intake/${intakeId}/research`);
    expect(first.json().dossier.docRefs).toHaveLength(DOSSIER.docRefs.length);
    expect(second.json().fromCards).toEqual(['tauri', 'sqlite']);
    expect(mocks.runProjectResearch).toHaveBeenCalledTimes(1);
    expect(mocks.runProjectResearch.mock.calls[0]![0]).toMatchObject({ profile: { id: 'desktop-app' } });
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: 'project:research', usage: KNOWN }));
  });

  it('writes the brief only after research, against the stored dossier', async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    expect((await post(app, `/api/projects/intake/${intakeId}/stack-brief`)).statusCode).toBe(409);

    await post(app, `/api/projects/intake/${intakeId}/research`);
    const brief = await post(app, `/api/projects/intake/${intakeId}/stack-brief`);
    expect(brief.statusCode, brief.body).toBe(200);
    expect(brief.json()).toMatchObject({ reused: false, regenerationsLeft: MAX_REGENERATIONS });
    expect(brief.json().sources.length).toBeGreaterThan(0);
    expect(mocks.generateBrief.mock.calls[0]![0]).toMatchObject({ dossier: DOSSIER, reasoning: 'medium', maxTokens: 8000 });
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: 'project:brief', usage: KNOWN }));
  });

  it(`regenerates the brief ${MAX_REGENERATIONS} times, keeping each revision, then refuses`, async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    await post(app, `/api/projects/intake/${intakeId}/research`);
    const left = [];
    for (let i = 0; i <= MAX_REGENERATIONS; i += 1) {
      left.push((await post(app, `/api/projects/intake/${intakeId}/stack-brief`)).json().regenerationsLeft);
    }
    expect(left).toEqual([2, 1, 0]);
    const refused = await post(app, `/api/projects/intake/${intakeId}/stack-brief`);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('regenerate_limit');
    expect((mocks.tables['project_intakes']![0]!['brief_revisions'] as unknown[]).length).toBe(MAX_REGENERATIONS);
  });

  it('records what a rejected brief spent and answers 502', async () => {
    mocks.generateBrief.mockRejectedValue(new core.BriefRejectedError([], KNOWN));
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    await post(app, `/api/projects/intake/${intakeId}/research`);
    const response = await post(app, `/api/projects/intake/${intakeId}/stack-brief`);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('stack_brief_rejected');
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: 'project:brief', usage: KNOWN }));
  });

  it('plans only after approval, against the stored brief and dossier', async () => {
    const app = await server();
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    await post(app, `/api/projects/intake/${intakeId}/research`);
    await post(app, `/api/projects/intake/${intakeId}/stack-brief`);
    expect((await post(app, `/api/projects/intake/${intakeId}/blueprint`)).statusCode).toBe(409);

    await post(app, `/api/projects/intake/${intakeId}/stack-brief/approve`);
    const response = await post(app, `/api/projects/intake/${intakeId}/blueprint`, { teachDeployment: true });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ adapted: false, model: 'claude-opus-5-5' });
    expect(mocks.createProviderForStage.mock.calls.at(-1)![0]).toBe('blueprint');
    expect(mocks.generatePlannedBlueprint.mock.calls[0]![0]).toMatchObject({
      brief: BRIEF,
      dossier: DOSSIER,
      teachDeployment: true,
      template: null,
      profile: { id: 'desktop-app' },
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: 'project:blueprint', usage: KNOWN }));
  });
});

describe('POST /api/projects { intakeId }', () => {
  it('builds the project from the row: brief, dossier, tier and the server-side model', async () => {
    const app = await server();
    const intakeId = await toApproved(app);
    await post(app, `/api/projects/intake/${intakeId}/blueprint`);

    const created = await post(app, '/api/projects', { intakeId, model: 'gemini-3.6-flash', blueprint: { title: 'forged' } });
    expect(created.statusCode, created.body).toBe(201);

    const [project] = mocks.tables['projects']!;
    expect(project).toMatchObject({
      user_id: 'user-1',
      title: 'Notes',
      generation_model: 'claude-opus-5-5',
      project_profile: 'desktop-app',
      stack_brief: BRIEF,
      intake_id: intakeId,
    });
    // Invariant 17: the stack is the brief's.
    expect(project!['tech_stack']).toEqual(core.techStackFromBrief(BRIEF));
    const steps = mocks.tables['project_steps']!;
    expect(steps.map((s) => s['doc_refs'])).toEqual([['d1'], ['d1'], ['d1']]);
    expect(steps.every((s) => s['verification'] === 'cli')).toBe(true);
  });

  it('refuses the old { blueprint } body with the flag on, and an unapproved intake', async () => {
    const app = await server();
    expect((await post(app, '/api/projects', { blueprint: planned() })).statusCode).toBe(400);
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    expect((await post(app, '/api/projects', { intakeId })).statusCode).toBe(409);
  });
});

describe('the template path: a very similar stored project is adapted', () => {
  /** Learner 1 builds a project and writes its step 1. */
  async function seedTemplate(app: App) {
    const intakeId = await toApproved(app);
    await post(app, `/api/projects/intake/${intakeId}/blueprint`);
    const { id } = (await post(app, '/api/projects', { intakeId })).json();
    const step = mocks.tables['project_steps']!.find((s) => s['project_id'] === id && s['step_index'] === 0)!;
    Object.assign(step, {
      instructions_md: '### What you are building',
      explanation_md: 'why',
      alternatives: [],
      starter_files: [{ path: 'src-tauri/src/core/notes.rs', contents: '// start' }],
      solution_files: [{ path: 'src-tauri/src/core/notes.rs', contents: '// done' }],
      checkpoint: { requiredFiles: [], requiredSymbols: [], tests: [], runtime: 'none', hints: [] },
      expanded_at: new Date().toISOString(),
    });
    vi.clearAllMocks();
    return id as string;
  }

  it('copies dossier and brief with no call, adapts the plan on Sonnet, and reuses step 1', async () => {
    const app = await server();
    const templateId = await seedTemplate(app);

    mocks.user.id = 'user-2';
    const scoped = (await post(app, '/api/projects/intake', { compiled: compiled('I want to build a notes app in Tauri') })).json();
    expect(scoped.adapted).toBe(true);
    const intake = mocks.tables['project_intakes']!.find((r) => r['id'] === scoped.intakeId)!;
    expect(intake['template_project_id']).toBe(templateId);

    const research = (await post(app, `/api/projects/intake/${scoped.intakeId}/research`)).json();
    expect(research.fromTemplate).toBe(true);
    expect(mocks.runProjectResearch).not.toHaveBeenCalled();

    const brief = (await post(app, `/api/projects/intake/${scoped.intakeId}/stack-brief`)).json();
    expect(brief.reused).toBe(true);
    expect(mocks.generateBrief).not.toHaveBeenCalled();

    await post(app, `/api/projects/intake/${scoped.intakeId}/stack-brief/approve`);
    const plan = (await post(app, `/api/projects/intake/${scoped.intakeId}/blueprint`)).json();
    expect(plan.adapted).toBe(true);
    expect(mocks.createProviderForStage.mock.calls.at(-1)![0]).toBe('adapt');
    expect(mocks.generatePlannedBlueprint.mock.calls[0]![0].template).toMatchObject({ title: 'Notes' });
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: 'project:adapt' }));

    const created = (await post(app, '/api/projects', { intakeId: scoped.intakeId })).json();
    expect(created.reusedFirstStep).toBe(true);
    const mine = mocks.tables['project_steps']!.filter((s) => s['project_id'] === created.id);
    expect(mine.find((s) => s['step_index'] === 0)).toMatchObject({ user_id: 'user-2', instructions_md: '### What you are building' });
    // Only step 1: later steps are written for this learner's own code.
    expect(mine.find((s) => s['step_index'] === 1)!['instructions_md']).toBeUndefined();
  });

  it('plans from nothing for a different project on the same stack', async () => {
    const app = await server();
    await seedTemplate(app);
    mocks.user.id = 'user-2';
    const scoped = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri music player with playlists') })).json();
    expect(scoped.adapted).toBe(false);
  });

  it('drops the template when the learner regenerates the brief', async () => {
    const app = await server();
    await seedTemplate(app);
    mocks.user.id = 'user-2';
    const { intakeId } = (await post(app, '/api/projects/intake', { compiled: compiled('A Tauri notes app') })).json();
    await post(app, `/api/projects/intake/${intakeId}/research`);
    await post(app, `/api/projects/intake/${intakeId}/stack-brief`);
    const again = (await post(app, `/api/projects/intake/${intakeId}/stack-brief`)).json();
    expect(again.reused).toBe(false);
    expect(mocks.generateBrief).toHaveBeenCalledTimes(1);
    expect(mocks.tables['project_intakes']!.find((r) => r['id'] === intakeId)!['template_project_id']).toBeNull();
  });

  it('does not reuse step 1 when the adaptation changed it', async () => {
    const app = await server();
    await seedTemplate(app);
    mocks.generatePlannedBlueprint.mockImplementation(async () => {
      const changed = planned();
      changed.steps[0] = { ...changed.steps[0]!, objective: 'Something else works.' };
      return { data: { blueprint: changed, violations: [], attempts: 1 }, usage: KNOWN };
    });
    mocks.user.id = 'user-2';
    const intakeId = await toApproved(app, 'A Tauri notes app');
    await post(app, `/api/projects/intake/${intakeId}/blueprint`);
    expect((await post(app, '/api/projects', { intakeId })).json().reusedFirstStep).toBe(false);
  });
});

describe('GET /api/projects/:id/stack', () => {
  it("returns the learner's own project's brief and its cited sources", async () => {
    const app = await server();
    const intakeId = await toApproved(app);
    await post(app, `/api/projects/intake/${intakeId}/blueprint`);
    const { id } = (await post(app, '/api/projects', { intakeId })).json();

    const stack = await app.inject({ method: 'GET', url: `/api/projects/${id}/stack` });
    expect(stack.json().brief.profile).toBe('desktop-app');
    expect(stack.json().sources.map((s: { id: string }) => s.id)).toEqual(['d1', 'd2']);

    mocks.user.id = 'user-2';
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/stack` })).statusCode).toBe(404);
  });
});
