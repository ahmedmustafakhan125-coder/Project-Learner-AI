import { describe, expect, it, vi } from 'vitest';

import { createProviderForStage, createProviderForTask } from '../src/factory.js';
import {
  PROJECT_MODELS,
  PROJECT_TIERS,
  TASK_POLICY,
  getModel,
  listAvailableModels,
  resolveModel,
  resolveProjectStage,
} from '../src/registry.js';
import type { ProjectStage, TaskKind } from '../src/registry.js';
import { ProjectGenerationUnavailableError } from '../src/types.js';

/**
 * Invariant 15: project generation runs on Claude and never falls back
 * silently (docs/project-learner.md §13).
 */

const PROJECT_TASKS: TaskKind[] = [
  'projectPlan',
  'projectStep',
  'projectReview',
  'projectResearch',
  'projectGen',
];

const BOTH = { ANTHROPIC_API_KEY: 'sk-ant', GEMINI_API_KEY: 'g-key' };
const GEMINI_ONLY = { GEMINI_API_KEY: 'g-key' };
const on = (env: Record<string, string>, extra: Record<string, string> = {}) =>
  ({ ...env, PROJECT_LEARNER: 'on', ...extra }) as NodeJS.ProcessEnv;
const off = (env: Record<string, string>) => ({ ...env }) as NodeJS.ProcessEnv;

describe('invariant 15: project tasks with the flag on', () => {
  it.each(PROJECT_TASKS)('%s resolves to Claude when both keys are set', (task) => {
    expect(resolveModel(task, undefined, on(BOTH))?.vendor).toBe('anthropic');
  });

  it.each(PROJECT_TASKS)('%s ignores a user pick outside the allowed vendors', (task) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveModel(task, 'gemini-3.6-flash', on(BOTH))?.vendor).toBe('anthropic');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(PROJECT_TASKS)('%s throws in production when only a Gemini key is set', (task) => {
    const env = on(GEMINI_ONLY, { NODE_ENV: 'production' });
    expect(() => resolveModel(task, undefined, env)).toThrow(ProjectGenerationUnavailableError);
  });

  it('refuses the chain fallback in production even when it is set', () => {
    const env = on(GEMINI_ONLY, { NODE_ENV: 'production', PROJECT_GEN_FALLBACK: 'chain' });
    expect(() => resolveModel('projectPlan', undefined, env)).toThrow(
      ProjectGenerationUnavailableError,
    );
  });

  it('throws in development too unless PROJECT_GEN_FALLBACK=chain', () => {
    expect(() => resolveModel('projectStep', undefined, on(GEMINI_ONLY))).toThrow(
      /project_generation_unavailable|Claude/,
    );
  });

  it('falls back to Gemini in development only with PROJECT_GEN_FALLBACK=chain', () => {
    const env = on(GEMINI_ONLY, { PROJECT_GEN_FALLBACK: 'chain' });
    expect(resolveModel('projectStep', undefined, env)?.vendor).toBe('gemini');
  });

  it('pins every project task to Anthropic with no user choice and no silent fallback', () => {
    for (const task of PROJECT_TASKS) {
      expect(TASK_POLICY[task]).toEqual({
        allowUserChoice: false,
        vendors: ['anthropic'],
        onMissing: 'fail',
      });
    }
  });
});

describe('the tutor and the questions', () => {
  it('runs the tutor on Gemini 4 Argon with the flag on, whatever the user picked', () => {
    expect(resolveModel('tutor', 'claude-opus-5-5', on(BOTH))?.id).toBe('gemini-4-argon');
  });

  it('keeps questions on Gemini Flash even when a Claude key is set', () => {
    for (const task of ['interview', 'fanout'] as const) {
      expect(resolveModel(task, undefined, on(BOTH))?.providerModel).toBe('gemini-3.6-flash');
      expect(resolveModel(task, undefined, off(BOTH))?.providerModel).toBe('gemini-3.6-flash');
    }
  });

  it('still honours the user pick for conversational tasks', () => {
    expect(resolveModel('fanout', 'claude-sonnet-5-5', on(BOTH))?.id).toBe('claude-sonnet-5-5');
  });
});

describe('with the flag off nothing changes', () => {
  it('resolves project generation exactly as before: Gemini first, user pick honoured', () => {
    expect(resolveModel('projectPlan', undefined, off(BOTH))?.vendor).toBe('gemini');
    expect(resolveModel('projectGen', undefined, off(BOTH))?.vendor).toBe('gemini');
    expect(resolveModel('projectPlan', 'claude-opus-5-5', off(BOTH))?.id).toBe('claude-opus-5-5');
  });

  it('never throws for a project task when only Gemini is configured', () => {
    expect(resolveModel('projectStep', undefined, off(GEMINI_ONLY))?.vendor).toBe('gemini');
  });

  it('runs the tutor on the fan-out chain, as today', () => {
    expect(resolveModel('tutor', undefined, off(BOTH))?.id).toBe(
      resolveModel('fanout', undefined, off(BOTH))?.id,
    );
  });
});

