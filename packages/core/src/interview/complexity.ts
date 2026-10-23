import { PROJECT_TIERS } from '@ai-edu/llm';
import type { ProjectTier } from '@ai-edu/llm';
import { z } from 'zod';

import { PROFILES } from '../profiles/index.js';
import type { Profile, ProfileId } from '../profiles/types.js';
import type { Slots, SufficiencyScore } from '../schemas/interview.js';
import { SLOT_CATALOG, SUFFICIENCY_THRESHOLD } from './slots.js';
import type { SlotDef } from './slots.js';

/**
 * Scoping by profile and complexity (docs/project-learner.md §5).
 *
 * The classify call extracts `signals` under the same rule as slots — only
 * what the message states, absent when unknown — and the pure functions here
 * turn them into decisions: which profile, which tier, how many questions.
 * The model never picks a tier; it only reports what the learner said.
 */

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

export const ScopeSignals = z.object({
  /** Words naming the kind of software: kernel, interpreter, platformer, tray. */
  domainWords: z.array(z.string()).default([]),
  /** Interfaces named: cli, web, desktop, mobile, api. */
  interfaces: z.array(z.string()).default([]),
  persistence: z.enum(['none', 'files', 'embedded-db', 'server-db']).optional(),
  accounts: z.boolean().optional(),
  multiUser: z.boolean().optional(),
  realtime: z.boolean().optional(),
  backgroundJobs: z.boolean().optional(),
  payments: z.boolean().optional(),
  externalApis: z.boolean().optional(),
  /** They want to be taught deployment, not just handed it. */
  deployment: z.boolean().optional(),
  bareMetal: z.boolean().optional(),
  gpu: z.boolean().optional(),
  nativeBuild: z.boolean().optional(),
  targetArch: z.string().optional(),
});
export type ScopeSignals = z.infer<typeof ScopeSignals>;

/* ------------------------------------------------------------------ *
 * Text matching
 * ------------------------------------------------------------------ */

