import { describe, expect, it } from 'vitest';
import type { LLMEvent, LLMProvider, LLMRequest } from '@ai-edu/llm';

import { collectFanOut, fanOut } from '../src/agents/fanOut.js';
import { AGENT_INSTRUCTION } from '../src/agents/prompts.js';
import { AGENT_ORDER } from '../src/schemas/common.js';
import type { AgentKind } from '../src/schemas/common.js';
import type { CompiledQuery } from '../src/schemas/interview.js';

const compiled: CompiledQuery = {
  intent: 'concept_question',
  originalQuery: 'what is a closure?',
  text: '<learner_question>\nwhat is a closure?\n</learner_question>',
  slots: {},
  attachments: [],
  partial: false,
};

const CAPS: LLMProvider['capabilities'] = {
  explicitCaching: true,
  structuredOutput: 'native-schema',
  midConversationSystem: true,
  reasoningControl: 'effort',
  maxContext: 1_000_000,
  maxOutputTokens: 128_000,
  supportsFileUpload: true,
  supportsImages: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which agent a request is for, read from its trailing instruction. */
function agentOf(request: LLMRequest): AgentKind {
  const instruction = request.messages.at(-1)?.content;
  const found = AGENT_ORDER.find((a) => AGENT_INSTRUCTION[a] === instruction);
  if (!found) throw new Error('request carried no recognisable agent instruction');
  return found;
}

interface MockOptions {
  /** Delay before each agent's first token. */
  firstTokenDelayMs?: Partial<Record<AgentKind, number>>;
  /** Agents that should throw instead of streaming. */
  failing?: AgentKind[];
  /** Agents that should never produce a token at all. */
  silent?: AgentKind[];
}

interface MockProvider {
  provider: LLMProvider;
  /** Agents whose stream() was called, in call order. */
  callOrder: AgentKind[];
  /** Whether the lead had already emitted a token when each agent was invoked. */
  leadHadEmittedAt: Partial<Record<AgentKind, boolean>>;
}

function mockProvider(options: MockOptions = {}): MockProvider {
  const { firstTokenDelayMs = {}, failing = [], silent = [] } = options;
  const callOrder: AgentKind[] = [];
  const leadHadEmittedAt: Partial<Record<AgentKind, boolean>> = {};
  let leadEmitted = false;

  const provider = {
    id: 'anthropic',
    modelId: 'claude-opus-5',
    capabilities: CAPS,
    async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      const agent = agentOf(request);
      callOrder.push(agent);
      leadHadEmittedAt[agent] = leadEmitted;

      if (failing.includes(agent)) {
        throw Object.assign(new Error(`${agent} provider exploded`), { retryable: false });
      }

      yield { type: 'start', model: 'claude-opus-5' };

      const delay = firstTokenDelayMs[agent] ?? 0;
      if (delay) await sleep(delay);

      if (!silent.includes(agent)) {
        if (agent === AGENT_ORDER[0]) leadEmitted = true;
        yield { type: 'text_delta', text: `${agent}-1` };
        yield { type: 'text_delta', text: `${agent}-2` };
      }

      yield {
        type: 'done',
        response: {
          text: silent.includes(agent) ? '' : `${agent}-1${agent}-2`,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: 'end_turn',
          model: 'claude-opus-5',
        },
      };
    },
  } as unknown as LLMProvider;

  return { provider, callOrder, leadHadEmittedAt };
}

/* ------------------------------------------------------------------ *
 * The stagger — the entire cost argument rests on this
 * ------------------------------------------------------------------ */

