import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Invariant 16: every generation call records its real usage
 * (docs/project-studio.md §11, §13).
 *
 * The three project routes used to record zero tokens, so the budget never saw
 * project spend. A fake provider reports known usage; each route must record
 * exactly that, under its `project:<stage>` label. With PROJECT_STUDIO on the
 * stage's model comes from PROJECT_MODELS and spend counts against the weekly
 * project allowance.
 */

const KNOWN = { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 10 };

const mocks = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  checkBudget: vi.fn(),
  createProviderForTask: vi.fn(),
  createProviderForStage: vi.fn(),
  generateBlueprint: vi.fn(),
  expandStep: vi.fn(),
  finishProject: vi.fn(),
  loadProgress: vi.fn(),
  tables: {} as Record<string, unknown>,
}));

const fakeProvider = { id: 'anthropic', modelId: 'claude-sonnet-5-5' };

vi.mock('@ai-edu/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/llm')>()),
  createProviderForTask: mocks.createProviderForTask,
  createProviderForStage: mocks.createProviderForStage,
}));

vi.mock('@ai-edu/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-edu/core')>()),
  generateBlueprint: mocks.generateBlueprint,
  expandStep: mocks.expandStep,
  finishProject: mocks.finishProject,
}));

/** Every query on a table resolves to the rows queued for it. */
function builder(table: string) {
  const result = () => ({ data: mocks.tables[table] ?? null, error: null });
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'in', 'order', 'gte', 'like', 'not', 'insert', 'update', 'delete', 'upsert', 'limit']) {
    chain[name] = () => chain;
  }
  chain['maybeSingle'] = async () => {
    const value = mocks.tables[table];
    return { data: Array.isArray(value) ? (value[0] ?? null) : (value ?? null), error: null };
  };
  chain['single'] = chain['maybeSingle'];
  chain['then'] = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock('../src/db.js', () => ({
  db: () => ({ from: (table: string) => builder(table) }),
  checkBudget: mocks.checkBudget,
  recordUsage: mocks.recordUsage,
}));

