/**
 * Three live Stack Briefs (docs/project-learner.md §15, phase 2 "done when"):
 * the kernel, the Lox interpreter and the Tauri app, each written by Claude
 * against its real dossier and passed by `verifyStackBrief`.
 *
 * Opt-in, because it calls Claude (about $0.05 to $0.10 a brief on §11's
 * figures, more when a brief needs its retry):
 *
 *   npm run test:research --workspace @ai-edu/api -- brief.live
 *
 * Run research.live first so the kernel's dossier comes from the cache. With
 * RECORD_FIXTURES=1 each brief and its dossier are saved to
 * packages/core/test/fixtures/briefs/ for review and for the hermetic check.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILES, buildPinTable, generateBrief, verifyStackBrief } from '@ai-edu/core';
import type { CompiledQuery, ProfileId, Slots } from '@ai-edu/core';
import { computeCost, createProviderForStage } from '@ai-edu/llm';
import type { ProjectTier } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import { techCards } from '../src/knowledge.js';
import { memoryDossierCache, runProjectResearch, supabaseDossierCache } from '../src/research.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
const localDb = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(process.env['SUPABASE_URL'] ?? '');
const env = { ...process.env, PROJECT_LEARNER: 'on' };

interface Golden {
  name: string;
  request: string;
  profile: ProfileId;
  tier: ProjectTier;
  slots: Record<string, string>;
}

const GOLDENS: Golden[] = [
  { name: 'kernel', request: 'I want to build an operating system', profile: 'systems-os', tier: 'T5', slots: { domain: 'operating system' } },
  {
    name: 'lox',
    request: 'A Lox interpreter in Python',
    profile: 'language-tooling',
    tier: 'T2',
    slots: { domain: 'Lox interpreter', tech: 'Python', source_language: 'Lox', impl_language: 'Python' },
  },
  { name: 'tauri', request: 'A Tauri notes app', profile: 'desktop-app', tier: 'T3', slots: { domain: 'notes app', tech: 'Tauri' } },
];

function compiledFor(g: Golden): { compiled: CompiledQuery; slots: Slots } {
  const slots: Slots = Object.fromEntries(Object.entries(g.slots).map(([k, v]) => [k, { value: v, source: 'query' as const }]));
  const context = Object.entries(g.slots).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return {
    slots,
    compiled: {
      intent: 'project_generation',
      originalQuery: g.request,
      text: `<learner_question>\n${g.request}\n</learner_question>\n\n<context>\n${context}\n</context>`,
      slots,
      attachments: [],
      partial: false,
    },
  };
}

describe.skipIf(!hasKey)('live Stack Briefs', () => {
  const cache = localDb ? supabaseDossierCache() : memoryDossierCache();
  const cards = techCards();
  const pins = buildPinTable(cards);

  it.each(GOLDENS.map((g) => [g.name, g] as const))('%s passes verifyStackBrief', async (_name, golden) => {
    const profile = PROFILES[golden.profile];
    const { compiled, slots } = compiledFor(golden);

    const research = await runProjectResearch({ compiled, profile, tier: golden.tier, slots, cache, env });
    const stage = createProviderForStage('brief', golden.tier, { env });
    const result = await generateBrief({
      provider: stage.provider,
      compiled,
      profile,
      tier: golden.tier,
      slots,
      dossier: research.dossier,
      limitedSources: research.limitedSources,
      cards,
      pins,
      reasoning: stage.reasoning,
      maxTokens: stage.maxTokens,
    });

    const { brief, attempts, repaired } = result.data;
    const cost = computeCost(stage.provider.modelId, result.usage);
    console.log(
      `[live] ${golden.name}: ${brief.layers.length} layers, attempt ${attempts}, ${repaired.length} repaired, ` +
        `research ${research.researched.length ? 'live' : research.fromCache.length ? 'cached' : 'cards only'}, ` +
        `usage ${JSON.stringify(result.usage)}, cost $${cost.totalUSD?.toFixed(4)}`,
    );
    for (const r of repaired) console.log(`[live]   repaired ${r.rule}: ${r.message}`);
    for (const l of brief.layers) {
      console.log(`[live]   ${l.layer}: ${l.name}${l.versionMajor ? ` ${l.versionMajor}` : ''} [${l.verification}] refs ${l.docRefs.join(',')}`);
    }

    if (process.env['RECORD_FIXTURES'] === '1') {
      const file = resolve(ROOT, `packages/core/test/fixtures/briefs/${golden.name}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify(
          { recordedAt: new Date().toISOString(), golden, limitedSources: research.limitedSources, dossier: research.dossier, brief, attempts, repaired, usage: result.usage },
          null,
          2,
        ) + '\n',
      );
    }

    // Already checked inside generateBrief; checked again here as the done-when.
    const again = verifyStackBrief(
      { ...brief, layers: brief.layers.map(({ requestedByLearner: _r, verification: _v, cardId: _c, ...rest }) => rest) },
      { profile, tier: golden.tier, slots, dossier: research.dossier, pins, cards },
    );
    expect(again.violations.filter((v) => v.severity === 'serious')).toEqual([]);
    expect(brief.layers.map((l) => l.layer)).toEqual(expect.arrayContaining(profile.requiredLayersByTier[golden.tier]));
  });
});
