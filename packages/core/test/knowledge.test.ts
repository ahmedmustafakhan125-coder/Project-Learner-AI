import { describe, expect, it } from 'vitest';

import { buildAgentRequest } from '../src/agents/fanOut.js';
import { renderKnowledge, selectConcepts } from '../src/knowledge/select.js';
import type { KnowledgeBundle } from '../src/knowledge/types.js';
import { AGENT_ORDER } from '../src/schemas/common.js';
import type { CompiledQuery } from '../src/schemas/interview.js';
import type { LLMProvider } from '@ai-edu/llm';

const bundle: KnowledgeBundle = {
  index: '# Knowledge\n- [Closures](/concepts/closures.md)',
  concepts: [
    {
      path: '/concepts/closures.md',
      type: 'Concept',
      title: 'Closures',
      description: 'A function keeps the scope it was defined in.',
      tags: ['javascript', 'closures', 'scope'],
      status: 'stable',
      body: 'A closure is a function bundled with its defining scope.',
    },
    {
      path: '/concepts/rls.md',
      type: 'Concept',
      title: 'Row Level Security',
      description: 'Authorisation in the database.',
      tags: ['postgres', 'rls', 'security'],
      status: 'stable',
      body: 'Permissive policies are ORed; restrictive ones are ANDed.',
    },
    {
      path: '/concepts/old.md',
      type: 'Concept',
      title: 'Superseded thing',
      description: 'Kept for its links.',
      tags: ['javascript', 'closures'],
      status: 'deprecated',
      body: 'Do not surface this.',
    },
  ],
};

function query(overrides: Partial<CompiledQuery> = {}): CompiledQuery {
  return {
    intent: 'concept_question',
    originalQuery: 'what is a closure?',
    text: '<learner_question>\nwhat is a closure?\n</learner_question>',
    slots: { tech: { value: 'JavaScript', source: 'query' } },
    attachments: [],
    partial: false,
    ...overrides,
  };
}

describe('selectConcepts', () => {
  it('picks concepts whose tags match the query', () => {
    const picked = selectConcepts(bundle, query());
    expect(picked.map((c) => c.path)).toContain('/concepts/closures.md');
  });

  it('never surfaces a deprecated concept, even on a tag match', () => {
    // `old.md` carries both matching tags; status is the only thing excluding it.
    const picked = selectConcepts(bundle, query());
    expect(picked.map((c) => c.path)).not.toContain('/concepts/old.md');
  });

  it('leaves out concepts with nothing to do with the question', () => {
    const picked = selectConcepts(bundle, query());
    expect(picked.map((c) => c.path)).not.toContain('/concepts/rls.md');
  });

  it('respects the cap', () => {
    expect(selectConcepts(bundle, query(), 1)).toHaveLength(1);
  });

  it('is deterministic across repeated calls', () => {
    const a = selectConcepts(bundle, query()).map((c) => c.path);
    const b = selectConcepts(bundle, query()).map((c) => c.path);
    expect(a).toEqual(b);
  });

  it('does not depend on the order slots were filled in', () => {
    // Object key order follows insertion order, so two queries that resolved the
    // same slots in a different sequence must still select the same concepts —
    // otherwise the rendered bytes differ and the shared cache entry is lost.
    const first = selectConcepts(
      bundle,
      query({
        slots: {
          tech: { value: 'JavaScript', source: 'query' },
          topic: { value: 'scope', source: 'answer' },
        },
      }),
    );
    const second = selectConcepts(
      bundle,
      query({
        slots: {
          topic: { value: 'scope', source: 'answer' },
          tech: { value: 'JavaScript', source: 'query' },
        },
      }),
    );
    expect(first.map((c) => c.path)).toEqual(second.map((c) => c.path));
  });
});

describe('renderKnowledge', () => {
  it('wraps concepts in <knowledge>, not <attachment>', () => {
    const text = renderKnowledge(bundle, query())!;
    expect(text).toContain('<knowledge>');
    // Attachments are untrusted learner uploads; this bundle is reviewed source.
    expect(text).not.toContain('<attachment');
  });

  it('always includes the index so the model can see what else exists', () => {
    expect(renderKnowledge(bundle, query())).toContain('<index>');
  });

  it('returns null when nothing matches, leaving the prompt untouched', () => {
    const unrelated = query({ originalQuery: 'how do I bake sourdough', slots: {} });
    expect(renderKnowledge(bundle, unrelated)).toBeNull();
  });

  it('is byte-identical across repeated renders', () => {
    expect(renderKnowledge(bundle, query())).toBe(renderKnowledge(bundle, query()));
  });
});

/* ------------------------------------------------------------------ *
 * Cache-prefix safety — the reason determinism is enforced above
 * ------------------------------------------------------------------ */

const provider = {
  id: 'anthropic',
  modelId: 'claude-opus-5',
  capabilities: { supportsFileUpload: false },
} as unknown as LLMProvider;

describe('knowledge injection and the shared cache prefix', () => {
  it('gives all four agents byte-identical knowledge', () => {
    const rendered = AGENT_ORDER.map((agent) =>
      JSON.stringify(
        buildAgentRequest(agent, { provider, compiled: query(), knowledge: bundle }).messages[0],
      ),
    );
    expect(new Set(rendered).size, 'knowledge diverged between agents').toBe(1);
  });

  it('keeps exactly one cache boundary, on the last shared block', () => {
    const request = buildAgentRequest('simple', {
      provider,
      compiled: query(),
      knowledge: bundle,
    });
    const parts = request.messages.find((m) => m.role === 'user')!.content as Array<{
      cacheBoundary?: boolean;
    }>;
    expect(parts.filter((p) => p.cacheBoundary)).toHaveLength(1);
    expect(parts.at(-1)!.cacheBoundary).toBe(true);
  });

  it('places knowledge before the question, inside the cached block', () => {
    const request = buildAgentRequest('simple', {
      provider,
      compiled: query(),
      knowledge: bundle,
    });
    const parts = request.messages.find((m) => m.role === 'user')!.content as Array<{
      text?: string;
    }>;
    expect(parts[0]!.text).toContain('<knowledge>');
    expect(parts.at(-1)!.text).toContain('<learner_question>');
  });

  it('changes nothing when no bundle is supplied', () => {
    const without = buildAgentRequest('simple', { provider, compiled: query() });
    const withEmpty = buildAgentRequest('simple', {
      provider,
      compiled: query(),
      knowledge: { index: null, concepts: [] },
    });
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without));
  });
});
