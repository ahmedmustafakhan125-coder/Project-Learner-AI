import { describe, expect, it } from 'vitest';
import {
  buildAnthropicMessages,
  buildSystemBlocks,
  mapAnthropicUsage,
} from '../src/adapters/anthropic.js';
import { mapUsage } from '../src/adapters/openai-compatible.js';

describe('anthropic: system block mapping', () => {
  it('marks only the flagged block as the cache boundary', () => {
    const blocks = buildSystemBlocks([
      { text: 'shared pedagogy core' },
      { text: 'more shared context', cacheBoundary: true },
    ])!;

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).not.toHaveProperty('cache_control');
    expect(blocks[1]).toHaveProperty('cache_control');
  });

  it('uses the 1h TTL, which a four-agent fan-out repays within one query', () => {
    const blocks = buildSystemBlocks([{ text: 'core', cacheBoundary: true }])!;
    expect((blocks[0] as Record<string, any>)['cache_control']).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('emits no cache marker when no boundary is declared', () => {
    const blocks = buildSystemBlocks([{ text: 'a' }, { text: 'b' }])!;
    expect(blocks.every((b) => !('cache_control' in b))).toBe(true);
  });

  it('returns undefined for an absent or empty system prompt', () => {
    expect(buildSystemBlocks(undefined)).toBeUndefined();
    expect(buildSystemBlocks([])).toBeUndefined();
  });

  it('preserves block text byte-for-byte', () => {
    const text = 'Exact  spacing\n\tand tabs — kept.';
    expect(buildSystemBlocks([{ text }])![0]!.text).toBe(text);
  });
});

describe('anthropic: mid-conversation system messages', () => {
  const convo = [
    { role: 'user' as const, content: 'the question' },
    { role: 'system' as const, content: 'per-agent instruction' },
  ];

  it('keeps the system role when the model supports it', () => {
    const mapped = buildAnthropicMessages(convo, true) as Array<{ role: string }>;
    expect(mapped[1]!.role).toBe('system');
  });

  it('degrades to a user turn when the model rejects mid-conversation system', () => {
    // Sonnet 5 and Haiku 4.5 return a 400 for role:"system" in messages[].
    // Degrading keeps the request working AND keeps the instruction after the
    // cached prefix, so caching still holds.
    const mapped = buildAnthropicMessages(convo, false) as Array<{ role: string }>;
    expect(mapped[1]!.role).toBe('user');
  });

  it('never reorders the conversation', () => {
    const mapped = buildAnthropicMessages(convo, false) as Array<{ content: unknown }>;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]!.content).toBe('the question');
  });
});

describe('openai-compatible: usage normalisation', () => {
  it('subtracts cached tokens so they are not billed twice', () => {
    // OpenAI reports prompt_tokens as the TOTAL *including* cached tokens,
    // unlike Anthropic where input_tokens is the uncached remainder. Without
    // the subtraction, a cached request is charged at full rate here AND again
    // as cache-read — the exact bug this normalisation exists to prevent.
    const usage = mapUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });

    expect(usage.inputTokens).toBe(200);
    expect(usage.cacheReadTokens).toBe(800);
    expect(usage.inputTokens + usage.cacheReadTokens).toBe(1000);
  });

  it('reads the DeepSeek field name for cache hits', () => {
    const usage = mapUsage({
      prompt_tokens: 500,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 400,
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.cacheReadTokens).toBe(400);
  });

  it('never reports negative input if a provider reports inconsistent numbers', () => {
    const usage = mapUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } });
    expect(usage.inputTokens).toBe(0);
  });

  it('reports zeros rather than NaN when usage is missing entirely', () => {
    const usage = mapUsage(undefined);
    expect(usage).toMatchObject({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it('surfaces reasoning tokens when the provider reports them', () => {
    const usage = mapUsage({
      prompt_tokens: 10,
      completion_tokens: 90,
      completion_tokens_details: { reasoning_tokens: 60 },
    });
    expect(usage.reasoningTokens).toBe(60);
  });
});

describe('anthropic: cache TTLs (docs/project-studio.md §4)', () => {
  it('keeps the 1h default on system blocks and honours 5m when asked', () => {
    const blocks = buildSystemBlocks([
      { text: 'shared', cacheBoundary: true },
      { text: 'per project', cacheBoundary: true, cacheTtl: '5m' },
    ]) as Array<Record<string, any>>;
    expect(blocks[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('keeps the 5m default on content parts and honours 1h when asked', () => {
    const mapped = buildAnthropicMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'prefix', cacheBoundary: true },
            { type: 'text', text: 'long-lived', cacheBoundary: true, cacheTtl: '1h' },
          ],
        },
      ],
      false,
    ) as Array<{ content: Array<Record<string, any>> }>;
    expect(mapped[0]!.content[0]!['cache_control']).toEqual({ type: 'ephemeral' });
    expect(mapped[0]!.content[1]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('anthropic: usage mapping', () => {
  it('reads the 5m write split and the web search count', () => {
    const usage = mapAnthropicUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 248,
      cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
      server_tool_use: { web_search_requests: 3 },
    } as never);
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 248,
      cacheWrite5mTokens: 148,
      webSearchRequests: 3,
    });
  });

  it('leaves the optional fields out when the response has none', () => {
    const usage = mapAnthropicUsage({ input_tokens: 1, output_tokens: 2 } as never);
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
