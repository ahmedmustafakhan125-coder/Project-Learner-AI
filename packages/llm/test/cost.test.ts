import { describe, expect, it } from 'vitest';
import { addUsage, computeCost, emptyUsage, totalPromptTokens } from '../src/cost.js';
import type { LLMUsage } from '../src/types.js';

const usage = (over: Partial<LLMUsage> = {}): LLMUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe('computeCost', () => {
  it('prices a verified model from its registry rates', () => {
    // claude-opus-5: $5/MTok in, $25/MTok out.
    const cost = computeCost('claude-opus-5', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost.inputUSD).toBeCloseTo(5, 6);
    expect(cost.outputUSD).toBeCloseTo(25, 6);
    expect(cost.totalUSD).toBeCloseTo(30, 6);
    expect(cost.unpriced).toBe(false);
  });

  it('prices cache reads far below fresh input', () => {
    const fresh = computeCost('claude-opus-5', usage({ inputTokens: 1_000_000 }));
    const cached = computeCost('claude-opus-5', usage({ cacheReadTokens: 1_000_000 }));
    expect(cached.totalUSD!).toBeLessThan(fresh.totalUSD!);
    expect(cached.totalUSD!).toBeCloseTo(0.5, 6); // ~0.1x input
  });

  it('prices cache writes above fresh input', () => {
    const fresh = computeCost('claude-opus-5', usage({ inputTokens: 1_000_000 }));
    const written = computeCost('claude-opus-5', usage({ cacheWriteTokens: 1_000_000 }));
    expect(written.totalUSD!).toBeGreaterThan(fresh.totalUSD!); // 2x at the 1h TTL
  });

  it('returns null — never zero — for a model with unverified pricing', () => {
    // A zero here would read downstream as "this call was free" and silently
    // defeat budget enforcement. This is the whole point of the null.
    const cost = computeCost('deepseek-chat', usage({ inputTokens: 500_000, outputTokens: 500_000 }));
    expect(cost.totalUSD).toBeNull();
    expect(cost.inputUSD).toBeNull();
    expect(cost.unpriced).toBe(true);
  });

  it('returns null for a model that is not registered at all', () => {
    expect(computeCost('no-such-model', usage({ inputTokens: 10 })).totalUSD).toBeNull();
  });
});

describe('usage helpers', () => {
  it('totalPromptTokens counts cached traffic, which inputTokens alone omits', () => {
    const u = usage({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 });
    expect(totalPromptTokens(u)).toBe(1050);
  });

  it('addUsage sums every field', () => {
    const sum = addUsage(
      usage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      usage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }),
    );
    expect(sum).toMatchObject({
      inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44,
    });
  });

  it('emptyUsage is a zero identity for addUsage', () => {
    const u = usage({ inputTokens: 7, outputTokens: 9 });
    expect(addUsage(u, emptyUsage())).toMatchObject({ inputTokens: 7, outputTokens: 9 });
  });
});
