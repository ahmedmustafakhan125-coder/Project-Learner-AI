import type { ProjectTier } from '@ai-edu/llm';

import type { Profile } from '../profiles/types.js';
import type { Slots } from '../schemas/interview.js';
import { isFreshCard } from './sources.js';
import type { TechCard } from './sources.js';

/**
 * What the research pass would have to read, and how much of it is already
 * known (docs/project-learner.md §7, "Research only what is missing").
 *
 * Every required layer is grounded by one research key: a technology the
 * learner named, or the layer's default. A key with a fresh tech card or a
 * cached dossier costs nothing; only the rest is researched, and T1 never
 * researches at all.
 */

export interface ResearchCandidate {
  /** A tech card id (`tauri`) or a topic (`osdev-core`). Also the cache key. */
  key: string;
  /** The profile layers it grounds. */
  layers: string[];
  /** The learner named it. */
  requested: boolean;
}

/** Tech slot answers that ask for a recommendation rather than name a tool. */
const NO_PREFERENCE = /\b(recommend|suggest|not sure|no idea|don'?t know|whatever|any|you choose|up to you)\b/i;

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()} `;
}

/** "Rust, SQLite and Tauri" to ["Rust", "SQLite", "Tauri"]. */
export function namedTechnologies(slots: Slots, profile: Profile): string[] {
  const keys = ['tech', ...profile.slots.map((s) => s.key)];
  const phrases: string[] = [];
  for (const key of keys) {
    const value = slots[key]?.value?.trim();
    if (!value || NO_PREFERENCE.test(value)) continue;
    // " + " splits "Tauri + Rust"; a bare "+" would split "C++".
    for (const part of value.split(/,|\/|;|\s\+\s|\band\b|\bwith\b/i)) {
      const phrase = part.trim();
      if (phrase && phrase.split(/\s+/).length <= 3) phrases.push(phrase);
    }
  }
  return [...new Set(phrases)];
}

/** The card a learner's phrase names, by id, title or alias, whole words only. */
export function cardFor(phrase: string, cards: TechCard[]): TechCard | undefined {
  const text = normalise(phrase);
  return cards.find((card) =>
    [card.id, card.title, ...card.aliases].some((name) => {
      const n = normalise(name).trim();
      return n !== '' && text.includes(` ${n} `);
    }),
  );
}

export interface CandidateInput {
  profile: Profile;
  tier: ProjectTier;
  slots: Slots;
  cards: TechCard[];
}

export function researchCandidates({ profile, tier, slots, cards }: CandidateInput): ResearchCandidate[] {
  const required = profile.requiredLayersByTier[tier];
  const byKey = new Map<string, ResearchCandidate>();
  const covered = new Set<string>();

  for (const phrase of namedTechnologies(slots, profile)) {
    const card = cardFor(phrase, cards);
    // A named card claims the required layers it can fill. A technology with
    // no card is still researched: the learner asked for it.
    const key = card?.id ?? phrase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!key) continue;
    const layers = card ? required.filter((l) => card.layers.includes(l) && !covered.has(l)) : [];
    layers.forEach((l) => covered.add(l));
    const existing = byKey.get(key);
    if (existing) existing.layers.push(...layers);
    else byKey.set(key, { key, layers, requested: true });
  }

  for (const layerId of required) {
    if (covered.has(layerId)) continue;
    const key = profile.layers.find((l) => l.id === layerId)?.research;
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) existing.layers.push(layerId);
    else byKey.set(key, { key, layers: [layerId], requested: false });
  }

  return [...byKey.values()];
}

export interface ResearchPlan {
  /** Covered by a fresh tech card. */
  fromCards: ResearchCandidate[];
  /** Covered by a cached dossier. */
  fromCache: ResearchCandidate[];
  /** What the research call reads. Empty means no call runs. */
  toResearch: ResearchCandidate[];
  /** Left without grounding: the brief is marked "limited sources" for them. */
  uncovered: ResearchCandidate[];
}

export interface PlanInput {
  candidates: ResearchCandidate[];
  cards: TechCard[];
  /** Keys with an unexpired dossier in the cache. */
  cachedKeys: ReadonlySet<string>;
  tier: ProjectTier;
  now: Date;
  /** False when research cannot run (no server tools, or a learner over budget). */
  canResearch?: boolean;
}

export function planResearch(input: PlanInput): ResearchPlan {
  const { candidates, cards, cachedKeys, tier, now, canResearch = true } = input;
  const plan: ResearchPlan = { fromCards: [], fromCache: [], toResearch: [], uncovered: [] };
  for (const candidate of candidates) {
    const card = cards.find((c) => c.id === candidate.key);
    if (card && isFreshCard(card, now)) plan.fromCards.push(candidate);
    else if (cachedKeys.has(candidate.key)) plan.fromCache.push(candidate);
    else if (tier === 'T1' || !canResearch) plan.uncovered.push(candidate);
    else plan.toResearch.push(candidate);
  }
  return plan;
}

/** The pinned version a cached dossier for this key was researched against. */
export function versionPin(key: string, cards: TechCard[]): string {
  return cards.find((c) => c.id === key)?.pin ?? '';
}
