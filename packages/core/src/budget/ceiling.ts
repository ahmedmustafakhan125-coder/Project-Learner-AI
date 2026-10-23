import { PROJECT_MODELS, TASK_DEFAULTS, WEB_SEARCH_USD_PER_SEARCH, getModel } from '@ai-edu/llm';
import type { ProjectStage, ProjectStageSettings, ProjectTier } from '@ai-edu/llm';

import { BLUEPRINT_MAX_ATTEMPTS } from '../generation/blueprint.js';
import { EXPAND_MAX_ATTEMPTS } from '../generation/expand.js';
import { CLASSIFY_MAX_TOKENS } from '../interview/classify.js';
import { PROJECT_RESEARCH_BUDGET } from '../research/sources.js';
import { BRIEF_MAX_ATTEMPTS } from '../stack/brief.js';

/**
 * The tested cost ceiling of creating a project (docs/project-learner.md §11,
 * invariant 28).
 *
 * Creating a project is everything before the learner can start step 1: the
 * scope call, research, the Stack Brief, the blueprint and step 1. Each stage
 * is priced at its worst: every call writes its full `maxTokens` from
 * `PROJECT_MODELS`, every retry runs, every search is used, and every input
 * token is billed at the base input rate with no cache discount. A test holds
 * the result under $0.60 for T1 and $1.50 for T3, so a prompt, limit or retry
 * change that breaks the target fails `npm test`.
 *
 * A model with unverified pricing throws rather than counting as free
 * (invariant 3).
 */

export type CeilingStage = 'scope' | 'research' | 'brief' | 'blueprint' | 'adapt' | 'step';

/** `full` plans from nothing; `template` adapts a very similar stored project. */
export type CreationPath = 'full' | 'template';

export const CREATION_STAGES: Record<CreationPath, CeilingStage[]> = {
  full: ['scope', 'research', 'brief', 'blueprint', 'step'],
  // No research and no brief call: both are copied from the template.
  template: ['scope', 'adapt', 'step'],
};

/**
 * Input tokens per call, for T1 and T2 and for T3 up. Measured where a live
 * run exists, and rounded up: phase 2's systems-os research read about 56k
 * across its paused turns and a brief about 6.6k; the blueprint and step
 * figures are §11's assumptions with room for the brief and dossier prefix.
 * Adapting carries the template plan on top of the blueprint's input.
 */
export const INPUT_ESTIMATES: Record<CeilingStage, { small: number; large: number }> = {
  scope: { small: 3_000, large: 3_000 },
  research: { small: 40_000, large: 60_000 },
  brief: { small: 8_000, large: 14_000 },
  blueprint: { small: 10_000, large: 18_000 },
  adapt: { small: 14_000, large: 22_000 },
  step: { small: 14_000, large: 24_000 },
};

/** Calls per stage, retries included (§9 retry ceiling). */
export const STAGE_CALLS: Record<CeilingStage, number> = {
  scope: 1,
  // One turn: its paused continuations share the turn's maxTokens, and their
  // re-sent input is inside the research estimate above.
  research: 1,
  brief: BRIEF_MAX_ATTEMPTS,
  blueprint: BLUEPRINT_MAX_ATTEMPTS,
  adapt: BLUEPRINT_MAX_ATTEMPTS,
  step: EXPAND_MAX_ATTEMPTS,
};

export class UnpricedStageError extends Error {
  constructor(readonly stage: CeilingStage, readonly model: string) {
    super(`The ${stage} stage runs on ${model}, whose pricing is not verified; its cost cannot be bounded.`);
  }
}

export interface StageCeiling {
  stage: CeilingStage;
  model: string;
  calls: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  searches: number;
  usd: number;
}

export interface CreationCeiling {
  tier: ProjectTier;
  path: CreationPath;
  stages: StageCeiling[];
  totalUSD: number;
}

export interface CeilingOptions {
  /** Test seam: the stage table. */
  models?: Record<ProjectStage, Record<ProjectTier, ProjectStageSettings | null>>;
  /** Test seam: the model the scope call runs on. */
  scopeModel?: string;
}

const large = (tier: ProjectTier) => tier !== 'T1' && tier !== 'T2';

/** The worst case of one stage at one tier, or null when it does not run there (T1 research). */
export function stageCostCeiling(
  stage: CeilingStage,
  tier: ProjectTier,
  options: CeilingOptions = {},
): StageCeiling | null {
  const { models = PROJECT_MODELS, scopeModel = TASK_DEFAULTS.interview } = options;
  let modelId: string;
  let outputTokensPerCall: number;
  if (stage === 'scope') {
    modelId = scopeModel;
    outputTokensPerCall = CLASSIFY_MAX_TOKENS;
  } else {
    const settings = models[stage][tier];
    if (!settings) return null;
    modelId = settings.model;
    outputTokensPerCall = settings.maxTokens;
  }

  const pricing = getModel(modelId)?.pricing;
  if (!pricing || getModel(modelId)?.verifiedOn === null) throw new UnpricedStageError(stage, modelId);

  const calls = STAGE_CALLS[stage];
  const inputTokensPerCall = INPUT_ESTIMATES[stage][large(tier) ? 'large' : 'small'];
  const searches = stage === 'research' ? PROJECT_RESEARCH_BUDGET.searches : 0;
  const perCall = (inputTokensPerCall * pricing.inputPerMTok + outputTokensPerCall * pricing.outputPerMTok) / 1_000_000;
  const usd = calls * perCall + searches * WEB_SEARCH_USD_PER_SEARCH;
  return { stage, model: modelId, calls, inputTokensPerCall, outputTokensPerCall, searches, usd };
}

/** The most creating a project can cost at this tier, on this path. */
export function projectCostCeiling(
  tier: ProjectTier,
  path: CreationPath = 'full',
  options: CeilingOptions = {},
): CreationCeiling {
  const stages = CREATION_STAGES[path]
    .map((stage) => stageCostCeiling(stage, tier, options))
    .filter((s): s is StageCeiling => s !== null);
  return { tier, path, stages, totalUSD: stages.reduce((sum, s) => sum + s.usd, 0) };
}
