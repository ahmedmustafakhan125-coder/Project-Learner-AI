import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMRequest, LLMUsage } from '@ai-edu/llm';

import { generateBlueprint } from '../src/generation/blueprint.js';
import { expandStep } from '../src/generation/expand.js';
import { finishProject } from '../src/generation/finish.js';
import { planExpansion } from '../src/generation/prefetch.js';
import type { CompiledQuery } from '../src/schemas/interview.js';
import type { ProjectBlueprint } from '../src/schemas/project.js';
import type { ExpandedStep } from '../src/schemas/step.js';

/**
 * Honest usage (docs/project-studio.md §11, invariant 16) and the cheap
 * settings that ride with it.
 *
 * The three generation functions used to return only their data, so the routes
 * recorded zero tokens and the budget never saw project spend.
 */

const usage = (inputTokens: number, outputTokens: number, extra: Partial<LLMUsage> = {}): LLMUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...extra,
});

/** Answers each call in turn, with known usage, and records the request. */
function scripted(answers: unknown[], usages: LLMUsage[]) {
  const requests: LLMRequest[] = [];
  let call = 0;
  const provider = {
    id: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    async structured(request: LLMRequest) {
      requests.push(request);
      const i = Math.min(call, answers.length - 1);
      call += 1;
      return { data: answers[i], usage: usages[i]!, model: 'm', strategy: 'native-schema', repaired: false };
    },
  } as unknown as LLMProvider;
  return { provider, requests };
}

const compiled: CompiledQuery = {
  intent: 'project_generation',
  originalQuery: 'a todo app',
  text: '<learner_question>a todo app</learner_question>',
  slots: {},
  attachments: [],
  partial: false,
};

const BLUEPRINT: ProjectBlueprint = {
  title: 'Todo',
  summary: 'A todo list.',
  techStack: [{ name: 'JavaScript', role: 'logic', why: 'runs in the browser' }],
  learningObjectives: ['state'],
  prerequisites: [],
  estimatedHours: 1,
  finalFileTree: [{ path: 'app.js', purpose: 'the app' }],
  deployment: { target: 'local', rationale: 'a page', artifacts: [], taught: false },
  steps: [
    { title: 'List', objective: 'Show todos', concepts: [], estMinutes: 30, creates: ['app.js'], edits: [] },
    { title: 'Add', objective: 'Add todos', concepts: [], estMinutes: 30, creates: [], edits: ['app.js'] },
  ],
};

const GOOD_STEP: ExpandedStep = {
  instructionsMd:
    'Create `app.js` and write a function `render(todos)` that returns one `<li>` per todo.\n\n' +
    '### Done when\n\nCalling `render(["a"])` returns `<li>a</li>`.',
  explanationMd: 'Rendering from state keeps the page and the data in step.',
  alternatives: [],
  hints: [],
  checkpoint: { requiredFiles: ['app.js'], requiredSymbols: ['render'], tests: [], runtime: 'none' },
  starterFiles: [{ path: 'app.js', contents: 'function render(todos) {\n  // TODO\n}\n' }],
  solutionFiles: [
    { path: 'app.js', contents: 'function render(todos) { return todos.map((t) => `<li>${t}</li>`).join(""); }\n' },
  ],
};

describe('generateBlueprint', () => {
  it('returns the usage of the call it made', async () => {
    const { provider } = scripted([BLUEPRINT], [usage(1200, 800, { cacheReadTokens: 300 })]);
    const result = await generateBlueprint({ provider, compiled });
    expect(result.data.title).toBe('Todo');
    expect(result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 300 });
  });

  it('keeps xhigh and 12,000 tokens when no settings are passed (flag off)', async () => {
    const { provider, requests } = scripted([BLUEPRINT], [usage(1, 1)]);
    await generateBlueprint({ provider, compiled });
    expect(requests[0]).toMatchObject({ reasoning: 'xhigh', maxTokens: 12_000 });
  });

  it('uses the effort and ceiling it is given', async () => {
    const { provider, requests } = scripted([BLUEPRINT], [usage(1, 1)]);
    await generateBlueprint({ provider, compiled, reasoning: 'medium', maxTokens: 8_000 });
    expect(requests[0]).toMatchObject({ reasoning: 'medium', maxTokens: 8_000 });
  });
});

