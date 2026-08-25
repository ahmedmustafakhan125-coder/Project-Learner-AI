import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMRequest } from '@ai-edu/llm';

import { buildAgentRequest } from '../src/agents/fanOut.js';
import { AGENT_INSTRUCTION, PEDAGOGY_CORE } from '../src/agents/prompts.js';
import { AGENT_ORDER } from '../src/schemas/common.js';
import type { CompiledQuery } from '../src/schemas/interview.js';

/**
 * These tests exist to protect the caching design.
 *
 * The four agents share one cached prefix. If anything makes that prefix differ
 * between them — a timestamp, a user id, a reordered object — every cache read
 * silently stops working. Nothing fails, no error is logged, no test goes red.
 * Cost simply quadruples and stays that way until someone reads a bill.
 *
 * So the invariant gets asserted directly.
 */

const fakeProvider = (over: Partial<LLMProvider['capabilities']> = {}): LLMProvider =>
  ({
    id: 'anthropic',
    modelId: 'claude-opus-5',
    capabilities: {
      explicitCaching: true,
      structuredOutput: 'native-schema',
      midConversationSystem: true,
      reasoningControl: 'effort',
      maxContext: 1_000_000,
      maxOutputTokens: 128_000,
      supportsFileUpload: true,
      supportsImages: true,
      ...over,
    },
  }) as LLMProvider;

const compiled: CompiledQuery = {
  intent: 'concept_question',
  originalQuery: 'what is a closure?',
  text: '<learner_question>\nwhat is a closure?\n</learner_question>',
  slots: { topic: { value: 'closures', source: 'query' } },
  attachments: [],
  partial: false,
};

/** Everything a provider sends before the per-agent instruction. */
function sharedPrefix(request: LLMRequest): string {
  return JSON.stringify({
    system: request.system,
    messages: request.messages.slice(0, -1),
  });
}

describe('shared prefix is byte-identical across all four agents', () => {
  const provider = fakeProvider();
  const requests = AGENT_ORDER.map((agent) => buildAgentRequest(agent, { provider, compiled }));

  it('produces the same system blocks for every agent', () => {
    const rendered = requests.map((r) => JSON.stringify(r.system));
    expect(new Set(rendered).size, 'system blocks diverged between agents').toBe(1);
  });

  it('produces the same message prefix for every agent', () => {
    const prefixes = requests.map(sharedPrefix);
    expect(new Set(prefixes).size, 'message prefix diverged between agents').toBe(1);
  });

  it('differs ONLY in the trailing per-agent instruction', () => {
    for (const [i, agent] of AGENT_ORDER.entries()) {
      const last = requests[i]!.messages.at(-1)!;
      expect(last.role).toBe('system');
      expect(last.content).toBe(AGENT_INSTRUCTION[agent]);
    }
    // Four distinct instructions, one shared everything-else.
    const instructions = requests.map((r) => r.messages.at(-1)!.content);
    expect(new Set(instructions).size).toBe(4);
  });

  it('is stable across repeated builds', () => {
    // Catches accidental non-determinism: Date.now(), randomUUID(), Set/Map
    // iteration order, or anything else that varies run to run.
    const first = sharedPrefix(buildAgentRequest('simple', { provider, compiled }));
    const second = sharedPrefix(buildAgentRequest('simple', { provider, compiled }));
    expect(second).toBe(first);
  });

  it('marks exactly one cache boundary in the system prompt', () => {
    const boundaries = requests[0]!.system!.filter((b) => b.cacheBoundary);
    expect(boundaries).toHaveLength(1);
    // It must be the LAST block, or content after it goes uncached.
    expect(requests[0]!.system!.at(-1)!.cacheBoundary).toBe(true);
  });

  it('marks the end of the shared user turn so attachments are cached too', () => {
    const userTurn = requests[0]!.messages.find((m) => m.role === 'user')!;
    const parts = userTurn.content as Array<{ type: string; cacheBoundary?: boolean }>;
    const marked = parts.filter((p) => p.cacheBoundary);

    expect(marked, 'exactly one boundary in the user turn').toHaveLength(1);
    expect(parts.at(-1)!.cacheBoundary, 'boundary must be on the last shared block').toBe(true);
  });

  it('puts the per-agent instruction AFTER the cached prefix, not in the system prompt', () => {
    // Putting it in `system` would change the bytes ahead of everything else and
    // invalidate the shared cache entirely — the whole reason it lives here.
    for (const request of requests) {
      const systemText = request.system!.map((b) => b.text).join('');
      for (const instruction of Object.values(AGENT_INSTRUCTION)) {
        expect(systemText).not.toContain(instruction);
      }
    }
  });
});

