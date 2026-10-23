import type { LLMProvider, LLMRequest } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { CLASSIFY_SYSTEM, SCOPED_CLASSIFY_SYSTEM, classifyQuery } from '../src/interview/classify.js';
import { PROFILES } from '../src/profiles/index.js';

/**
 * The classify call's `signals` (docs/project-learner.md §5).
 *
 * With `scoping` the call also extracts scope signals and the tier and
 * profile slots, under the same rule as slots: only what the message states.
 * Without it, the request is byte-identical to before, so PROJECT_LEARNER off
 * changes nothing the model sees.
 */

interface Schema {
  parse: (v: unknown) => unknown;
  safeParse: (v: unknown) => { success: boolean };
}

function recordingProvider(answer: unknown) {
  const requests: LLMRequest[] = [];
  const schemas: Schema[] = [];
  const provider = {
    id: 'openai-compatible',
    modelId: 'gemini-3.6-flash',
    capabilities: {},
    async structured(req: LLMRequest, schema: Schema) {
      requests.push(req);
      schemas.push(schema);
      return {
        data: schema.parse(answer),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'gemini',
        strategy: 'native-schema',
        repaired: false,
      };
    },
  } as unknown as LLMProvider;
  return { provider, requests, schemas };
}

/** `extracted` as the model writes it: a list of pairs. */
const pairs = (values: Record<string, string>) => Object.entries(values).map(([slot, value]) => ({ slot, value }));

describe('the extraction the model is asked for', () => {
  /*
   * It was a map (`extracted: { domain: "..." }`). The OpenAI-compatible
   * adapter closes every object in a strict schema with
   * `additionalProperties: false`, which left the map able to hold only `{}`:
   * Gemini could never report a fact, so every interview asked again for what
   * the learner had already said. A list of pairs survives the closing.
   */
  it('is a list of pairs, never a map with free keys', async () => {
    const { provider, schemas } = recordingProvider({ intent: 'project_generation', extracted: pairs({ tech: 'React' }) });
    const result = await classifyQuery({ provider, rawQuery: 'a weather dashboard in React' });
    await classifyQuery({ provider, rawQuery: 'a weather dashboard in React', scoping: true });

    expect(result.extracted).toEqual({ tech: 'React' });
    for (const schema of schemas) {
      expect(schema.safeParse({ intent: 'project_generation', extracted: { tech: 'React' } }).success).toBe(false);
      expect(schema.safeParse({ intent: 'project_generation', extracted: pairs({ tech: 'React' }) }).success).toBe(true);
    }
  });

  /*
   * What Gemini actually sent for "a weather dashboard in React for a few
   * hours": the facts, under names of its own. The names are now enumerated
   * in the schema; one that still slips through is dropped without taking the
   * rest of the answer with it.
   */
  it('drops a slot name of the model’s own and keeps the rest', async () => {
    const { provider } = recordingProvider({
      intent: 'project_generation',
      extracted: [
        { slot: 'technology', value: 'React' },
        { slot: 'time_budget', value: 'a few hours' },
      ],
    });
    const result = await classifyQuery({ provider, rawQuery: 'a weather dashboard in React for a few hours' });
    expect(result.extracted).toEqual({ time_budget: 'a few hours' });
  });
});

describe('classifyQuery without scoping', () => {
  it('sends the original system prompt and returns no signals', async () => {
    const { provider, requests } = recordingProvider({
      intent: 'project_generation',
      extracted: pairs({ domain: 'operating system', interface: 'cli' }),
    });
    const result = await classifyQuery({ provider, rawQuery: 'I want to build an operating system' });

    expect(requests[0]!.system).toEqual([{ text: CLASSIFY_SYSTEM, cacheBoundary: true }]);
    expect(CLASSIFY_SYSTEM).not.toMatch(/signals/i);
    expect(result).not.toHaveProperty('signals');
    // A tier slot is not a slot before intake scores a tier.
    expect(result.extracted).toEqual({ domain: 'operating system' });
  });
});

describe('classifyQuery with scoping', () => {
  it('uses one static system prompt that lists the signals and every profile slot', async () => {
    const { provider, requests } = recordingProvider({ intent: 'project_generation', extracted: [] });
    await classifyQuery({ provider, rawQuery: 'a kernel', scoping: true });
    await classifyQuery({ provider, rawQuery: 'a notes app in Tauri', scoping: true });

    expect(requests[0]!.system).toEqual([{ text: SCOPED_CLASSIFY_SYSTEM, cacheBoundary: true }]);
    expect(JSON.stringify(requests[0]!.system)).toBe(JSON.stringify(requests[1]!.system));
    expect(SCOPED_CLASSIFY_SYSTEM).toMatch(/domainWords/);
    expect(SCOPED_CLASSIFY_SYSTEM).toMatch(/bareMetal/);
    for (const profile of Object.values(PROFILES)) {
      for (const slot of profile.slots) expect(SCOPED_CLASSIFY_SYSTEM).toContain(`- ${slot.key}:`);
    }
    // The learner's words ride in the user turn only.
    expect(SCOPED_CLASSIFY_SYSTEM).not.toContain('Tauri');
  });

  it('returns parsed signals and keeps tier and profile slots, dropping invented keys', async () => {
    const { provider } = recordingProvider({
      intent: 'project_generation',
      extracted: pairs({ domain: 'kernel', target_arch: 'x86-64', interface: 'serial console', made_up: 'x' }),
      signals: { domainWords: ['kernel'], bareMetal: true },
    });
    const result = await classifyQuery({ provider, rawQuery: 'an x86-64 kernel', scoping: true });

    expect(result.signals).toEqual({ domainWords: ['kernel'], interfaces: [], bareMetal: true });
    expect(result.extracted).toEqual({ domain: 'kernel', target_arch: 'x86-64', interface: 'serial console' });
  });

  it('gives empty signals when the model returns none, and none at all for other intents', async () => {
    const { provider } = recordingProvider({ intent: 'project_generation', extracted: [] });
    const result = await classifyQuery({ provider, rawQuery: 'build something', scoping: true });
    expect(result.signals).toEqual({ domainWords: [], interfaces: [] });

    const other = recordingProvider({
      intent: 'concept_question',
      extracted: pairs({ topic: 'closures', target_arch: 'x86' }),
      signals: { bareMetal: true },
    });
    const concept = await classifyQuery({ provider: other.provider, rawQuery: 'what is a closure', scoping: true });
    expect(concept.extracted).toEqual({ topic: 'closures' });
    expect(concept.signals).toEqual({ domainWords: [], interfaces: [] });
  });
});