describe('expandStep', () => {
  it('returns the usage of every call it made', async () => {
    const { provider, requests } = scripted([GOOD_STEP], [usage(900, 400)]);
    const result = await expandStep({ provider, blueprint: BLUEPRINT, stepIndex: 0 });
    expect(result.data.solutionFiles.map((f) => f.path)).toEqual(['app.js']);
    expect(requests.length).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({
      inputTokens: 900 * requests.length,
      outputTokens: 400 * requests.length,
    });
  });

  it('sums usage across the retry', async () => {
    // No solution file: a hole in the project, which earns one retry.
    const broken: ExpandedStep = { ...GOOD_STEP, solutionFiles: [] };
    const { provider, requests } = scripted([broken, GOOD_STEP], [usage(900, 400), usage(1000, 500)]);
    const result = await expandStep({ provider, blueprint: BLUEPRINT, stepIndex: 0 });
    expect(requests).toHaveLength(2);
    expect(result.usage).toMatchObject({ inputTokens: 1900, outputTokens: 900 });
  });

  it('keeps high and 16,000 tokens by default, and takes settings when given', async () => {
    const a = scripted([GOOD_STEP], [usage(1, 1)]);
    await expandStep({ provider: a.provider, blueprint: BLUEPRINT, stepIndex: 0 });
    expect(a.requests[0]).toMatchObject({ reasoning: 'high', maxTokens: 16_000 });

    const b = scripted([GOOD_STEP], [usage(1, 1)]);
    await expandStep({
      provider: b.provider,
      blueprint: BLUEPRINT,
      stepIndex: 0,
      reasoning: 'low',
      maxTokens: 8_000,
    });
    expect(b.requests[0]).toMatchObject({ reasoning: 'low', maxTokens: 8_000 });
  });

  it('caches the per-project prefix for five minutes and the system prompt for an hour', async () => {
    const { provider, requests } = scripted([GOOD_STEP], [usage(1, 1)]);
    await expandStep({ provider, blueprint: BLUEPRINT, stepIndex: 0 });
    const request = requests[0]!;
    const prefix = (request.messages[0]!.content as Array<{ cacheBoundary?: boolean; cacheTtl?: string }>)[0]!;
    expect(prefix).toMatchObject({ cacheBoundary: true, cacheTtl: '5m' });
    expect(request.system?.[0]?.cacheTtl ?? '1h').toBe('1h');
  });
});

describe('finishProject', () => {
  it('returns its usage and keeps high and 12,000 tokens by default', async () => {
    const { provider, requests } = scripted(
      [{ readmeMd: '# Todo', deployFiles: [] }],
      [usage(2500, 300)],
    );
    const result = await finishProject({
      provider,
      blueprint: BLUEPRINT,
      files: [{ path: 'app.js', contents: 'x' }],
    });
    expect(result.data.readmeMd).toBe('# Todo');
    expect(result.usage).toMatchObject({ inputTokens: 2500, outputTokens: 300 });
    expect(requests[0]).toMatchObject({ reasoning: 'high', maxTokens: 12_000 });
  });

  it('uses the effort and ceiling it is given', async () => {
    const { provider, requests } = scripted([{ readmeMd: '# T', deployFiles: [] }], [usage(1, 1)]);
    await finishProject({
      provider,
      blueprint: BLUEPRINT,
      files: [{ path: 'app.js', contents: 'x' }],
      reasoning: 'low',
      maxTokens: 6_000,
    });
    expect(requests[0]).toMatchObject({ reasoning: 'low', maxTokens: 6_000 });
  });
});

describe('planExpansion: prefetch only after the learner starts', () => {
  const steps = [
    { index: 0, expanded: true, expanding: false },
    { index: 1, expanded: false, expanding: false },
  ];

  it('prefetches the next step eagerly when nothing is said (flag off)', () => {
    expect(planExpansion(steps, 0).background).toEqual([1]);
  });

  it('holds the prefetch until the current step has a draft or an attempt', () => {
    expect(planExpansion(steps, 0, { currentStarted: false }).background).toEqual([]);
    expect(planExpansion(steps, 0, { currentStarted: true }).background).toEqual([1]);
  });

  it('never holds back the step the learner is on', () => {
    const fresh = [{ index: 0, expanded: false, expanding: false }, ...steps.slice(1)];
    expect(planExpansion(fresh, 0, { currentStarted: false }).blocking).toBe(0);
  });
});