describe('PROJECT_MODELS', () => {
  const stages = Object.keys(PROJECT_MODELS) as ProjectStage[];

  it('names only Claude models with verified pricing', () => {
    for (const stage of stages) {
      for (const tier of PROJECT_TIERS) {
        const settings = PROJECT_MODELS[stage][tier];
        if (!settings) continue;
        const model = getModel(settings.model);
        expect(model?.vendor, `${stage} ${tier}`).toBe('anthropic');
        expect(model?.pricing, `${stage} ${tier} must be priced`).not.toBeNull();
        expect(TASK_POLICY[settings.task].vendors).toContain('anthropic');
      }
    }
  });

  it('spends Opus on the T3+ blueprint only (§11)', () => {
    for (const stage of stages) {
      for (const tier of PROJECT_TIERS) {
        const settings = PROJECT_MODELS[stage][tier];
        if (!settings) continue;
        const wantOpus = stage === 'blueprint' && !['T1', 'T2'].includes(tier);
        expect(settings.model, `${stage} ${tier}`).toBe(
          wantOpus ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
        );
      }
    }
  });

  it('holds the §11 effort and output ceilings', () => {
    expect(PROJECT_MODELS.blueprint.T1).toMatchObject({ reasoning: 'medium', maxTokens: 8_000 });
    expect(PROJECT_MODELS.blueprint.T3).toMatchObject({ reasoning: 'medium', maxTokens: 12_000 });
    expect(PROJECT_MODELS.blueprint.T5).toMatchObject({ reasoning: 'high', maxTokens: 12_000 });
    expect(PROJECT_MODELS.step.T2).toMatchObject({ reasoning: 'low', maxTokens: 8_000 });
    expect(PROJECT_MODELS.step.T3).toMatchObject({ reasoning: 'medium', maxTokens: 16_000 });
    expect(PROJECT_MODELS.brief.T1).toMatchObject({ reasoning: 'low', maxTokens: 4_000 });
    expect(PROJECT_MODELS.brief.T4).toMatchObject({ reasoning: 'medium', maxTokens: 8_000 });
    expect(PROJECT_MODELS.finish.T3).toMatchObject({ reasoning: 'low', maxTokens: 6_000 });
    expect(PROJECT_MODELS.adapt.T1).toMatchObject({ reasoning: 'low', maxTokens: 8_000 });
    expect(PROJECT_MODELS.adapt.T5).toMatchObject({ reasoning: 'medium', maxTokens: 12_000 });
    expect(PROJECT_MODELS.research.T1).toBeNull();
    expect(PROJECT_MODELS.research.T2).toMatchObject({ reasoning: 'low' });
  });

  it('never uses xhigh or max', () => {
    for (const stage of stages) {
      for (const tier of PROJECT_TIERS) {
        expect(['xhigh', 'max']).not.toContain(PROJECT_MODELS[stage][tier]?.reasoning);
      }
    }
  });

  it('resolves a stage to its table entry when Claude is configured', () => {
    const resolved = resolveProjectStage('blueprint', 'T3', on(BOTH));
    expect(resolved).toMatchObject({ reasoning: 'medium', maxTokens: 12_000 });
    expect(resolved.model.id).toBe('claude-opus-5-5');
  });

  it('refuses a stage that does not run at a tier', () => {
    expect(() => resolveProjectStage('research', 'T1', on(BOTH))).toThrow(/research/);
  });

  it('builds the provider and settings together', () => {
    const { provider, reasoning, maxTokens } = createProviderForStage('step', 'T1', {
      env: on(BOTH),
    });
    expect(provider.modelId).toBe('claude-sonnet-5-5');
    expect(reasoning).toBe('low');
    expect(maxTokens).toBe(8_000);
  });

  it('surfaces the unavailable error from the factory', () => {
    expect(() =>
      createProviderForTask('projectPlan', undefined, {
        env: on(GEMINI_ONLY, { NODE_ENV: 'production' }),
      }),
    ).toThrow(ProjectGenerationUnavailableError);
  });
});

describe('Gemini aliases', () => {
  it('labels every Gemini entry with the model it actually calls', () => {
    for (const id of ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
      const model = getModel(id)!;
      expect(model.providerModel).toBe('gemini-3.6-flash');
      expect(model.label).toMatch(/3\.6 Flash/);
    }
  });

  it('keeps aliases resolvable but out of the picker', () => {
    const picked = listAvailableModels(off(GEMINI_ONLY)).map((m) => m.id);
    expect(picked).toContain('gemini-3.6-flash');
    expect(picked).not.toContain('gemini-3.7-flash');
    expect(resolveModel('fanout', 'gemini-2.5-pro', off(GEMINI_ONLY))?.id).toBe('gemini-2.5-pro');
  });
});
