import { describe, expect, it } from 'vitest';

import { AnthropicAdapter, buildServerTools } from '../src/adapters/anthropic.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { WEB_SEARCH_USD_PER_SEARCH, addUsage, computeCost } from '../src/cost.js';
import { VENDORS, getModel, listModels, resolveProjectStage } from '../src/registry.js';
import { LLMBadRequestError, LLMConfigError } from '../src/types.js';
import type { LLMRequest, ServerToolSpec } from '../src/types.js';

/**
 * `adapter.serverTools` (docs/project-learner.md §4 and §14): the research
 * pass's web search and web fetch, mapped onto Claude's server tools, with
 * `pause_turn` continued, citations returned as data and searches counted.
 */

const SEARCH: ServerToolSpec = { kind: 'web_search', maxUses: 3, allowedDomains: ['wiki.osdev.org'] };
const FETCH: ServerToolSpec = {
  kind: 'web_fetch',
  maxUses: 4,
  allowedDomains: ['wiki.osdev.org'],
  maxContentTokens: 8_000,
  citations: true,
};

const request = (over: Partial<LLMRequest> = {}): LLMRequest => ({
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  maxTokens: 4_000,
  messages: [{ role: 'user', content: 'Research the IDT.' }],
  serverTools: [SEARCH, FETCH],
  ...over,
});

const usage = (input: number, output: number, searches = 0, fetches = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  server_tool_use: { web_search_requests: searches, web_fetch_requests: fetches },
});

/** An adapter whose client answers with each recorded message in turn. */
function adapterReplaying(messages: Record<string, unknown>[]) {
  const adapter = new AnthropicAdapter(getModel('claude-sonnet-5-5')!, 'sk-test');
  const sent: Record<string, any>[] = [];
  (adapter as unknown as { client: unknown }).client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        sent.push(structuredClone(params));
        const next = messages[Math.min(sent.length - 1, messages.length - 1)];
        return { model: 'claude-sonnet-5-5', ...next };
      },
    },
  };
  return { adapter, sent };
}

const PAUSED = {
  stop_reason: 'pause_turn',
  usage: usage(900, 40, 1, 0),
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'osdev IDT' }, caller: { type: 'direct' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      caller: { type: 'direct' },
      content: [
        { type: 'web_search_result', url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table', title: 'Interrupt Descriptor Table - OSDev Wiki', encrypted_content: 'x', page_age: null },
      ],
    },
  ],
};

const FINISHED = {
  stop_reason: 'end_turn',
  usage: usage(1_400, 300, 0, 1),
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table' }, caller: { type: 'direct' } },
    {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srvtoolu_2',
      caller: { type: 'direct' },
      content: {
        type: 'web_fetch_result',
        url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table',
        retrieved_at: '2026-10-23T12:00:00Z',
        content: { type: 'document', title: 'Interrupt Descriptor Table - OSDev Wiki', citations: { enabled: true }, source: { type: 'text', media_type: 'text/plain', data: '…' } },
      },
    },
    { type: 'text', text: '# osdev-core\n## APIs\n- ', citations: null },
    {
      type: 'text',
      text: 'lidt | lidt m16&64',
      citations: [
        {
          type: 'char_location',
          cited_text: 'The IDT is loaded using the LIDT assembly instruction.',
          document_index: 0,
          document_title: 'Interrupt Descriptor Table - OSDev Wiki',
          start_char_index: 10,
          end_char_index: 64,
          file_id: null,
        },
      ],
    },
    { type: 'text', text: '\n- ', citations: null },
    {
      type: 'text',
      text: 'An IDT entry is 16 bytes in long mode',
      citations: [
        {
          type: 'web_search_result_location',
          cited_text: 'In 64-bit mode each entry is 16 bytes',
          url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table',
          title: 'Interrupt Descriptor Table - OSDev Wiki',
          encrypted_index: 'abc',
        },
      ],
    },
  ],
};

