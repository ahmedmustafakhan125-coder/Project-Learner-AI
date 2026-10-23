import { PROJECT_TIERS } from '@ai-edu/llm';
import { describe, expect, it } from 'vitest';

import {
  INTERVIEW_BUDGET,
  PROFILE_CONFIDENCE_FLOOR,
  ScopeSignals,
  detectProfile,
  parseTimeBudget,
  questionSlots,
  scopedSlots,
  scoreComplexity,
  scoreScopedSufficiency,
} from '../src/interview/complexity.js';
import { SUFFICIENCY_THRESHOLD, slotsFor } from '../src/interview/slots.js';
import { PROFILES } from '../src/profiles/index.js';
import { PROFILE_IDS } from '../src/profiles/types.js';
import { MAX_QUESTIONS, MAX_ROUNDS } from '../src/schemas/interview.js';
import type { Slots } from '../src/schemas/interview.js';
import { SCOPING_GOLDENS } from './fixtures/scoping-goldens.js';

const asSlots = (values: Record<string, string>): Slots =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source: 'query' as const }]));

/* ------------------------------------------------------------------ *
 * complexity.goldens
 * ------------------------------------------------------------------ */

describe('scoring goldens (§14 complexity.goldens)', () => {
  it('has at least 30 requests', () => {
    expect(SCOPING_GOLDENS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(SCOPING_GOLDENS.map((g) => [g.request, g] as const))('%s', (_request, golden) => {
    const signals = ScopeSignals.parse(golden.signals);
    const slots = asSlots(golden.slots);

    const detected = detectProfile(signals, slots);
    expect(detected.profile).toBe(golden.profile);
    if (golden.profile !== 'general') {
      expect(detected.confidence).toBeGreaterThanOrEqual(PROFILE_CONFIDENCE_FLOOR);
    }

    const scored = scoreComplexity(signals, PROFILES[golden.profile], slots);
    expect(scored.tier).toBe(golden.tier);
    expect(scored.overTime).toBe(golden.overTime ?? false);
    for (const reason of golden.reasons ?? []) {
      expect(scored.reasons.join('\n')).toContain(reason);
    }
  });
});

describe('detectProfile', () => {
  it('falls back to general with no confidence when nothing matches', () => {
    const result = detectProfile(ScopeSignals.parse({}), asSlots({ domain: 'something cool' }));
    expect(result).toMatchObject({ profile: 'general', confidence: 0 });
  });

  it('is unsure, below the floor, when two profiles match equally', () => {
    const result = detectProfile(
      ScopeSignals.parse({ domainWords: ['game', 'interpreter'] }),
      asSlots({}),
    );
    expect(result.confidence).toBeLessThan(PROFILE_CONFIDENCE_FLOOR);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('matches whole words only', () => {
    // "positions" contains "os"; "games" is not "game".
    const result = detectProfile(ScopeSignals.parse({ domainWords: ['positions tracker'] }), asSlots({}));
    expect(result.profile).toBe('general');
  });
});

describe('scoreComplexity', () => {
  it('uses the §5 points and cut points', () => {
    const profile = PROFILES.general;
    const tierFor = (signals: Partial<ScopeSignals>) =>
      scoreComplexity(ScopeSignals.parse(signals), profile, {}).tier;
    expect(tierFor({})).toBe('T1');
    expect(tierFor({ externalApis: true })).toBe('T1'); // 1
    expect(tierFor({ accounts: true })).toBe('T2'); // 2
    expect(tierFor({ accounts: true, realtime: true, externalApis: true })).toBe('T3'); // 5
    expect(tierFor({ bareMetal: true, gpu: true, accounts: true, nativeBuild: true })).toBe('T4'); // 9
    expect(tierFor({ bareMetal: true, gpu: true, accounts: true, realtime: true, payments: true, nativeBuild: true })).toBe('T5'); // 13
  });

  it('never goes below a profile floor, and says why', () => {
    const scored = scoreComplexity(ScopeSignals.parse({}), PROFILES['systems-os'], {});
    expect(scored.tier).toBe('T4');
    expect(scored.reasons.join('\n')).toMatch(/at least T4/);
  });

  it('caps the tier at what the time allows when no floor is in the way', () => {
    const signals = ScopeSignals.parse({ persistence: 'server-db', accounts: true, realtime: true });
    const scored = scoreComplexity(signals, PROFILES.general, asSlots({ time_budget: 'a few hours' }));
    expect(scored.tier).toBe('T1');
    expect(scored.overTime).toBe(false);
    expect(scored.reasons.join('\n')).toMatch(/caps at T1/);
  });

  it('keeps the floor and flags it when the floor is above the time', () => {
    const scored = scoreComplexity(ScopeSignals.parse({}), PROFILES['systems-os'], asSlots({ time_budget: 'a few hours' }));
    expect(scored.tier).toBe('T4');
    expect(scored.overTime).toBe(true);
  });
});

describe('parseTimeBudget', () => {
  it.each([
    ['A few hours', 4],
    ['~10 hours', 10],
    ['about 25 hours', 25],
    ['40+ hours', 40],
    ['a weekend', 16],
    ['2 weeks', 20],
    ['3 days', 18],
    ['no idea', null],
  ])('%s is %s hours', (text, hours) => {
    expect(parseTimeBudget(text)).toBe(hours);
  });
});

/* ------------------------------------------------------------------ *
 * interview.budget — invariant 18
 * ------------------------------------------------------------------ */

describe('INTERVIEW_BUDGET (§5)', () => {
  it('holds the §5 rows, with SUFFICIENCY_THRESHOLD as the T1 row', () => {
    expect(INTERVIEW_BUDGET).toEqual({
      T1: { rounds: 1, questionsPerRound: 3, threshold: SUFFICIENCY_THRESHOLD },
      T2: { rounds: 1, questionsPerRound: 5, threshold: 0.8 },
      T3: { rounds: 2, questionsPerRound: 5, threshold: 0.85 },
      T4: { rounds: 2, questionsPerRound: 5, threshold: 0.9 },
      T5: { rounds: 2, questionsPerRound: 5, threshold: 0.9 },
    });
    expect(SUFFICIENCY_THRESHOLD).toBe(0.75);
  });

  it('never exceeds the global caps', () => {
    for (const tier of PROJECT_TIERS) {
      expect(INTERVIEW_BUDGET[tier].questionsPerRound).toBeLessThanOrEqual(MAX_QUESTIONS);
      expect(INTERVIEW_BUDGET[tier].rounds).toBeLessThanOrEqual(MAX_ROUNDS);
    }
  });
});

describe('invariant 18: tier and profile set the question budget in code', () => {
  const cases = PROFILE_IDS.flatMap((id) => PROJECT_TIERS.map((tier) => [id, tier] as const));

  it.each(cases)('%s at %s never hands the generator more slots than the budget', (id, tier) => {
    const profile = PROFILES[id];
    const budget = INTERVIEW_BUDGET[tier];

    // An empty request: everything is missing, the worst case for the cap.
    const first = questionSlots({ tier, profile, slots: {}, round: 0, askedSlots: [] });
    expect(first.length).toBeLessThanOrEqual(budget.questionsPerRound);
    expect(first.length).toBeGreaterThan(0);

    // Ranked by weight, heaviest first.
    const weights = first.map((s) => s.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);

    // Round 2 exists only where the tier allows it, and never repeats a slot.
    const second = questionSlots({
      tier,
      profile,
      slots: {},
      round: 1,
      askedSlots: first.map((s) => s.key),
    });
    if (budget.rounds < 2) expect(second).toEqual([]);
    expect(second.length).toBeLessThanOrEqual(budget.questionsPerRound);
    for (const slot of second) expect(first.map((s) => s.key)).not.toContain(slot.key);

    expect(questionSlots({ tier, profile, slots: {}, round: budget.rounds, askedSlots: [] })).toEqual([]);
  });

  it('gives a T1 game at most three questions', () => {
    expect(questionSlots({ tier: 'T1', profile: PROFILES.game, slots: {}, round: 0, askedSlots: [] }).length).toBeLessThanOrEqual(3);
  });

  it('asks nothing once the tier threshold is met', () => {
    const slots = asSlots({
      domain: 'Lox interpreter',
      tech: 'Python',
      skill_level: 'intermediate',
      time_budget: '10 hours',
      interface: 'command line',
      data: 'nothing',
      source_language: 'Lox',
      impl_language: 'Python',
    });
    const profile = PROFILES['language-tooling'];
    expect(scoreScopedSufficiency(slots, 'T2', profile).needsInterview).toBe(false);
    expect(questionSlots({ tier: 'T2', profile, slots, round: 0, askedSlots: [] })).toEqual([]);
  });

  it('adds tier slots by tier and profile slots by their own tier', () => {
    const keys = (tier: (typeof PROJECT_TIERS)[number]) =>
      scopedSlots(tier, PROFILES['desktop-app']).map((s) => s.key);
    expect(keys('T1')).not.toContain('interface');
    expect(keys('T2')).toContain('interface');
    expect(keys('T2')).not.toContain('users_auth');
    expect(keys('T3')).toContain('users_auth');
    expect(keys('T4')).toContain('testing_depth');
    expect(keys('T1')).toContain('target_os');
    expect(keys('T1')).not.toContain('distribution');
    expect(keys('T3')).toContain('distribution');
  });
});

describe('PROJECT_LEARNER off: the base interview is unchanged', () => {
  it('slotsFor still returns only the six original project slots', () => {
    expect(slotsFor('project_generation').map((s) => s.key)).toEqual([
      'domain',
      'tech',
      'skill_level',
      'time_budget',
      'goal',
      'constraints',
    ]);
  });
});
