/**
 * Project research in the API: tech cards first, the 30-day technology
 * dossier cache second, a live research call only for what is left
 * (docs/project-learner.md §7 and §11). The second project on the same stack
 * pays nothing for research.
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '@ai-edu/llm';
import { PROFILES, RESEARCH_SYSTEM } from '@ai-edu/core';
import type { CompiledQuery, ResearchDossier, Slots } from '@ai-edu/core';
import { describe, expect, it } from 'vitest';

import { DOSSIER_TTL_DAYS, memoryDossierCache, runProjectResearch } from '../src/research.js';

const NOW = new Date('2026-10-23T12:00:00Z');
const CLAUDE_ENV = { PROJECT_LEARNER: 'on', ANTHROPIC_API_KEY: 'sk-test', NODE_ENV: 'development' };

const slots = (values: Record<string, string>): Slots =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source: 'query' as const }]));

const compiled = (text: string, values: Record<string, string>): CompiledQuery => ({
  intent: 'project_generation',
  originalQuery: text,
  text: `<learner_question>\n${text}\n</learner_question>`,
  slots: slots(values),
  attachments: [],
  partial: false,
});

const KERNEL = compiled('I want to build an operating system', { domain: 'operating system' });

/** What a research call on the kernel's uncarded keys answers. */
const ANSWER: Pick<LLMResponse, 'text' | 'segments' | 'sources'> = {
  text: '',
  segments: [
    { text: '# c\n## Notes\n- ', citations: [] },
    { text: 'Freestanding C has no hosted library', citations: [{ url: 'https://en.cppreference.com/w/c/language', title: 'C language', citedText: 'freestanding' }] },
    { text: '\n# osdev-core\n## APIs\n- ', citations: [] },
    { text: 'lidt | lidt m16&64', citations: [{ url: 'https://wiki.osdev.org/Interrupt_Descriptor_Table', title: 'IDT', citedText: 'LIDT' }] },
    { text: '\n- ', citations: [] },
    { text: 'outb | outb(port, value)', citations: [{ url: 'https://wiki.osdev.org/Serial_Ports', title: 'Serial Ports', citedText: 'COM1 is at 0x3F8' }] },
  ],
  sources: [],
};

function recordingProvider(answer = ANSWER) {
  const requests: LLMRequest[] = [];
  const provider = {
    id: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    capabilities: { serverTools: true },
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push(req);
      return {
        ...answer,
        stopReason: 'end_turn',
        model: 'claude-sonnet-5-5',
        usage: { inputTokens: 24_000, outputTokens: 1_800, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 3, webFetchRequests: 3 },
      };
    },
  } as unknown as LLMProvider;
  return { provider, requests };
}

const run = (overrides: Partial<Parameters<typeof runProjectResearch>[0]> = {}) => {
  const { provider, requests } = recordingProvider();
  const cache = overrides.cache ?? memoryDossierCache();
  return {
    requests,
    cache,
    result: runProjectResearch({
      compiled: KERNEL,
      profile: PROFILES['systems-os'],
      tier: 'T5',
      slots: KERNEL.slots,
      now: NOW,
      env: CLAUDE_ENV,
      providerFor: () => provider,
      cache,
      ...overrides,
    }),
  };
};

