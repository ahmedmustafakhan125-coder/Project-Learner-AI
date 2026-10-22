import type { BrainNode } from '../brain/types.js';
import { VIVA_PASS } from './schemas.js';

/**
 * When to offer a test, when a retake opens, and when to suggest a break.
 *
 * The offer is a suggestion, never homework. It fires only for a concept the
 * learner has engaged with enough to be worth testing, not tested recently,
 * and not turned down twice already — and the brain's "Test me" button works
 * regardless of any of this. Agency is not a reward for compliance.
 */

export const OFFER_RULES = {
  /** Mastery at which a concept has been engaged with enough to test. */
  minScore: 0.6,
  /** Don't offer again within this many days of the last assessment. */
  cooldownDays: 7,
  /** After this many "not now"s, stop offering this concept. */
  maxDismissals: 2,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** After a failed multiple-choice gate, the gate reopens this much later. */
export const MCQ_RETRY_MS = 24 * HOUR_MS;

/**
 * After a viva below the pass mark: 24 hours, doubling with each attempt, at
 * most a week. Long enough to go and learn something; short enough to return
 * while it is fresh.
 */
export function retakeCooldownMs(attemptNumber: number): number {
  const attempt = Math.max(1, Math.floor(attemptNumber));
  return Math.min(7 * DAY_MS, 24 * HOUR_MS * 2 ** (attempt - 1));
}

/** The fourth sitting on one concept earns a gentle "try something else first?". A signal, not a block. */
export function isStuck(attemptNumber: number): boolean {
  return attemptNumber >= 4;
}

export function vivaPassed(score: number): boolean {
  return score >= VIVA_PASS;
}

function timeOf(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Should the "want to test yourself?" prompt fire for this concept?
 *
 *   - mastery at or above `minScore`;
 *   - never assessed, or not within `cooldownDays`;
 *   - the latest evidence was not a failed checkpoint — that is a moment to
 *     keep learning, not to sit a test;
 *   - dismissed fewer than `maxDismissals` times;
 *   - no retake cooldown still running.
 */
export function shouldOfferAssessment(concept: BrainNode, now: string): boolean {
  if (concept.kind !== 'concept') return false;
  const at = Date.parse(now);
  const meta = concept.metadata;

  if ((concept.score ?? 0) < OFFER_RULES.minScore) return false;
  if (typeof meta['offerDismissals'] === 'number' && meta['offerDismissals'] >= OFFER_RULES.maxDismissals) return false;
  if (meta['lastEvidence'] === 'checkpoint_fail') return false;

  const assessed = timeOf(meta['lastAssessedAt']);
  if (assessed !== null && at - assessed < OFFER_RULES.cooldownDays * DAY_MS) return false;

  const retake = timeOf(meta['retakeAfter']);
  if (retake !== null && retake > at) return false;

  return true;
}

/** The concepts worth offering a test on right now, strongest first. */
export function assessmentOffers(nodes: readonly BrainNode[], now: string, limit = 3): BrainNode[] {
  return nodes
    .filter((node) => shouldOfferAssessment(node, now))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

/** A concept whose retake cooldown has run out after a viva below the pass mark. */
export function retakeReady(concept: BrainNode, now: string): boolean {
  if (concept.kind !== 'concept') return false;
  const latest = concept.metadata['latestScore'];
  if (typeof latest !== 'number' || vivaPassed(latest)) return false;
  const retake = timeOf(concept.metadata['retakeAfter']);
  return retake !== null && retake <= Date.parse(now);
}
