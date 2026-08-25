import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type OpenAI from 'openai';

import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { getModel, getVendor } from '../src/registry.js';
import { LLMStructuredOutputError } from '../src/types.js';

const Schema = z.object({ name: z.string(), count: z.number().int() });

/** A fake client whose `chat.completions.create` returns queued bodies in order. */
function fakeClient(bodies: string[]) {
  const create = vi.fn(async () => ({
    model: 'fake',
    choices: [{ message: { content: bodies.shift() ?? '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }));
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

function adapterWith(bodies: string[]) {
  const entry = getModel('deepseek-chat')!;
  const vendor = getVendor('deepseek-chat')!;
  const { client, create } = fakeClient(bodies);
  return { adapter: new OpenAICompatibleAdapter(entry, vendor, 'sk-fake', client), create };
}

const req = {
  model: 'deepseek-chat',
  messages: [{ role: 'user' as const, content: 'extract it' }],
};

describe('structured() degradation and repair', () => {
  it('returns validated data on a clean first attempt', async () => {
    const { adapter, create } = adapterWith(['{"name":"widgets","count":3}']);
    const result = await adapter.structured(req, Schema);

    expect(result.data).toEqual({ name: 'widgets', count: 3 });
    expect(result.repaired).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('tolerates markdown fences and surrounding prose from weaker providers', async () => {
    const { adapter, create } = adapterWith([
      'Sure! Here you go:\n```json\n{"name":"widgets","count":3}\n```\nHope that helps.',
    ]);
    const result = await adapter.structured(req, Schema);

    // No repair round needed — extraction handled it.
    expect(result.data).toEqual({ name: 'widgets', count: 3 });
    expect(result.repaired).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('repairs a schema-invalid first response and flags it', async () => {
    const { adapter, create } = adapterWith([
      '{"name":"widgets","count":"three"}', // count is a string, not an int
      '{"name":"widgets","count":3}',
    ]);
    const result = await adapter.structured(req, Schema);

    expect(result.data).toEqual({ name: 'widgets', count: 3 });
    expect(result.repaired).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('feeds the actual validation error back into the repair attempt', async () => {
    const { adapter, create } = adapterWith([
      '{"name":"widgets"}', // missing `count`
      '{"name":"widgets","count":1}',
    ]);
    await adapter.structured(req, Schema);

    const repairCall = create.mock.calls[1]![0] as { messages: Array<{ content: string }> };
    const repairPrompt = repairCall.messages.map((m) => m.content).join('\n');
    expect(repairPrompt).toMatch(/count/);
  });

  it('repairs unparseable JSON, not just invalid shapes', async () => {
    const { adapter } = adapterWith(['not json at all', '{"name":"ok","count":0}']);
    const result = await adapter.structured(req, Schema);
    expect(result.repaired).toBe(true);
  });

  it('throws a typed error after the repair also fails — never returns raw text', async () => {
    const { adapter, create } = adapterWith(['garbage', 'still garbage']);

    await expect(adapter.structured(req, Schema)).rejects.toThrow(LLMStructuredOutputError);
    expect(create).toHaveBeenCalledTimes(2); // exactly one repair, no infinite loop
  });

  it('attaches the raw output and issues to the thrown error for debugging', async () => {
    const { adapter } = adapterWith(['{"name":123}', '{"name":456}']);

    await adapter.structured(req, Schema).then(
      () => expect.fail('should have thrown'),
      (err: unknown) => {
        expect(err).toBeInstanceOf(LLMStructuredOutputError);
        const structured = err as LLMStructuredOutputError;
        expect(structured.raw).toBe('{"name":456}');
        expect(structured.issues.join(' ')).toMatch(/name|count/);
        expect(structured.retryable).toBe(false);
      },
    );
  });
});

describe('error classification', () => {
  it('marks structured-output failures as terminal, not retryable', () => {
    const err = new LLMStructuredOutputError('x', { raw: '', issues: [] });
    expect(err.retryable).toBe(false);
  });
});
