import {
  dossierFromCards,
  isFreshCard,
  mergeDossiers,
  parseStoredDossier,
  planResearch,
  researchCandidates,
  researchProject,
  versionPin,
} from '@ai-edu/core';
import type {
  CompiledQuery,
  DossierViolation,
  Profile,
  ResearchDossier,
  Slots,
  TechCard,
} from '@ai-edu/core';
import { LLMConfigError, createProvider, emptyUsage, resolveProjectStage } from '@ai-edu/llm';
import type { LLMProvider, LLMUsage, ProjectTier } from '@ai-edu/llm';
import type { SupabaseClient } from '@supabase/supabase-js';

import { db } from './db.js';
import { docSources, techCards } from './knowledge.js';

/**
 * Project research, as the intake route runs it (docs/project-learner.md §7).
 *
 * Cheapest first: fresh tech cards, then the shared technology cache, then
 * one live research call for whatever is left — and none for T1, or when no
 * model with server tools is configured. The cache is what makes the tenth
 * Tauri project of the week free.
 */

/** Technology dossiers live this long, matching the monthly pin refresh. */
export const DOSSIER_TTL_DAYS = 30;

export interface CacheKey {
  key: string;
  /** The card's pin, or '' when the key has none. */
  pin: string;
}

export interface DossierCache {
  read(keys: CacheKey[], now: Date): Promise<Map<string, ResearchDossier>>;
  write(entries: (CacheKey & { dossier: ResearchDossier })[], now: Date): Promise<void>;
}

const expiry = (now: Date) => new Date(now.getTime() + DOSSIER_TTL_DAYS * 24 * 60 * 60 * 1000);

/** `research_dossiers` (migration 0015). Shared across learners; only the API reads or writes it. */
export function supabaseDossierCache(client: () => SupabaseClient = db): DossierCache {
  return {
    async read(keys, now) {
      const found = new Map<string, ResearchDossier>();
      if (keys.length === 0) return found;
      const { data, error } = await client()
        .from('research_dossiers')
        .select('tech, version_pin, dossier')
        .in('tech', keys.map((k) => k.key))
        .gt('expires_at', now.toISOString());
      if (error) {
        // A cache that cannot be read costs a research call, not the request.
        console.warn(`[research] dossier cache read failed: ${error.message}`);
        return found;
      }
      for (const row of data ?? []) {
        const wanted = keys.find((k) => k.key === row.tech && k.pin === row.version_pin);
        const dossier = wanted ? parseStoredDossier(row.dossier) : null;
        if (wanted && dossier) found.set(wanted.key, dossier);
      }
      return found;
    },
    async write(entries, now) {
      if (entries.length === 0) return;
      const rows = entries.map((e) => ({
        tech: e.key,
        version_pin: e.pin,
        dossier: e.dossier,
        created_at: now.toISOString(),
        expires_at: expiry(now).toISOString(),
      }));
      const { error } = await client().from('research_dossiers').upsert(rows, { onConflict: 'tech,version_pin' });
      if (error) console.warn(`[research] dossier cache write failed: ${error.message}`);
    },
  };
}

/** The same contract in memory, for tests and for running without a database. */
export function memoryDossierCache(): DossierCache {
  const rows = new Map<string, { dossier: ResearchDossier; expiresAt: number }>();
  const id = (k: CacheKey) => `${k.key}\u0000${k.pin}`;
  return {
    async read(keys, now) {
      const found = new Map<string, ResearchDossier>();
      for (const k of keys) {
        const row = rows.get(id(k));
        if (row && row.expiresAt > now.getTime()) found.set(k.key, row.dossier);
      }
      return found;
    },
    async write(entries, now) {
      for (const e of entries) rows.set(id(e), { dossier: e.dossier, expiresAt: expiry(now).getTime() });
    },
  };
}

export interface RunResearchInput {
  compiled: CompiledQuery;
  profile: Profile;
  tier: ProjectTier;
  slots: Slots;
  now?: Date;
  cache?: DossierCache;
  cards?: TechCard[];
  env?: NodeJS.ProcessEnv;
  /** Test seam: the provider for the resolved research model. */
  providerFor?: (modelId: string) => LLMProvider;
}