describe('runProjectResearch', () => {
  it('covers carded keys from cards and researches only the rest, once', async () => {
    const { result, requests } = run();
    const research = await result;

    expect(research.fromCards.sort()).toEqual(['limine', 'qemu', 'x86-64-cross']);
    expect(research.researched).toEqual(['c', 'osdev-core']);
    expect(research.fromCache).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system![0]!.text).toBe(RESEARCH_SYSTEM);
    expect(research.usage.webSearchRequests).toBe(3);
    expect(research.model).toBe('claude-sonnet-5-5');
    expect(research.limitedSources).toBe(false);
    // Cards and research merged: one reference per page.
    expect(research.dossier.docRefs.length).toBe(6);
  });

  it('hits the cache on the second run and makes no call and no search', async () => {
    const cache = memoryDossierCache();
    await run({ cache }).result;
    const { result, requests } = run({ cache });
    const second = await result;

    expect(requests).toHaveLength(0);
    expect(second.fromCache).toEqual(['c', 'osdev-core']);
    expect(second.researched).toEqual([]);
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(second.dossier.docRefs.length).toBe(6);
  });

  it('caches each key for 30 days, keyed by technology and pin', async () => {
    const cache = memoryDossierCache();
    await run({ cache }).result;
    expect(DOSSIER_TTL_DAYS).toBe(30);
    const later = new Date(NOW.getTime() + 31 * 24 * 3600 * 1000);
    expect((await cache.read([{ key: 'c', pin: '' }], later)).size).toBe(0);
    expect((await cache.read([{ key: 'c', pin: '' }], NOW)).size).toBe(1);
    expect((await cache.read([{ key: 'c', pin: '9' }], NOW)).size).toBe(0);
  });

  it('never researches T1', async () => {
    const { result, requests } = run({ tier: 'T1' });
    const research = await result;
    expect(requests).toHaveLength(0);
    expect(research.limitedSources).toBe(true);
    expect(research.uncovered.length).toBeGreaterThan(0);
  });

  it('marks sources limited, without a call, when no model with server tools is configured', async () => {
    const env = { PROJECT_LEARNER: 'on', PROJECT_GEN_FALLBACK: 'chain', NODE_ENV: 'development', GEMINI_API_KEY: 'g' };
    const { result, requests } = run({ env });
    const research = await result;
    expect(requests).toHaveLength(0);
    expect(research.limitedSources).toBe(true);
    expect(research.uncovered.sort()).toEqual(['c', 'osdev-core']);
    // Cards still ground what they cover.
    expect(research.dossier.docRefs.length).toBe(3);
  });

  it('does not cache what the general profile finds, which is about one project', async () => {
    const cache = memoryDossierCache();
    const general = compiled('An audio DSP library', { domain: 'audio DSP library' });
    const answer = {
      text: '',
      segments: [
        { text: '# general-domain\n## Notes\n- ', citations: [] },
        { text: 'DSP filters are tested with known signals', citations: [{ url: 'https://dsp.example.org/filters', title: 'Filters', citedText: 'x' }] },
      ],
      sources: [],
    };
    const { provider, requests } = recordingProvider(answer);
    const research = await runProjectResearch({
      compiled: general,
      profile: PROFILES.general,
      tier: 'T3',
      slots: general.slots,
      now: NOW,
      env: CLAUDE_ENV,
      providerFor: () => provider,
      cache,
    });
    expect(requests).toHaveLength(1);
    expect(research.dossier.docRefs.every((r) => !r.vetted)).toBe(true);
    expect((await cache.read([{ key: 'general-domain', pin: '' }], NOW)).size).toBe(0);
  });

  it('keeps a failed key out of the cache and marks sources limited', async () => {
    const cache = memoryDossierCache();
    const offList = {
      ...ANSWER,
      segments: ANSWER.segments!.map((s) => ({
        ...s,
        citations: s.citations.map((c) => (c.url.includes('cppreference') ? { ...c, url: 'https://blog.example/c' } : c)),
      })),
    };
    const { provider } = recordingProvider(offList);
    const research = await runProjectResearch({
      compiled: KERNEL,
      profile: PROFILES['systems-os'],
      tier: 'T5',
      slots: KERNEL.slots,
      now: NOW,
      env: CLAUDE_ENV,
      providerFor: () => provider,
      cache,
    });
    expect(research.failed).toEqual(['c']);
    expect(research.limitedSources).toBe(true);
    const cached = await cache.read([{ key: 'c', pin: '' }, { key: 'osdev-core', pin: '' }], NOW);
    expect([...cached.keys()]).toEqual(['osdev-core']);
    const dossier: ResearchDossier = research.dossier;
    expect(dossier.docRefs.some((r) => r.url.includes('blog.example'))).toBe(false);
  });
});
