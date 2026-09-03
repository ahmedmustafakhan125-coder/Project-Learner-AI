import { bufferStream, firstTokenOrTimeout, withRetry } from '@ai-edu/llm';
import type { LLMContentPart, LLMEvent, LLMMessage, LLMProvider, LLMRequest, LLMUsage } from '@ai-edu/llm';

import type { AbortSignalLike } from '../platform.js';
import { AGENT_ORDER } from '../schemas/common.js';
import type { AgentKind } from '../schemas/common.js';
import type { CompiledQuery } from '../schemas/interview.js';
import type { KnowledgeBundle } from '../knowledge/types.js';
import { renderKnowledge } from '../knowledge/select.js';
import { AGENT_INSTRUCTION, PEDAGOGY_CORE } from './prompts.js';

/**
 * The four-agent fan-out.
 *
 * All four agents share one byte-identical prefix and differ only in a trailing
 * instruction, so the shared context is processed once and read three times
 * instead of being paid for four times.
 *
 * That saving depends entirely on the stagger below. A cache entry only becomes
 * readable once the request that writes it is already in flight — fire all four
 * simultaneously and none can read what the others are still writing, so every
 * one pays full price. The lead request goes out alone, and the other three
 * follow once its first token proves the cache is live.
 */

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export type FanOutEvent =
  | { agent: AgentKind; type: 'start' }
  | { agent: AgentKind; type: 'delta'; text: string }
  | { agent: AgentKind; type: 'done'; usage: LLMUsage; latencyMs: number; text: string }
  | { agent: AgentKind; type: 'error'; message: string; retryable: boolean };

/* ------------------------------------------------------------------ *
 * Per-agent tuning
 * ------------------------------------------------------------------ */

/**
 * The practice agent writes a whole HTML page, so it needs materially more
 * room than the others. Concepts is a bounded list and needs least.
 */
const MAX_TOKENS: Record<AgentKind, number> = {
  simple: 4_000,
  industry: 5_000,
  practice: 10_000,
  concepts: 3_000,
};

/**
 * Effort spend follows how much genuine reasoning each angle needs. Explaining
 * clearly and listing takeaways are largely retrieval; grounding real-world
 * tradeoffs and designing a working exercise are not.
 */
const EFFORT: Record<AgentKind, LLMRequest['reasoning']> = {
  simple: 'medium',
  industry: 'high',
  practice: 'high',
  concepts: 'medium',
};

/** Ceiling on waiting for the lead. Losing a cache read costs money; blocking the fan-out costs the answer. */
const DEFAULT_LEAD_TIMEOUT_MS = 2_000;

/* ------------------------------------------------------------------ *
 * Request building
 * ------------------------------------------------------------------ */

export interface BuildRequestOptions {
  provider: LLMProvider;
  compiled: CompiledQuery;
  history?: LLMMessage[];
  /**
   * The curated OKF bundle. Selection happens in here rather than at the call
   * site so all four agents cannot be handed different concepts: identical
   * bytes across the four is what makes the shared cache entry work at all.
   */
  knowledge?: KnowledgeBundle;
}

/**
 * Everything before the trailing per-agent instruction is identical across the
 * four agents. A unit test asserts that byte-for-byte, because a stray
 * interpolation here would quadruple cost with no visible symptom.
 */
export function buildAgentRequest(
  kind: AgentKind,
  { provider, compiled, history = [], knowledge }: BuildRequestOptions,
): LLMRequest {
  const parts: LLMContentPart[] = [];

  // Curated knowledge goes ahead of the attachments and the question, inside the
  // block the cache boundary already covers. Deterministic selection keeps these
  // bytes stable, so the three followers read what the lead wrote.
  const knowledgeText = knowledge ? renderKnowledge(knowledge, compiled) : null;
  if (knowledgeText) {
    parts.push({ type: 'text', text: knowledgeText });
  }

  for (const file of compiled.attachments) {
    if (file.providerFileId && provider.capabilities.supportsFileUpload) {
      parts.push({ type: 'file', fileId: file.providerFileId, mediaType: file.mimeType });
    } else if (file.extractedText) {
      // Delimited so the model can tell uploaded material from instructions.
      // The guard against treating it as instructions lives in PEDAGOGY_CORE.
      parts.push({
        type: 'text',
        text: `<attachment filename="${file.filename}">\n${file.extractedText}\n</attachment>`,
      });
    }
  }

  // The cache boundary goes on the LAST shared block, so attachments and the
  // question are cached together and the three followers read both.
  parts.push({ type: 'text', text: compiled.text, cacheBoundary: true });

  const messages: LLMMessage[] = [
    ...history,
    { role: 'user', content: parts },
    // Placed after the cached prefix rather than in the system prompt. Editing
    // the system prompt per agent would change the bytes ahead of everything
    // and invalidate the shared cache entirely. Adapters degrade this to a user
    // turn on models that reject a mid-conversation system role — which sits in
    // the same position, so caching still holds.
    { role: 'system', content: AGENT_INSTRUCTION[kind] },
  ];

  return {
    model: provider.modelId,
    maxTokens: MAX_TOKENS[kind],
    reasoning: EFFORT[kind],
    system: [{ text: PEDAGOGY_CORE, cacheBoundary: true }],
    messages,
  };
}

/* ------------------------------------------------------------------ *
 * Fan-out
 * ------------------------------------------------------------------ */