vi.mock('../src/auth.js', () => ({
  requireAuth: async (request: { user?: unknown }) => {
    request.user = { id: 'user-1', email: null };
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

vi.mock('../src/progress.js', () => ({
  loadProgress: mocks.loadProgress,
  canExpand: () => true,
}));

vi.mock('../src/projectFiles.js', () => ({
  priorFilesFor: async () => [],
  assembleFinished: async () => ({
    files: [{ path: 'app.js', contents: 'console.log(1)' }],
    stepsFromReference: [],
    fullyLearnerWritten: true,
  }),
}));

const { resetEnvCache } = await import('../src/env.js');
const { projectRoutes } = await import('../src/routes/projects.js');
const { ProjectGenerationUnavailableError } = await import('@ai-edu/llm');

const BLUEPRINT = {
  title: 'Todo',
  summary: 'A todo list.',
  learningObjectives: ['state'],
  techStack: [{ name: 'JavaScript', role: 'logic', why: 'runs anywhere' }],
  prerequisites: [],
  estimatedHours: 1.5,
  finalFileTree: [{ path: 'app.js', purpose: 'the app' }],
  deployment: { target: 'local', rationale: 'a script', artifacts: [], taught: false },
  steps: [
    { title: 'One', objective: 'a', concepts: [], estMinutes: 30, creates: ['app.js'], edits: [] },
    { title: 'Two', objective: 'b', concepts: [], estMinutes: 30, creates: [], edits: ['app.js'] },
    { title: 'Three', objective: 'c', concepts: [], estMinutes: 30, creates: [], edits: ['app.js'] },
  ],
};

const EXPANSION = {
  instructionsMd: 'Do it.',
  explanationMd: 'Why.',
  alternatives: [],
  hints: [],
  checkpoint: { requiredFiles: [], requiredSymbols: [], tests: [], runtime: 'none' },
  starterFiles: [],
  solutionFiles: [],
};

const COMPILED = {
  intent: 'project_generation',
  originalQuery: 'a todo app',
  text: '<learner_question>a todo app</learner_question>',
  slots: {},
  attachments: [],
  partial: false,
};

async function server() {
  const app = Fastify();
  await app.register(projectRoutes);
  return app;
}

function setFlag(value: 'on' | 'off') {
  process.env['PROJECT_STUDIO'] = value;
  resetEnvCache();
}

beforeEach(() => {
  process.env['SUPABASE_URL'] = 'http://127.0.0.1:54321';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role';
  vi.clearAllMocks();
  mocks.checkBudget.mockResolvedValue({ exceeded: false, spentUSD: 0, limitUSD: 5, hasUnpricedUsage: false });
  mocks.createProviderForTask.mockReturnValue(fakeProvider);
  mocks.createProviderForStage.mockReturnValue({ provider: fakeProvider, reasoning: 'low', maxTokens: 8000 });
  mocks.generateBlueprint.mockResolvedValue({ data: BLUEPRINT, usage: KNOWN });
  mocks.expandStep.mockResolvedValue({ data: EXPANSION, usage: KNOWN });
  mocks.finishProject.mockResolvedValue({ data: { readmeMd: '# Todo', deployFiles: [] }, usage: KNOWN });
  mocks.loadProgress.mockResolvedValue({ steps: [], unlockedThrough: 0, locks: [], furthestReached: 0 });
  mocks.tables = {
    projects: { id: 'p1', title: 'Todo', blueprint: BLUEPRINT, artifact: null },
    project_steps: { id: 's1', step_index: 0, title: 'One', objective: 'a', expanded_at: null },
    step_progress: null,
    step_attempts: [],
    enrollments: null,
  };
});

afterEach(() => {
  delete process.env['PROJECT_STUDIO'];
  resetEnvCache();
});

const calls = {
  blueprint: (app: Awaited<ReturnType<typeof server>>) =>
    app.inject({ method: 'POST', url: '/api/projects/blueprint', payload: { compiled: COMPILED, model: 'gemini-3.6-flash' } }),
  step: (app: Awaited<ReturnType<typeof server>>, index = 0) =>
    app.inject({ method: 'POST', url: `/api/projects/p1/steps/${index}/expand`, payload: {} }),
  finish: (app: Awaited<ReturnType<typeof server>>) =>
    app.inject({ method: 'POST', url: '/api/projects/p1/finish', payload: {} }),
};

describe.each(['off', 'on'] as const)('invariant 16 with PROJECT_STUDIO=%s', (flag) => {
  beforeEach(() => setFlag(flag));

  it.each([
    ['blueprint', 'project:blueprint'],
    ['step', 'project:step'],
    ['finish', 'project:finish'],
  ] as const)('the %s route records the usage the call reported', async (route, task) => {
    const app = await server();
    const response = await calls[route](app);
    expect(response.statusCode, response.body).toBeLessThan(300);

    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    const recorded = mocks.recordUsage.mock.calls[0]![0];
    expect(recorded).toMatchObject({ task, usage: KNOWN, model: 'claude-sonnet-5-5' });
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = recorded.usage;
    expect(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens).toBeGreaterThan(0);
  });
});

describe('PROJECT_STUDIO=on', () => {
  beforeEach(() => setFlag('on'));

  it('takes each stage from PROJECT_MODELS and ignores the UI pick', async () => {
    const app = await server();
    await calls.blueprint(app);
    await calls.step(app);
    await calls.finish(app);

    expect(mocks.createProviderForTask).not.toHaveBeenCalled();
    expect(mocks.createProviderForStage.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['blueprint', 'T3'],
      ['step', 'T3'],
      ['finish', 'T3'],
    ]);
    expect(mocks.generateBlueprint.mock.calls[0]![0]).toMatchObject({ reasoning: 'low', maxTokens: 8000 });
    expect(mocks.expandStep.mock.calls[0]![0]).toMatchObject({ reasoning: 'low', maxTokens: 8000 });
    expect(mocks.finishProject.mock.calls[0]![0]).toMatchObject({ reasoning: 'low', maxTokens: 8000 });
  });

  it('checks the weekly project allowance, not the daily one', async () => {
    const app = await server();
    await calls.blueprint(app);
    expect(mocks.checkBudget).toHaveBeenCalledWith('user-1', 'project');
  });

  it('answers 429 project_budget_exceeded over the project allowance', async () => {
    mocks.checkBudget.mockResolvedValue({ exceeded: true, spentUSD: 5.2, limitUSD: 5, hasUnpricedUsage: false });
    const app = await server();
    for (const route of ['blueprint', 'step', 'finish'] as const) {
      const response = await calls[route](app);
      expect(response.statusCode).toBe(429);
      expect(response.json().error).toBe('project_budget_exceeded');
    }
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('answers 503 project_generation_unavailable without a Claude key', async () => {
    mocks.createProviderForStage.mockImplementation(() => {
      throw new ProjectGenerationUnavailableError('projectPlan');
    });
    const app = await server();
    for (const route of ['blueprint', 'step', 'finish'] as const) {
      const response = await calls[route](app);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('project_generation_unavailable');
    }
  });

  it('holds the prefetch of step N+1 until step N has a draft or an attempt', async () => {
    const app = await server();
    mocks.tables['project_steps'] = { id: 's2', step_index: 1, title: 'Two', objective: 'b', expanded_at: null };

    const early = await calls.step(app, 1);
    expect(early.statusCode).toBe(403);
    expect(early.json().error).toBe('step_locked');
    expect(mocks.expandStep).not.toHaveBeenCalled();

    mocks.tables['step_progress'] = { files: [{ path: 'app.js', contents: 'draft' }] };
    const started = await calls.step(app, 1);
    expect(started.statusCode, started.body).toBe(200);
    expect(mocks.expandStep).toHaveBeenCalledTimes(1);
  });
});

describe('PROJECT_STUDIO=off', () => {
  beforeEach(() => setFlag('off'));

  it('resolves projects as before: the projectGen chain, user pick included', async () => {
    const app = await server();
    await calls.blueprint(app);
    expect(mocks.createProviderForStage).not.toHaveBeenCalled();
    expect(mocks.createProviderForTask).toHaveBeenCalledWith('projectGen', 'gemini-3.6-flash');
    expect(mocks.generateBlueprint.mock.calls[0]![0]).not.toHaveProperty('reasoning');
  });

  it('checks the daily allowance and answers budget_exceeded, as before', async () => {
    mocks.checkBudget.mockResolvedValue({ exceeded: true, spentUSD: 2.1, limitUSD: 2, hasUnpricedUsage: false });
    const app = await server();
    const response = await calls.blueprint(app);
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('budget_exceeded');
    expect(mocks.checkBudget).toHaveBeenCalledWith('user-1', 'qa');
  });

  it('prefetches the next step without waiting for a draft, as before', async () => {
    const app = await server();
    mocks.tables['project_steps'] = { id: 's2', step_index: 1, title: 'Two', objective: 'b', expanded_at: null };
    const response = await calls.step(app, 1);
    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('invariant 16: no route records a literal zero usage', () => {
  it('has no `inputTokens: 0` literal anywhere in apps/api/src/routes', () => {
    const dir = join(fileURLToPath(new URL('.', import.meta.url)), '../src/routes');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, `${file} records a hard-coded zero usage`).not.toMatch(/inputTokens:\s*0\b/);
    }
  });
});