/** Lowercase words, so `chip-8` and `CHIP 8` compare equal and `os` never matches `positions`. */
function words(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/\.+$/, ''))
    .filter(Boolean)
    .join(' ');
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = words(phrase);
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `);
}

function slotText(slots: Slots, keys: string[]): string {
  return keys.map((k) => slots[k]?.value ?? '').join(' ');
}

/** Slots that say what the software is; the learner's goal and constraints say why and how. */
const WHAT_SLOTS = ['domain'];
const HOW_SLOTS = ['tech', 'goal', 'constraints'];

/** The `signal:<name>` tags a tier floor can name. */
function signalTags(signals: ScopeSignals): Set<string> {
  const tags = new Set<string>();
  if (signals.persistence && signals.persistence !== 'none') tags.add('signal:persistence');
  for (const key of ['accounts', 'multiUser', 'realtime', 'backgroundJobs', 'payments', 'externalApis', 'deployment', 'bareMetal', 'gpu', 'nativeBuild'] as const) {
    if (signals[key]) tags.add(`signal:${key}`);
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

/** Below this, the interview spends one question on "Which is closest?". */
export const PROFILE_CONFIDENCE_FLOOR = 0.6;

const INTERFACE_PROFILES: Record<string, ProfileId[]> = {
  cli: ['cli-tool'],
  desktop: ['desktop-app'],
  mobile: ['mobile-app'],
  web: ['web-frontend', 'web-fullstack'],
  api: ['api-backend'],
};

export interface ProfileDetection {
  profile: ProfileId;
  /** 0 when nothing matched; below PROFILE_CONFIDENCE_FLOOR, ask. */
  confidence: number;
  /** The runners-up worth offering as chips, best first. */
  alternatives: ProfileId[];
}

/**
 * Which kind of software this is.
 *
 * A profile's signal words count 3 when they name what is being built (the
 * domain words and the domain slot) and 2 when they appear only in the tech,
 * goal or constraints; a named interface or a low-level signal adds 1.
 * Confidence is the winner's share against the runner-up, so one weak match
 * and two equal ones both fall below the floor.
 */
export function detectProfile(signals: ScopeSignals, slots: Slots): ProfileDetection {
  const what = words([...signals.domainWords, slotText(slots, WHAT_SLOTS)].join(' '));
  const how = words(slotText(slots, HOW_SLOTS));

  const scores = new Map<ProfileId, number>();
  const add = (id: ProfileId, points: number) => scores.set(id, (scores.get(id) ?? 0) + points);

  for (const profile of Object.values(PROFILES)) {
    for (const word of new Set(profile.signalWords)) {
      if (containsPhrase(what, word)) add(profile.id, 3);
      else if (containsPhrase(how, word)) add(profile.id, 2);
    }
  }
  for (const iface of new Set(signals.interfaces.map((i) => i.toLowerCase().trim()))) {
    for (const id of INTERFACE_PROFILES[iface] ?? []) add(id, 1);
  }
  if (signals.bareMetal) {
    add('systems-os', 1);
    add('embedded', 1);
  }
  if (signals.gpu) {
    add('graphics', 1);
    add('game', 1);
  }

  // Ties break by catalogue order, so the same input always gives the same answer.
  const order = Object.keys(PROFILES) as ProfileId[];
  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));

  const [best, second] = ranked;
  if (!best) return { profile: 'general', confidence: 0, alternatives: [] };

  const confidence = best[1] / (best[1] + (second?.[1] ?? 0) + 1);
  return {
    profile: best[0],
    confidence: Math.round(confidence * 1000) / 1000,
    alternatives: ranked.slice(1, 4).map(([id]) => id),
  };
}

/* ------------------------------------------------------------------ *
 * Tier
 * ------------------------------------------------------------------ */

/** The least points for each tier, from §5: 0-1, 2-4, 5-8, 9-12, 13+. */
const CUT_POINTS: [ProjectTier, number][] = [
  ['T5', 13],
  ['T4', 9],
  ['T3', 5],
  ['T2', 2],
  ['T1', 0],
];

/** Most hours each tier fits (§5 time caps: a few, ~10, ~25, ~60). */
const TIME_CAPS: [ProjectTier, number][] = [
  ['T1', 5],
  ['T2', 12],
  ['T3', 30],
  ['T4', 70],
];

const rank = (tier: ProjectTier) => PROJECT_TIERS.indexOf(tier);
const maxTier = (a: ProjectTier, b: ProjectTier) => (rank(a) >= rank(b) ? a : b);

export interface ComplexityScore {
  tier: ProjectTier;
  /** Shown on the tier chip: every point, the floor and the time cap that moved it. */
  reasons: string[];
  points: number;
  /** The profile floor that applied, if it raised the tier. */
  floor: ProjectTier | null;
  /** The tier the learner's time allows, when they said. */
  timeCap: ProjectTier | null;
  /**
   * The floor is above what the time allows. Nothing is cut silently: the
   * plan says so and offers the first milestone as a project on its own.
   */
  overTime: boolean;
}

/**
 * How big the project is.
 *
 * Points from what the learner said, then the profile floor (a kernel is never
 * a weekend script), then the time they have. Time can pull the tier down to
 * the floor but never below it; when the floor itself does not fit, the tier
 * stays and `overTime` says so.
 */
export function scoreComplexity(signals: ScopeSignals, profile: Profile, slots: Slots): ComplexityScore {
  const reasons: string[] = [];
  let points = 0;
  const award = (n: number, label: string) => {
    if (n <= 0) return;
    points += n;
    reasons.push(`${label} +${n}`);
  };

  const interfaces = new Set(signals.interfaces.map((i) => i.toLowerCase().trim()).filter(Boolean));
  const extra = Math.max(0, interfaces.size - 1);
  award(extra, extra > 1 ? 'extra interfaces' : 'extra interface');
  if (signals.persistence === 'files') award(1, 'saved files');
  if (signals.persistence === 'embedded-db') award(1, 'embedded database');
  if (signals.persistence === 'server-db') award(2, 'server database');
  if (signals.accounts) award(2, 'accounts');
  if (signals.realtime) award(2, 'realtime');
  if (signals.backgroundJobs) award(2, 'background jobs');
  if (signals.payments) award(2, 'payments');
  if (signals.externalApis) award(1, 'external APIs');
  if (signals.deployment) award(1, 'deployment taught');
  if (signals.bareMetal) award(4, 'bare metal');
  if (signals.gpu) award(2, 'GPU');
  if (signals.nativeBuild) award(1, 'native build');

  const fromPoints = CUT_POINTS.find(([, least]) => points >= least)![0];
  let tier = fromPoints;

  // The highest floor whose keywords match what the learner said.
  const text = words(
    [...signals.domainWords, slotText(slots, [...WHAT_SLOTS, ...HOW_SLOTS]), ...profile.slots.map((s) => slots[s.key]?.value ?? '')].join(' '),
  );
  const tags = signalTags(signals);
  let floor: ProjectTier | null = null;
  let floorGoal = '';
  for (const f of profile.tierFloors) {
    const applies =
      f.keywords.length === 0 ||
      f.keywords.some((k) => (k.startsWith('signal:') ? tags.has(k) : containsPhrase(text, k)));
    if (applies && (floor === null || rank(f.tier) > rank(floor))) {
      floor = f.tier;
      floorGoal = f.goal;
    }
  }
  if (floor && rank(floor) > rank(tier)) {
    reasons.push(`Profile floor: ${floorGoal} is at least ${floor}`);
    tier = floor;
  } else {
    floor = null;
  }

  const hours = parseTimeBudget(slots['time_budget']?.value ?? '');
  const timeCap = hours === null ? null : (TIME_CAPS.find(([, most]) => hours <= most)?.[0] ?? 'T5');
  let overTime = false;
  if (timeCap && rank(tier) > rank(timeCap)) {
    const capped = floor ? maxTier(timeCap, floor) : timeCap;
    overTime = floor !== null && rank(floor) > rank(timeCap);
    reasons.push(
      overTime
        ? `Time: about ${hours} hours fits ${timeCap}, below what this needs; milestone 1 is offered as a project on its own`
        : `Time: about ${hours} hours caps at ${timeCap}`,
    );
    tier = capped;
  }

  return { tier, reasons, points, floor, timeCap, overTime };
}

/**
 * Hours from the learner's own words, or null when they did not say.
 * A day of hobby work counts 6 hours, a week 10 and a weekend 16.
 */
export function parseTimeBudget(text: string): number | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  if (/\b(few|couple of) hours\b|\ban? (afternoon|evening)\b/.test(t)) return 4;
  if (/\bweekend\b/.test(t)) return 16;

  const match = /(\d+(?:\.\d+)?)\s*\+?\s*(hours?|hrs?|h|days?|weeks?|months?)\b/.exec(t);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!;
  if (unit.startsWith('d')) return n * 6;
  if (unit.startsWith('w')) return n * 10;
  if (unit.startsWith('m')) return n * 40;
  return n;
}

/* ------------------------------------------------------------------ *
 * Question budget
 * ------------------------------------------------------------------ */

export interface InterviewBudget {
  rounds: number;
  questionsPerRound: number;
  /** Sufficiency below this asks. */
  threshold: number;
}

/**
 * Rounds, questions per round and the sufficiency threshold per tier (§5).
 * The global caps (MAX_QUESTIONS, MAX_ROUNDS) still hold above this.
 */
export const INTERVIEW_BUDGET: Record<ProjectTier, InterviewBudget> = {
  T1: { rounds: 1, questionsPerRound: 3, threshold: SUFFICIENCY_THRESHOLD },
  T2: { rounds: 1, questionsPerRound: 5, threshold: 0.8 },
  T3: { rounds: 2, questionsPerRound: 5, threshold: 0.85 },
  T4: { rounds: 2, questionsPerRound: 5, threshold: 0.9 },
  T5: { rounds: 2, questionsPerRound: 5, threshold: 0.9 },
};

const atOrBelow = (slot: SlotDef, tier: ProjectTier) => rank(slot.minTier ?? 'T1') <= rank(tier);

/**
 * What a project at this tier and profile must know: the base slots, the tier
 * slots up to this tier, then the profile's own, in that order. A profile slot
 * never replaces a catalogue slot of the same key.
 */
export function scopedSlots(tier: ProjectTier, profile: Profile): SlotDef[] {
  const out: SlotDef[] = [];
  const seen = new Set<string>();
  for (const slot of [...SLOT_CATALOG.project_generation, ...profile.slots]) {
    if (seen.has(slot.key) || !atOrBelow(slot, tier)) continue;
    seen.add(slot.key);
    out.push(slot);
  }
  return out;
}

/** `scoreSufficiency`, over the scoped slots, against the tier's threshold. */
export function scoreScopedSufficiency(slots: Slots, tier: ProjectTier, profile: Profile): SufficiencyScore {
  const required = scopedSlots(tier, profile).filter((s) => s.required);
  const total = required.reduce((sum, s) => sum + s.weight, 0);
  if (total === 0) return { score: 1, missing: [], needsInterview: false };

  let filled = 0;
  const missing: string[] = [];
  for (const def of required) {
    if (slots[def.key]?.value?.trim()) filled += def.weight;
    else missing.push(def.key);
  }
  const score = filled / total;
  return { score, missing, needsInterview: score < INTERVIEW_BUDGET[tier].threshold };
}

export interface QuestionSlotsInput {
  tier: ProjectTier;
  profile: Profile;
  slots: Slots;
  /** 0 for the first round. */
  round: number;
  /** Slots already put to the learner; never asked twice. */
  askedSlots: string[];
}

/**
 * The slots handed to the question generator this round (invariant 18).
 *
 * Nothing once the tier's rounds are spent or its threshold is met. Otherwise
 * the missing slots, required before optional and heaviest first, cut to the
 * tier's questions per round — so profile slots compete for the same budget
 * and a T1 game still gets at most three questions.
 */
export function questionSlots(input: QuestionSlotsInput): SlotDef[] {
  const { tier, profile, slots, round, askedSlots } = input;
  const budget = INTERVIEW_BUDGET[tier];
  if (round >= budget.rounds) return [];
  if (!scoreScopedSufficiency(slots, tier, profile).needsInterview) return [];

  const asked = new Set(askedSlots);
  const candidates = scopedSlots(tier, profile).filter(
    (s) => !asked.has(s.key) && !slots[s.key]?.value?.trim(),
  );
  const order = new Map(candidates.map((s, i) => [s.key, i]));
  candidates.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      b.weight - a.weight ||
      (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
  );
  return candidates.slice(0, budget.questionsPerRound);
}