export interface FanOutOptions extends BuildRequestOptions {
  signal?: AbortSignalLike;
  /** Override the lead-request wait. Mainly for tests. */
  leadTimeoutMs?: number;
}

export async function* fanOut(options: FanOutOptions): AsyncIterable<FanOutEvent> {
  const { provider, signal, leadTimeoutMs = DEFAULT_LEAD_TIMEOUT_MS } = options;

  const queue: FanOutEvent[] = [];
  let wake: (() => void) | null = null;
  let running = AGENT_ORDER.length;

  const emit = (event: FanOutEvent): void => {
    queue.push(event);
    const w = wake;
    wake = null;
    w?.();
  };

  /**
   * One agent's lifecycle. Errors are caught per-agent and emitted as events:
   * one specialist failing must never take down the other three, and the
   * learner should still get the angles that worked.
   *
   * The stream factory is wrapped in `withRetry` so transient failures (rate
   * limits, 5xx) are retried with exponential backoff before the agent is
   * declared failed. Retrying is vetoed once any delta has been emitted: the
   * consumer has already been handed those tokens, and a second attempt would
   * replay text the learner can see rather than replacing it.
   *
   * The real provider message and `retryable` flag are carried on the event.
   * They are diagnostics, not copy — `apps/api` decides what a learner sees and
   * persists the underlying error separately.
   */
  const consume = async (
    agent: AgentKind,
    streamFactory: () => AsyncIterable<LLMEvent>,
  ): Promise<void> => {
    const started = Date.now();
    let text = '';
    let emittedDelta = false;

    // Emitted once, outside the retry loop: `start` marks the agent appearing
    // in the UI, and a retry is meant to be invisible, not a second beginning.
    emit({ agent, type: 'start' });

    try {
      await withRetry(
        async () => {
          text = '';
          const events = streamFactory();
          for await (const event of events) {
            if (event.type === 'text_delta') {
              text += event.text;
              emittedDelta = true;
              emit({ agent, type: 'delta', text: event.text });
            } else if (event.type === 'done') {
              emit({
                agent,
                type: 'done',
                usage: event.response.usage,
                latencyMs: Date.now() - started,
                text,
              });
            }
          }
        },
        { shouldRetry: () => !emittedDelta, maxRetries: 2, baseDelayMs: 250 },
      );
    } catch (err) {
      emit({
        agent,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: Boolean((err as { retryable?: boolean })?.retryable),
      });
    } finally {
      running -= 1;
      const w = wake;
      wake = null;
      w?.();
    }
  };

  const streamFor = (agent: AgentKind) =>
    provider.stream({
      ...buildAgentRequest(agent, options),
      ...(signal ? { signal } : {}),
    });

  let tasks: Promise<void>[] = [];

  // When explicit prompt caching is supported (e.g. Anthropic), stagger the lead agent to write the cache prefix.
  // For all other providers (e.g. Gemini, OpenAI, OpenRouter), dispatch all 4 agents concurrently in parallel.
  if (provider.capabilities.explicitCaching && leadTimeoutMs > 0) {
    const [leadAgent, ...followers] = AGENT_ORDER;
    const lead = bufferStream(streamFor(leadAgent));
    let leadStreamTaken = false;
    const leadFactory = (): AsyncIterable<LLMEvent> => {
      if (!leadStreamTaken) {
        leadStreamTaken = true;
        return lead.events;
      }
      return streamFor(leadAgent);
    };
    tasks = [consume(leadAgent, leadFactory)];

    // Wait for first token proof before releasing followers
    await firstTokenOrTimeout(lead, leadTimeoutMs);

    for (const agent of followers) {
      tasks.push(consume(agent, () => streamFor(agent)));
    }
  } else {
    // Pure async parallel dispatch across all 4 specialist agents
    tasks = AGENT_ORDER.map((agent) => consume(agent, () => streamFor(agent)));
  }

  try {
    while (running > 0 || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift() as FanOutEvent;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // Deliberately NOT awaited. A consumer that abandons the iterator — most
    // often because the learner closed the tab — must be released immediately,
    // not held for as long as the slowest agent takes to finish.
    //
    // Detaching leaves the requests running upstream, so callers should pass a
    // `signal` and abort it on disconnect; that is what actually stops the
    // tokens being spent. The catch handlers exist only so an abandoned task's
    // rejection cannot surface as an unhandled rejection.
    for (const task of tasks) void task.catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Convenience
 * ------------------------------------------------------------------ */

export interface FanOutResult {
  text: string;
  usage: LLMUsage | null;
  latencyMs: number | null;
  error: string | null;
}

/** Drain a fan-out into per-agent results. Used by tests and non-streaming callers. */
export async function collectFanOut(
  options: FanOutOptions,
): Promise<Record<AgentKind, FanOutResult>> {
  const results = Object.fromEntries(
    AGENT_ORDER.map((agent) => [agent, { text: '', usage: null, latencyMs: null, error: null }]),
  ) as Record<AgentKind, FanOutResult>;

  for await (const event of fanOut(options)) {
    const entry = results[event.agent];
    if (event.type === 'delta') entry.text += event.text;
    else if (event.type === 'done') {
      entry.usage = event.usage;
      entry.latencyMs = event.latencyMs;
      entry.text = event.text;
    } else if (event.type === 'error') entry.error = event.message;
  }

  return results;
}
