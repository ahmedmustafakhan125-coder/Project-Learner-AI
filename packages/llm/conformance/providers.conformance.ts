import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { computeCost } from '../src/cost.js';
import { createProvider } from '../src/factory.js';
import { listAvailableModels, listModels } from '../src/registry.js';
import { collectStream } from '../src/stream-utils.js';
import type { LLMEvent } from '../src/types.js';

/**
 * The contract every provider must satisfy.
 *
 * Adding a provider means making this suite pass and nothing more — that is the
 * whole promise of the adapter layer. Providers with no API key configured are
 * skipped so CI stays green without secrets.
 */

const available = listAvailableModels();

if (available.length === 0) {
  describe('provider conformance', () => {
    it.skip('no provider keys configured — set at least one API key to run', () => {});
  });
}

console.log(
  `[conformance] running against: ${available.map((m) => m.id).join(', ') || '(none)'}\n` +
    `[conformance] not configured: ${listModels()
      .filter((m) => !available.some((a) => a.id === m.id))
      .map((m) => m.id)
      .join(', ') || '(none)'}`,
);

for (const model of available) {
  describe(`conformance: ${model.id} (${model.vendor})`, () => {
    const provider = createProvider(model.id);

    it('streams ordered deltas and terminates with exactly one done event', async () => {
      const events: LLMEvent[] = [];
      for await (const event of provider.stream({
        model: model.id,
        maxTokens: 64,
        reasoning: 'none',
        messages: [{ role: 'user', content: 'Say the single word: hello' }],
      })) {
        events.push(event);
      }

      expect(events[0]?.type, 'first event must be `start`').toBe('start');
      expect(events.at(-1)?.type, 'last event must be `done`').toBe('done');
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.some((e) => e.type === 'text_delta'), 'expected at least one text delta').toBe(true);

      // No event may follow `done`.
      const doneIndex = events.findIndex((e) => e.type === 'done');
      expect(doneIndex).toBe(events.length - 1);
    });

    it('accumulates streamed text into the terminal response', async () => {
      let streamed = '';
      const events: LLMEvent[] = [];
      for await (const event of provider.stream({
        model: model.id,
        maxTokens: 64,
        reasoning: 'none',
        messages: [{ role: 'user', content: 'Reply with exactly: ping' }],
      })) {
        if (event.type === 'text_delta') streamed += event.text;
        events.push(event);
      }

      const done = events.at(-1);
      expect(done?.type).toBe('done');
      if (done?.type === 'done') {
        expect(done.response.text.trim()).toBe(streamed.trim());
        expect(done.response.text.toLowerCase()).toContain('ping');
      }
    });

    it('reports usage with a non-zero input token count', async () => {
      const response = await collectStream(
        provider.stream({
          model: model.id,
          maxTokens: 32,
          reasoning: 'none',
          messages: [{ role: 'user', content: 'Say: ok' }],
        }),
      );

      // inputTokens is the *uncached remainder*, so a cache hit can legitimately
      // make it zero — assert on the total prompt size instead.
      const totalPrompt =
        response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens;
      expect(totalPrompt).toBeGreaterThan(0);
      expect(response.usage.outputTokens).toBeGreaterThan(0);
    });

    it('completes non-streaming requests', async () => {
      const response = await provider.complete({
        model: model.id,
        maxTokens: 32,
        reasoning: 'none',
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      });
      expect(response.text.toLowerCase()).toContain('pong');
      expect(response.stopReason).toBeTruthy();
    });

    it('returns a schema-valid object from structured()', async () => {
      const Schema = z.object({
        language: z.string().describe('the programming language named'),
        isCompiled: z.boolean(),
        releaseYear: z.number().int(),
      });

      const result = await provider.structured(
        {
          model: model.id,
          maxTokens: 512,
          reasoning: 'none',
          messages: [
            {
              role: 'user',
              content:
                'Rust is a compiled systems programming language first released in 2015. ' +
                'Extract it into the required shape.',
            },
          ],
        },
        Schema,
      );

      // Throwing on invalid output is the contract — reaching here means valid.
      expect(Schema.safeParse(result.data).success).toBe(true);
      expect(result.data.language.toLowerCase()).toContain('rust');
      expect(result.data.isCompiled).toBe(true);
      expect(result.strategy).toBe(model.capabilities.structuredOutput);
    });

    it('produces a usable cost figure, or an explicit null when unpriced', () => {
      const cost = computeCost(model.id, {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });

      if (model.pricing === null) {
        expect(cost.totalUSD, `${model.id} is unpriced; cost must be null, never 0`).toBeNull();
        expect(cost.unpriced).toBe(true);
      } else {
        expect(cost.totalUSD).toBeGreaterThan(0);
        expect(cost.unpriced).toBe(false);
      }
    });

    it.runIf(typeof provider.countTokens === 'function')(
      'counts tokens without sending a completion',
      async () => {
        const count = await provider.countTokens!({
          model: model.id,
          messages: [{ role: 'user', content: 'How many tokens is this?' }],
        });
        expect(count).toBeGreaterThan(0);
      },
    );
  });
}
