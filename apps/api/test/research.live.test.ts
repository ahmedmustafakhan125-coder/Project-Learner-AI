/**
 * Project research against the real Claude API and the local database
 * (docs/project-learner.md §15, phase 2 "done when").
 *
 * Opt-in, because it calls Claude with web search and costs money (about
 * $0.10 a run on §11's figures):
 *
 *   npm run test:research --workspace @ai-edu/api
 *
 * It reads keys from the repository's .env like the API does, and skips
 * itself without ANTHROPIC_API_KEY. The cache half needs the local database
 * (`npm run db:start`) with migration 0015; against any other SUPABASE_URL it
 * uses an in-memory cache so it never writes to a shared project.
 *
 * With RECORD_FIXTURES=1 it saves what it saw, with page text, encrypted
 * search content and any key removed, as the recorded responses the hermetic
 * adapter and dossier tests replay.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILES, isAllowedUrl, researchScope } from '@ai-edu/core';
import type { CompiledQuery } from '@ai-edu/core';
import { computeCost, createProvider } from '@ai-edu/llm';
import type { LLMProvider, LLMResponse } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { docSources, techCards } from '../src/knowledge.js';
import { db } from '../src/db.js';
import { memoryDossierCache, runProjectResearch, supabaseDossierCache } from '../src/research.js';
import type { DossierCache } from '../src/research.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
const localDb = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(process.env['SUPABASE_URL'] ?? '');
const env = { ...process.env, PROJECT_LEARNER: 'on' };

const KERNEL: CompiledQuery = {
  intent: 'project_generation',
  originalQuery: 'I want to build an operating system',
  text: '<learner_question>\nI want to build an operating system\n</learner_question>\n\n<context>\n- Area of interest: operating system\n</context>',
  slots: { domain: { value: 'operating system', source: 'query' } },
  attachments: [],
  partial: false,
};

/** Strip what a fixture must never hold: page text, encrypted blobs, keys. */
function sanitise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitise);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'encrypted_content' || k === 'encrypted_index' || k === 'encrypted_stdout') out[k] = 'redacted';
    else if (k === 'stdout' || k === 'stderr') out[k] = '[output removed]';
    else if (k === 'source' && v && typeof v === 'object' && 'data' in (v as object)) out[k] = { ...(v as object), data: '[page text removed]' };
    else if (/key|authorization/i.test(k)) continue;
    else out[k] = sanitise(v);
  }
  return out;
}

function recording(modelId: string) {
  const provider = createProvider(modelId, { env });
  const raw: unknown[] = [];
  const responses: LLMResponse[] = [];
  const client = (provider as unknown as { client: { messages: { create: (...a: unknown[]) => Promise<unknown> } } }).client;
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (...args: unknown[]) => {
    const message = await create(...args);
    raw.push(message);
    return message;
  };
  const wrapped: LLMProvider = Object.create(provider) as LLMProvider;
  wrapped.complete = async (req) => {
    const response = await provider.complete(req);
    responses.push(response);
    return response;
  };
  return { provider: wrapped, raw, responses };
}

describe.skipIf(!hasKey)('live systems-os research', () => {
  const cache: DossierCache = localDb ? supabaseDossierCache() : memoryDossierCache();
  const profile = PROFILES['systems-os'];

  it('researches the uncarded kernel keys, then serves them from the cache', async () => {
    if (localDb) {
      const { error } = await db().from('research_dossiers').delete().in('tech', ['c', 'osdev-core']);
      expect(error, 'research_dossiers is missing: apply migration 0015 locally').toBeNull();
    }
    console.log(`[live] cache: ${localDb ? 'local research_dossiers' : 'in memory (SUPABASE_URL is not local)'}`);

    let rec: ReturnType<typeof recording> | null = null;
    const first = await runProjectResearch({
      compiled: KERNEL,
      profile,
      tier: 'T5',
      slots: KERNEL.slots,
      cache,
      env,
      providerFor: (id) => (rec = recording(id)).provider,
    });

    const scope = researchScope(docSources(), profile, [...first.fromCards, ...first.researched, ...first.failed]);
    const cardUrls = new Set(techCards().map((c) => c.docs));
    const researchedRefs = first.dossier.docRefs.filter((r) => !cardUrls.has(r.url));
    const allowed = researchedRefs.filter((r) => isAllowedUrl(r.url, scope.allowedDomains!));
    const cost = first.model ? computeCost(first.model, first.usage) : null;

    console.log(`[live] researched ${first.researched.join(', ') || 'nothing'}; failed ${first.failed.join(', ') || 'none'}`);
    console.log(`[live] ${researchedRefs.length} researched references, ${allowed.length} allowlisted`);
    for (const ref of researchedRefs) console.log(`[live]   ${ref.id} ${ref.url}`);
    console.log(`[live] usage ${JSON.stringify(first.usage)}; cost $${cost?.totalUSD?.toFixed(4)}`);
    if (first.violations.length) console.log(`[live] violations ${JSON.stringify(first.violations)}`);

    if (process.env['RECORD_FIXTURES'] === '1' && rec) {
      const r = rec as ReturnType<typeof recording>;
      const llmFixture = resolve(ROOT, 'packages/llm/test/fixtures/research-live.turns.json');
      const coreFixture = resolve(ROOT, 'packages/core/test/fixtures/research-live.response.json');
      mkdirSync(dirname(llmFixture), { recursive: true });
      mkdirSync(dirname(coreFixture), { recursive: true });
      writeFileSync(llmFixture, JSON.stringify(sanitise(r.raw), null, 2) + '\n');
      const response = r.responses[0]!;
      writeFileSync(
        coreFixture,
        JSON.stringify(
          { recordedAt: new Date().toISOString(), keys: first.researched.concat(first.failed), text: response.text, segments: response.segments, sources: response.sources, usage: response.usage },
          null,
          2,
        ) + '\n',
      );
      console.log(`[live] fixtures written`);
    }

    expect(first.researched.length + first.failed.length).toBeGreaterThan(0);
    expect(allowed.length).toBeGreaterThanOrEqual(5);
    expect(researchedRefs.length - allowed.length, 'off-list references').toBe(0);

    let called = false;
    const second = await runProjectResearch({
      compiled: KERNEL,
      profile,
      tier: 'T5',
      slots: KERNEL.slots,
      cache,
      env,
      providerFor: () => {
        called = true;
        throw new Error('the second run must not research');
      },
    });
    console.log(`[live] second run: from cache ${second.fromCache.join(', ')}; searches ${second.usage.webSearchRequests ?? 0}`);
    expect(called).toBe(false);
    expect(second.fromCache.sort()).toEqual([...first.researched].sort());
    expect(second.usage.webSearchRequests ?? 0).toBe(0);
  });
});
