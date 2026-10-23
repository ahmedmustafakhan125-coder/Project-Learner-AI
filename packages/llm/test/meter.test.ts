import { describe, expect, it } from 'vitest';

import { meterUsage } from '../src/cost.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../src/types.js';

/**
 * A metered provider adds up what every call through it used, for routes whose
 * core function makes several calls and reports none of them (the interview).
 */

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 };

const inner = {
  id: 'fake',
  modelId: 'fake-model',
  capabilities: {} as LLMProvider['capabilities'],
  async complete() {
    return { text: 'x', usage, stopReason: 'end_turn' as const, model: 'm' };
  },
  async structured() {
    return { data: { ok: true }, usage, model: 'm', strategy: 'native-schema' as const, repaired: false };
  },
  async *stream(): AsyncIterable<LLMEvent> {
    yield { type: 'start', model: 'm' };
    yield { type: 'text_delta', text: 'x' };
    yield { type: 'done', response: { text: 'x', usage, stopReason: 'end_turn', model: 'm' } };
  },
} as unknown as LLMProvider;

const req: LLMRequest = { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] };

describe('meterUsage', () => {
  it('sums complete, structured and stream calls', async () => {
    const meter = meterUsage(inner);
    await meter.provider.complete(req);
    await meter.provider.structured(req, {} as never);
    for await (const event of meter.provider.stream(req)) void event;
    expect(meter.usage()).toMatchObject({ inputTokens: 30, outputTokens: 15, cacheReadTokens: 3 });
  });

  it('keeps the inner provider identity', () => {
    const { provider } = meterUsage(inner);
    expect(provider.id).toBe('fake');
    expect(provider.modelId).toBe('fake-model');
  });

  it('starts at zero', () => {
    expect(meterUsage(inner).usage()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
