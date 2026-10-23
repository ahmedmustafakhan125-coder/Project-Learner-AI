/**
 * Token → USD accounting.
 *
 * Every number here comes from `registry.ts`. When an entry has no verified
 * pricing the cost is `null`, not zero — a zero would read downstream as "this
 * call was free" and quietly defeat budget enforcement.
 */

import { getModel } from './registry.js';
import type { LLMEvent, LLMProvider, LLMRequest, LLMUsage, OutputSchema } from './types.js';

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
  // 5-minute writes at their own rate when both the price and the split are
  // known; everything else at the 1h rate, so a write is never understated.
  const writeRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  const fiveMinute =
    pricing.cacheWrite5mPerMTok !== undefined
      ? Math.min(usage.cacheWrite5mTokens ?? 0, usage.cacheWriteTokens)
      : 0;
  const cacheWriteUSD =
    (fiveMinute / PER_MTOK) * (pricing.cacheWrite5mPerMTok ?? 0) +
    ((usage.cacheWriteTokens - fiveMinute) / PER_MTOK) * writeRate;

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
  const optional = (key: 'cacheWrite5mTokens' | 'webSearchRequests') =>
    a[key] === undefined && b[key] === undefined ? {} : { [key]: (a[key] ?? 0) + (b[key] ?? 0) };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...optional('cacheWrite5mTokens'),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
    ...optional('webSearchRequests'),
  };
}

export interface MeteredProvider {
  provider: LLMProvider;
  /** Everything the calls through `provider` have used so far. */
  usage(): LLMUsage;
}

/**
 * Wrap a provider so every call through it is added up.
 *
 * For a route whose core function makes several calls and returns only its
 * result, such as the interview: the route records the sum rather than a row
 * of zeros. A call that throws used nothing this can see.
 */
export function meterUsage(inner: LLMProvider): MeteredProvider {
  let total = emptyUsage();
  const add = (usage: LLMUsage) => {
    total = addUsage(total, usage);
  };

  const provider: LLMProvider = {
    id: inner.id,
    modelId: inner.modelId,
    capabilities: inner.capabilities,
    async complete(req: LLMRequest) {
      const response = await inner.complete(req);
      add(response.usage);
      return response;
    },
    async structured<Out>(req: LLMRequest, schema: OutputSchema<Out>) {
      const result = await inner.structured(req, schema);
      add(result.usage);
      return result;
    },
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      for await (const event of inner.stream(req)) {
        if (event.type === 'done') add(event.response.usage);
        yield event;
      }
    },
    ...(inner.countTokens ? { countTokens: inner.countTokens.bind(inner) } : {}),
    ...(inner.uploadFile ? { uploadFile: inner.uploadFile.bind(inner) } : {}),
  };

  return { provider, usage: () => total };
}