describe('cache stagger', () => {
  it('sends the lead request before any follower', async () => {
    const mock = mockProvider();
    await collectFanOut({ provider: mock.provider, compiled });

    expect(mock.callOrder[0]).toBe(AGENT_ORDER[0]);
    expect(mock.callOrder).toHaveLength(4);
  });

  it('holds the followers until the lead has actually produced a token', async () => {
    // This is the whole point. A cache entry only becomes readable once the
    // request writing it is in flight — fire all four at once and none can read
    // what the others are still writing, so every one pays full price.
    const mock = mockProvider({ firstTokenDelayMs: { simple: 40 } });
    await collectFanOut({ provider: mock.provider, compiled, leadTimeoutMs: 5_000 });

    for (const follower of AGENT_ORDER.slice(1)) {
      expect(
        mock.leadHadEmittedAt[follower],
        `${follower} was dispatched before the lead produced a token`,
      ).toBe(true);
    }
  });

  it('releases the followers on the timeout when the lead stalls', async () => {
    // Losing a cache read costs money. Blocking the fan-out costs the learner
    // their answer, which is worse — so the wait is bounded.
    const mock = mockProvider({ firstTokenDelayMs: { simple: 10_000 } });
    const started = Date.now();

    for await (const _event of fanOut({
      provider: mock.provider,
      compiled,
      leadTimeoutMs: 50,
    })) {
      if (mock.callOrder.length === 4) break;
    }

    expect(mock.callOrder).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('releases the consumer immediately when it abandons the iterator', async () => {
    // A learner closing the tab must not hold the connection open until the
    // slowest agent finishes. The in-flight work is detached rather than
    // awaited; callers abort via `signal` to stop it actually running.
    const mock = mockProvider({ firstTokenDelayMs: { practice: 10_000 } });
    const started = Date.now();

    for await (const event of fanOut({
      provider: mock.provider,
      compiled,
      leadTimeoutMs: 50,
    })) {
      if (event.type === 'delta') break; // walk away on the very first token
    }

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not stall when the lead finishes without emitting any text', async () => {
    const mock = mockProvider({ silent: ['simple'] });
    const results = await collectFanOut({
      provider: mock.provider,
      compiled,
      leadTimeoutMs: 5_000,
    });
    expect(mock.callOrder).toHaveLength(4);
    expect(results.concepts.text).toBe('concepts-1concepts-2');
  });
});

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

describe('per-agent error isolation', () => {
  it('delivers the other three answers when one agent fails', async () => {
    const results = await collectFanOut({
      provider: mockProvider({ failing: ['industry'] }).provider,
      compiled,
    });

    expect(results.industry.error).toMatch(/exploded/);
    expect(results.industry.text).toBe('');

    for (const agent of ['simple', 'practice', 'concepts'] as const) {
      expect(results[agent].error).toBeNull();
      expect(results[agent].text).toBe(`${agent}-1${agent}-2`);
    }
  });

  it('survives the LEAD failing and still runs the followers', async () => {
    // The lead is also the cache writer, so its failure is the awkward case:
    // the stagger must not deadlock waiting for a token that never comes.
    const mock = mockProvider({ failing: ['simple'] });
    const results = await collectFanOut({
      provider: mock.provider,
      compiled,
      leadTimeoutMs: 5_000,
    });

    expect(results.simple.error).toMatch(/exploded/);
    expect(mock.callOrder).toHaveLength(4);
    expect(results.concepts.text).toBe('concepts-1concepts-2');
  });

  it('reports every agent failing without hanging', async () => {
    const results = await collectFanOut({
      provider: mockProvider({ failing: [...AGENT_ORDER] }).provider,
      compiled,
      leadTimeoutMs: 50,
    });
    for (const agent of AGENT_ORDER) {
      expect(results[agent].error).toBeTruthy();
    }
  });

  it('preserves the retryable flag so callers can decide about retrying', async () => {
    const provider = {
      id: 'anthropic',
      modelId: 'claude-opus-5',
      capabilities: CAPS,
      async *stream(): AsyncIterable<LLMEvent> {
        throw Object.assign(new Error('rate limited'), { retryable: true });
      },
    } as unknown as LLMProvider;

    for await (const event of fanOut({ provider, compiled, leadTimeoutMs: 20 })) {
      if (event.type === 'error') {
        expect(event.retryable).toBe(true);
        return;
      }
    }
    expect.fail('expected an error event');
  });
});

/* ------------------------------------------------------------------ *
 * Event contract
 * ------------------------------------------------------------------ */

describe('event stream', () => {
  it('emits start then deltas then done for each agent', async () => {
    const perAgent: Record<string, string[]> = {};
    for await (const event of fanOut({ provider: mockProvider().provider, compiled })) {
      (perAgent[event.agent] ??= []).push(event.type);
    }

    expect(Object.keys(perAgent).sort()).toEqual([...AGENT_ORDER].sort());
    for (const agent of AGENT_ORDER) {
      const types = perAgent[agent]!;
      expect(types[0]).toBe('start');
      expect(types.at(-1)).toBe('done');
      expect(types.filter((t) => t === 'done')).toHaveLength(1);
      expect(types.filter((t) => t === 'delta').length).toBeGreaterThan(0);
    }
  });

  it('interleaves agents rather than serialising them', async () => {
    // Four sequential answers would take four times as long to reach the
    // learner. The whole design assumes they stream concurrently.
    const seen: string[] = [];
    for await (const event of fanOut({
      provider: mockProvider({
        firstTokenDelayMs: { industry: 5, practice: 10, concepts: 15 },
      }).provider,
      compiled,
      leadTimeoutMs: 1_000,
    })) {
      if (event.type === 'delta') seen.push(event.agent);
    }

    const distinctBeforeFirstCompletes = new Set(seen.slice(0, 6));
    expect(distinctBeforeFirstCompletes.size).toBeGreaterThan(1);
  });

  it('carries usage on the done event so cost can be attributed per agent', async () => {
    const results = await collectFanOut({ provider: mockProvider().provider, compiled });
    for (const agent of AGENT_ORDER) {
      expect(results[agent].usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
      expect(results[agent].latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('accumulated deltas match the final text', async () => {
    let streamed = '';
    let final = '';
    for await (const event of fanOut({ provider: mockProvider().provider, compiled })) {
      if (event.agent !== 'simple') continue;
      if (event.type === 'delta') streamed += event.text;
      if (event.type === 'done') final = event.text;
    }
    expect(final).toBe(streamed);
  });
});