describe('tool definitions', () => {
  it('maps the specs onto web_search_20260318 and web_fetch_20260318', () => {
    expect(buildServerTools([SEARCH, FETCH])).toEqual([
      { type: 'web_search_20260318', name: 'web_search', max_uses: 3, allowed_domains: ['wiki.osdev.org'] },
      {
        type: 'web_fetch_20260318',
        name: 'web_fetch',
        max_uses: 4,
        allowed_domains: ['wiki.osdev.org'],
        max_content_tokens: 8_000,
        citations: { enabled: true },
      },
    ]);
  });

  it('passes a blocked list when the call has no allowlist (the general profile)', () => {
    const [tool] = buildServerTools([{ kind: 'web_search', maxUses: 3, blockedDomains: ['medium.com'] }]);
    expect(tool).toEqual({ type: 'web_search_20260318', name: 'web_search', max_uses: 3, blocked_domains: ['medium.com'] });
  });

  it('refuses a tool with both lists, which the API rejects', () => {
    expect(() =>
      buildServerTools([{ kind: 'web_search', maxUses: 1, allowedDomains: ['a.org'], blockedDomains: ['b.org'] }]),
    ).toThrow(LLMBadRequestError);
  });

  it('sends the tools on the request', async () => {
    const { adapter, sent } = adapterReplaying([FINISHED]);
    await adapter.complete(request());
    expect(sent[0]!['tools']).toEqual(buildServerTools([SEARCH, FETCH]));
  });

  it('sends no tools field for an ordinary call', async () => {
    const { adapter, sent } = adapterReplaying([FINISHED]);
    await adapter.complete(request({ serverTools: undefined }));
    expect(sent[0]).not.toHaveProperty('tools');
  });
});

describe('pause_turn', () => {
  it('sends the paused turn back unchanged and joins both turns', async () => {
    const { adapter, sent } = adapterReplaying([PAUSED, FINISHED]);
    const response = await adapter.complete(request());

    expect(sent).toHaveLength(2);
    const continued = sent[1]!['messages'] as { role: string; content: unknown }[];
    expect(continued.slice(0, -1)).toEqual(sent[0]!['messages']);
    expect(continued.at(-1)).toEqual({ role: 'assistant', content: PAUSED.content });
    expect(sent[1]!['tools']).toEqual(sent[0]!['tools']);

    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toMatchObject({ inputTokens: 2_300, outputTokens: 340, webSearchRequests: 1, webFetchRequests: 1 });
  });

  it('stops after a bounded number of continuations', async () => {
    const { adapter, sent } = adapterReplaying([PAUSED]);
    const response = await adapter.complete(request());
    expect(sent.length).toBeLessThanOrEqual(4);
    expect(response.stopReason).toBe('other');
  });

  /*
   * maxTokens bounds the whole answer, so a stage's ceiling in PROJECT_MODELS
   * means what it says however many times the turn pauses (invariant 28).
   */
  it('spends one maxTokens budget across the paused turns', async () => {
    const { adapter, sent } = adapterReplaying([PAUSED, FINISHED]);
    await adapter.complete(request({ maxTokens: 4_000 }));
    expect(sent[0]!['max_tokens']).toBe(4_000);
    expect(sent[1]!['max_tokens']).toBe(4_000 - 40);
  });

  it('does not continue a turn that spent its maxTokens', async () => {
    const spent = { ...PAUSED, usage: usage(900, 4_000, 1, 0) };
    const { adapter, sent } = adapterReplaying([spent, FINISHED]);
    await adapter.complete(request({ maxTokens: 4_000 }));
    expect(sent).toHaveLength(1);
  });
});

