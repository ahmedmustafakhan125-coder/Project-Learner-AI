/**
 * Token → USD accounting.
 *
 * Every number here comes from `registry.ts`. When an entry has no verified
 * pricing the cost is `null`, not zero — a zero would read downstream as "this
 * call was free" and quietly defeat budget enforcement.
 */

import { getModel } from './registry.js';
import type { LLMUsage } from './types.js';

export interface CostBreakdown {
  inputUSD: number | null;
  outputUSD: number | null;
  cacheReadUSD: number | null;
  cacheWriteUSD: number | null;
  totalUSD: number | null;
  /** True when this model's pricing has not been verified against vendor docs. */
  unpriced: boolean;
}

const PER_MTOK = 1_000_000;

export function computeCost(modelId: string, usage: LLMUsage): CostBreakdown {
  const model = getModel(modelId);
  const pricing = model?.pricing;

  if (!pricing) {
    return {
      inputUSD: null,
      outputUSD: null,
      cacheReadUSD: null,
      cacheWriteUSD: null,
      totalUSD: null,
      unpriced: true,
    };
  }

  const inputUSD = (usage.inputTokens / PER_MTOK) * pricing.inputPerMTok;
  const outputUSD = (usage.outputTokens / PER_MTOK) * pricing.outputPerMTok;

  // Fall back to the base input rate when a provider does not price cache
  // traffic separately — those tokens were still processed and billed.
  const cacheReadUSD =
    (usage.cacheReadTokens / PER_MTOK) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok);
  const cacheWriteUSD =
    (usage.cacheWriteTokens / PER_MTOK) * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);

  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheWriteUSD,
    totalUSD: inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD,
    unpriced: model?.verifiedOn === null,
  };
}

/** Total prompt size. `inputTokens` alone is only the uncached remainder. */
export function totalPromptTokens(usage: LLMUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function emptyUsage(): LLMUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
  };
}
