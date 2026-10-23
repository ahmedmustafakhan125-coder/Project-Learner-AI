import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AnthropicAdapter, buildOutputFormat } from '../src/adapters/anthropic.js';
import { getModel } from '../src/registry.js';
import { LLMStructuredOutputError } from '../src/types.js';

/**
 * Structured output on Claude.
 *
 * The SDK's `zodOutputFormat` only takes zod v4 schemas, and every schema here
 * is zod v3, so it threw before a request was sent: no Claude structured call
 * could succeed. The format is now built from a JSON schema and the answer is
 * validated with the caller's own schema, which also applies its defaults.
 */

const Shape = z.object({
  language: z.string(),
  tags: z.array(z.string()).default([]),
  level: z.enum(['low', 'high']),
});

/** An adapter whose network client is replaced by a recorded answer. */
function adapterAnswering(text: string) {
  const adapter = new AnthropicAdapter(getModel('claude-sonnet-5-5')!, 'sk-test');
  const sent: Record<string, unknown>[] = [];
  (adapter as unknown as { client: unknown }).client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        sent.push(params);
        return {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  };
  return { adapter, sent };
}

describe('anthropic: structured output format', () => {
  it('builds a closed JSON schema from a zod v3 schema without throwing', () => {
    const format = buildOutputFormat(Shape) as { type: string; schema: Record<string, any> };
    expect(format.type).toBe('json_schema');
    expect(format.schema['type']).toBe('object');
    expect(format.schema['additionalProperties']).toBe(false);
    expect(Object.keys(format.schema['properties'])).toEqual(['language', 'tags', 'level']);
  });

  it('sends the format in output_config beside the effort', async () => {
    const { adapter, sent } = adapterAnswering('{"language":"Rust","level":"high"}');
    await adapter.structured(
      { model: 'claude-sonnet-5-5', reasoning: 'low', messages: [{ role: 'user', content: 'x' }] },
      Shape,
    );
    const config = sent[0]!['output_config'] as Record<string, any>;
    expect(config['effort']).toBe('low');
    expect(config['format']['type']).toBe('json_schema');
    expect(typeof config['format']['parse']).toBe('undefined');
  });

  it('validates the answer with the caller schema, defaults included', async () => {
    const { adapter } = adapterAnswering('{"language":"Rust","level":"high"}');
    const result = await adapter.structured(
      { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] },
      Shape,
    );
    expect(result.data).toEqual({ language: 'Rust', tags: [], level: 'high' });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(result.strategy).toBe('native-schema');
  });

  it('throws a structured-output error, with the raw text, on an invalid answer', async () => {
    const { adapter } = adapterAnswering('{"language":"Rust","level":"medium"}');
    const call = adapter.structured(
      { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] },
      Shape,
    );
    await expect(call).rejects.toBeInstanceOf(LLMStructuredOutputError);
    await expect(call).rejects.toMatchObject({ raw: '{"language":"Rust","level":"medium"}' });
  });

  it('throws on a truncated answer that is not JSON', async () => {
    const { adapter } = adapterAnswering('{"language":"Ru');
    await expect(
      adapter.structured(
        { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] },
        Shape,
      ),
    ).rejects.toBeInstanceOf(LLMStructuredOutputError);
  });
});