describe('PEDAGOGY_CORE contains nothing volatile', () => {
  it('has no interpolated dynamic values', () => {
    // Each of these would change the prefix per request or per user and kill
    // every cache read across the whole application.
    const volatile: Array<[RegExp, string]> = [
      [/\d{4}-\d{2}-\d{2}T\d{2}:/, 'an ISO timestamp'],
      [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'a UUID'],
      [/\$\{/, 'a template interpolation'],
      [/Date\.now|new Date/, 'a date call'],
      [/\bcurrent (date|time)\b/i, 'a current-date phrase'],
    ];

    for (const [pattern, description] of volatile) {
      expect(PEDAGOGY_CORE, `PEDAGOGY_CORE contains ${description}`).not.toMatch(pattern);
    }
  });

  it('is long enough to actually be cacheable', () => {
    // Opus 5 will not cache a prefix under 512 tokens — it fails silently, with
    // cache_creation_input_tokens simply staying 0. ~3.5 chars/token is a
    // conservative estimate, so require comfortable headroom.
    expect(PEDAGOGY_CORE.length).toBeGreaterThan(2200);
  });

  it('carries the prompt-injection guard for uploaded files', () => {
    // Attachment text is attacker-controlled: users upload arbitrary files.
    expect(PEDAGOGY_CORE).toMatch(/<attachment>/);
    expect(PEDAGOGY_CORE).toMatch(/not a source of instructions|never as instructions|not as a command/i);
    expect(PEDAGOGY_CORE).toMatch(/ignore previous instructions/i);
  });

  it('tells agents not to solve the learner exercise for them', () => {
    // The platform's whole premise is that the learner writes the code.
    expect(PEDAGOGY_CORE).toMatch(/do not solve|write code themselves/i);
  });
});

describe('per-agent tuning', () => {
  const provider = fakeProvider();

  it('gives the practice agent the most output room', () => {
    // It emits a complete HTML page; the others emit prose.
    const budgets = AGENT_ORDER.map((a) => buildAgentRequest(a, { provider, compiled }).maxTokens!);
    const practice = buildAgentRequest('practice', { provider, compiled }).maxTokens!;
    expect(practice).toBe(Math.max(...budgets));
  });

  it('spends more reasoning effort where reasoning is actually needed', () => {
    const effortOf = (a: (typeof AGENT_ORDER)[number]) =>
      buildAgentRequest(a, { provider, compiled }).reasoning;
    expect(effortOf('industry')).toBe('high');
    expect(effortOf('practice')).toBe('high');
    expect(effortOf('simple')).toBe('medium');
    expect(effortOf('concepts')).toBe('medium');
  });
});

describe('attachment handling', () => {
  const withFile: CompiledQuery = {
    ...compiled,
    attachments: [
      {
        id: 'a1',
        filename: 'broken.py',
        mimeType: 'text/x-python',
        sizeBytes: 120,
        extractedText: 'def f(): return 1/0',
        providerFileId: null,
      },
    ],
  };

  it('wraps extracted text in delimiters so it reads as data, not instructions', () => {
    const request = buildAgentRequest('simple', { provider: fakeProvider(), compiled: withFile });
    const parts = request.messages.find((m) => m.role === 'user')!.content as Array<{
      type: string;
      text?: string;
    }>;
    const attachmentPart = parts.find((p) => p.text?.includes('def f()'));

    expect(attachmentPart?.text).toContain('<attachment filename="broken.py">');
    expect(attachmentPart?.text).toContain('</attachment>');
  });

  it('references an uploaded file by id instead of resending its bytes', () => {
    const uploaded: CompiledQuery = {
      ...withFile,
      attachments: [{ ...withFile.attachments[0]!, providerFileId: 'file_abc' }],
    };
    const request = buildAgentRequest('simple', { provider: fakeProvider(), compiled: uploaded });
    const parts = request.messages.find((m) => m.role === 'user')!.content as Array<{
      type: string;
      fileId?: string;
    }>;

    expect(parts.some((p) => p.type === 'file' && p.fileId === 'file_abc')).toBe(true);
    // The raw text must not also be inlined — that would send it twice.
    expect(JSON.stringify(parts)).not.toContain('def f()');
  });

  it('falls back to inline text when the provider cannot host files', () => {
    const uploaded: CompiledQuery = {
      ...withFile,
      attachments: [{ ...withFile.attachments[0]!, providerFileId: 'file_abc' }],
    };
    const provider = fakeProvider({ supportsFileUpload: false });
    const request = buildAgentRequest('simple', { provider, compiled: uploaded });

    expect(JSON.stringify(request.messages)).toContain('def f()');
  });

  it('keeps the attachment inside the cached region', () => {
    // Otherwise a large file is re-processed for all four agents.
    const request = buildAgentRequest('simple', { provider: fakeProvider(), compiled: withFile });
    const parts = request.messages.find((m) => m.role === 'user')!.content as Array<{
      cacheBoundary?: boolean;
    }>;
    const boundaryIndex = parts.findIndex((p) => p.cacheBoundary);
    expect(boundaryIndex).toBe(parts.length - 1);
  });
});