export interface ResearchRun {
  /** Cards, cached and new research merged: what the brief is written against. */
  dossier: ResearchDossier;
  /** True when a candidate was left ungrounded (T1, no server tools, a failed key) or nothing was read at all. */
  limitedSources: boolean;
  fromCards: string[];
  fromCache: string[];
  researched: string[];
  failed: string[];
  uncovered: string[];
  violations: DossierViolation[];
  /** For `recordUsage` under `project:research`. Zero when no call ran. */
  usage: LLMUsage;
  /** The model that researched, or null when nothing was researched. */
  model: string | null;
}

export async function runProjectResearch(input: RunResearchInput): Promise<ResearchRun> {
  const {
    compiled,
    profile,
    tier,
    slots,
    now = new Date(),
    cache = supabaseDossierCache(),
    cards = techCards(),
    env = process.env,
    providerFor = (modelId) => createProvider(modelId, { env }),
  } = input;

  const candidates = researchCandidates({ profile, tier, slots, cards });
  // What the general profile finds is about one project, not a technology.
  const cacheable = profile.id !== 'general';
  const uncarded = candidates.filter((c) => {
    const card = cards.find((k) => k.id === c.key);
    return !(card && isFreshCard(card, now));
  });
  const cached = cacheable
    ? await cache.read(uncarded.map((c) => ({ key: c.key, pin: versionPin(c.key, cards) })), now)
    : new Map<string, ResearchDossier>();

  // Research needs Claude's server tools. Without them it fails here, before a
  // request, and the brief is written from cards and the cache instead.
  let stage: ReturnType<typeof resolveProjectStage> | null = null;
  if (tier !== 'T1') {
    try {
      stage = resolveProjectStage('research', tier, env);
    } catch (err) {
      if (!(err instanceof LLMConfigError)) throw err;
      console.warn(`[research] skipped: ${err.message}`);
    }
  }

  const plan = planResearch({ candidates, cards, cachedKeys: new Set(cached.keys()), tier, now, canResearch: stage !== null });

  let usage = emptyUsage();
  let model: string | null = null;
  let researchedDossier: ResearchDossier | null = null;
  const failed: string[] = [];
  const violations: DossierViolation[] = [];

  if (plan.toResearch.length && stage) {
    const result = await researchProject({
      provider: providerFor(stage.model.id),
      compiled,
      profile,
      candidates: plan.toResearch,
      registry: docSources(),
      reasoning: stage.reasoning,
      maxTokens: stage.maxTokens,
      now,
    });
    usage = result.usage;
    model = stage.model.id;
    researchedDossier = result.data.dossier;
    failed.push(...result.data.failed);
    violations.push(...result.data.violations);
    if (cacheable) {
      await cache.write(
        result.data.slices.map((s) => ({ key: s.key, pin: versionPin(s.key, cards), dossier: s.dossier })),
        now,
      );
    }
  }

  const cardDossier = dossierFromCards(
    plan.fromCards.map((c) => cards.find((k) => k.id === c.key)).filter((k): k is TechCard => k !== undefined),
  );
  const dossier = mergeDossiers([
    cardDossier,
    ...plan.fromCache.map((c) => cached.get(c.key)!),
    ...(researchedDossier ? [researchedDossier] : []),
  ]);

  const uncovered = plan.uncovered.map((c) => c.key);
  return {
    dossier,
    // A dossier with no reference is limited however it came about, including
    // a profile whose layers name nothing to research and a stack left open.
    limitedSources: uncovered.length > 0 || failed.length > 0 || dossier.docRefs.length === 0,
    fromCards: plan.fromCards.map((c) => c.key),
    fromCache: plan.fromCache.map((c) => c.key),
    researched: plan.toResearch.map((c) => c.key).filter((k) => !failed.includes(k)),
    failed,
    uncovered,
    violations,
    usage,
    model,
  };
}
