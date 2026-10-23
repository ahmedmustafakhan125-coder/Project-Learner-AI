import { PROJECT_MODELS, PROJECT_TIERS, computeCost } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import {
  CREATION_STAGES,
  INPUT_ESTIMATES,
  UnpricedStageError,
  projectCostCeiling,
  stageCostCeiling,
} from '../src/budget/ceiling.js';

/**
 * Invariant 28: project creation has a tested cost ceiling
 * (docs/project-learner.md §11, §13).
 *
 * Worst case: every call writes its full maxTokens, every retry runs, every
 * search is used, and no input is read from cache. A prompt, limit or retry
 * change that pushes creation past the target fails here.
 */

describe('invariant 28: the cost of creating a project', () => {
  it('stays under $0.60 for T1', () => {
    expect(projectCostCeiling('T1').totalUSD).toBeLessThan(0.6);
  });

  it('stays under $1.50 for T3', () => {
    expect(projectCostCeiling('T3').totalUSD).toBeLessThan(1.5);
  });

  it('is cheaper on the template path than planning from nothing, at every tier', () => {
    for (const tier of PROJECT_TIERS) {
      expect(projectCostCeiling(tier, 'template').totalUSD).toBeLessThan(projectCostCeiling(tier, 'full').totalUSD);
    }
  });

  it('counts every stage creation runs, and research only from T2', () => {
    expect(projectCostCeiling('T1').stages.map((s) => s.stage)).toEqual(['scope', 'brief', 'blueprint', 'step']);
    expect(projectCostCeiling('T3').stages.map((s) => s.stage)).toEqual(CREATION_STAGES.full);
    expect(projectCostCeiling('T3', 'template').stages.map((s) => s.stage)).toEqual(['scope', 'adapt', 'step']);
  });

  it('reads model, effort ceiling and maxTokens from PROJECT_MODELS', () => {
    const blueprint = stageCostCeiling('blueprint', 'T3')!;
    expect(blueprint.model).toBe(PROJECT_MODELS.blueprint.T3!.model);
    expect(blueprint.outputTokensPerCall).toBe(PROJECT_MODELS.blueprint.T3!.maxTokens);
    expect(blueprint.calls).toBe(2);
    expect(stageCostCeiling('research', 'T1')).toBeNull();
  });

  it('agrees with computeCost for the same tokens', () => {
    const step = stageCostCeiling('step', 'T3')!;
    const one = computeCost(step.model, {
      inputTokens: INPUT_ESTIMATES.step.large,
      outputTokens: step.outputTokensPerCall,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }).totalUSD!;
    expect(step.usd).toBeCloseTo(one * step.calls, 10);
  });

  it('prices research searches on top of tokens', () => {
    const research = stageCostCeiling('research', 'T3')!;
    expect(research.searches).toBe(3);
  });

  it('fails on an unverified price rather than counting it as free (invariant 3)', () => {
    expect(() => projectCostCeiling('T3', 'full', { scopeModel: 'no-such-model' })).toThrow(UnpricedStageError);
  });
});