describe('citations', () => {
  it('returns the text blocks with what each cites, and the documents read', async () => {
    const { adapter } = adapterReplaying([PAUSED, FINISHED]);
    const response = await adapter.complete(request());

    expect(response.text).toBe('# osdev-core\n## APIs\n- lidt | lidt m16&64\n- An IDT entry is 16 bytes in long mode');
    expect(response.segments).toEqual([
      { text: '# osdev-core\n## APIs\n- ', citations: [] },
      {
        text: 'lidt | lidt m16&64',
        citations: [
          {
            url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table',
            title: 'Interrupt Descriptor Table - OSDev Wiki',
            citedText: 'The IDT is loaded using the LIDT assembly instruction.',
          },
        ],
      },
      { text: '\n- ', citations: [] },
      {
        text: 'An IDT entry is 16 bytes in long mode',
        citations: [
          {
            url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table',
            title: 'Interrupt Descriptor Table - OSDev Wiki',
            citedText: 'In 64-bit mode each entry is 16 bytes',
          },
        ],
      },
    ]);
    expect(response.sources).toEqual([
      { url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table', title: 'Interrupt Descriptor Table - OSDev Wiki', retrievedAt: null, via: 'search' },
      { url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table', title: 'Interrupt Descriptor Table - OSDev Wiki', retrievedAt: '2026-10-23T12:00:00Z', via: 'fetch' },
    ]);
  });

  it('leaves segments and sources off an ordinary call', async () => {
    const { adapter } = adapterReplaying([
      { stop_reason: 'end_turn', usage: usage(10, 5), content: [{ type: 'text', text: 'hi', citations: null }] },
    ]);
    const response = await adapter.complete(request({ serverTools: undefined }));
    expect(response).not.toHaveProperty('segments');
    expect(response).not.toHaveProperty('sources');
  });
});

describe('searches counted and priced', () => {
  it('prices searches at $10 per 1,000 on top of tokens', () => {
    expect(WEB_SEARCH_USD_PER_SEARCH).toBe(0.01);
    const tokensOnly = computeCost('claude-sonnet-5-5', { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const searched = computeCost('claude-sonnet-5-5', {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 3,
      webFetchRequests: 4,
    });
    expect(searched.webSearchUSD).toBeCloseTo(0.03, 9);
    expect(searched.totalUSD! - tokensOnly.totalUSD!).toBeCloseTo(0.03, 9);
  });

  it('adds fetch counts with addUsage', () => {
    const a = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webFetchRequests: 2 };
    expect(addUsage(a, a).webFetchRequests).toBe(4);
  });
});

describe('the serverTools capability', () => {
  it('is claimed by current Claude entries and by no OpenAI-compatible one', () => {
    for (const model of listModels()) {
      const claude = model.vendor === 'anthropic';
      if (!claude) expect(model.capabilities.serverTools, model.id).toBe(false);
    }
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(getModel(id)!.capabilities.serverTools, id).toBe(true);
    }
  });

  it('fails a research stage at resolve time when it resolves to a model without server tools', () => {
    const env = { PROJECT_LEARNER: 'on', PROJECT_GEN_FALLBACK: 'chain', NODE_ENV: 'development', GEMINI_API_KEY: 'g' };
    expect(() => resolveProjectStage('research', 'T3', env)).toThrow(LLMConfigError);
    expect(() => resolveProjectStage('brief', 'T3', env)).not.toThrow();
  });

  it('is refused by the OpenAI-compatible adapter rather than silently dropped', async () => {
    const adapter = new OpenAICompatibleAdapter(getModel('gemini-3.6-flash')!, VENDORS['gemini']!, 'k');
    await expect(adapter.complete(request({ model: 'gemini-3.6-flash' }))).rejects.toThrow(LLMConfigError);
  });
});

describe('a recorded live research call (systems-os, phase 2)', () => {
  // Saved by `npm run test:research --workspace @ai-edu/api` with
  // RECORD_FIXTURES=1; page text and encrypted content removed.
  it('replays into one answer with every page the tools returned', async () => {
    const turns = (await import('./fixtures/research-live.turns.json')).default as Record<string, unknown>[];
    const { adapter, sent } = adapterReplaying(turns);
    const response = await adapter.complete(request());

    expect(sent).toHaveLength(turns.length);
    expect(response.stopReason).toBe('end_turn');
    expect(response.text).toMatch(/^[\s\S]*# osdev-core[\s\S]*$/);
    expect(response.segments!.map((s) => s.text).join('')).toBe(response.text);
    const fetched = response.sources!.filter((s) => s.via === 'fetch');
    expect(fetched.length).toBe(response.usage.webFetchRequests);
    for (const source of response.sources!) expect(source.url).toMatch(/^https:\/\/(wiki\.osdev\.org|en\.cppreference\.com|www\.en\.cppreference\.com)\//);
  });
});
