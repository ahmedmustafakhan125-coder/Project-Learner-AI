/**
 * Mastery: how well a learner holds a concept, as a number in [0, 1], plus how
 * much evidence that number rests on.
 *
 * Every rule is an exponential moving average toward a target that the
 * evidence implies: a passed checkpoint pulls toward 1, a failed one toward
 * 0.2, an answered question toward 0.75 — asking about something is engagement,
 * not proof. A viva score pulls toward the fraction of marks earned and is
 * weighted heaviest, because it is the only evidence that was graded.
 *
 * The viva rule is the one fixed by the specification:
 *
 *   score      = 0.7 · old + 0.3 · (viva / 25)
 *   confidence = min(1, old + 0.15 / attempt)
 *
 * The others are tuning, kept here as named constants so they can be changed
 * in one place and the tests say what they are.
 */

export interface Mastery {
  score: number;
  confidence: number;
}

/** A concept the learner has never touched. */
export const NO_MASTERY: Mastery = { score: 0, confidence: 0 };

interface Rule {
  /** Where the evidence pulls the score. */
  target: number;
  /** How far it pulls, per piece of evidence. */
  rate: number;
  /** Confidence added per piece of evidence. */
  confidenceGain: number;
}

export const MASTERY_RULES = {
  questionAnswered: { target: 0.75, rate: 0.15, confidenceGain: 0.05 },
  checkpointPassed: { target: 1.0, rate: 0.25, confidenceGain: 0.1 },
  checkpointFailed: { target: 0.2, rate: 0.1, confidenceGain: 0.05 },
} as const satisfies Record<string, Rule>;

export const VIVA_MAX_MARKS = 25;
const VIVA_RATE = 0.3;
const VIVA_CONFIDENCE_GAIN = 0.15;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function apply(prev: Mastery, rule: Rule): Mastery {
  return {
    score: clamp01(prev.score + rule.rate * (rule.target - prev.score)),
    confidence: clamp01(prev.confidence + rule.confidenceGain),
  };
}

export function afterQuestion(prev: Mastery): Mastery {
  return apply(prev, MASTERY_RULES.questionAnswered);
}

export function afterCheckpoint(prev: Mastery, passed: boolean): Mastery {
  return apply(prev, passed ? MASTERY_RULES.checkpointPassed : MASTERY_RULES.checkpointFailed);
}

/**
 * After a graded viva. `attemptNumber` is 1 for the first sitting; later
 * sittings add less confidence, because a retake shortly after a fail is
 * weaker evidence of durable understanding than a first-time pass.
 */
export function afterViva(prev: Mastery, vivaScore: number, attemptNumber: number): Mastery {
  const fraction = clamp01(vivaScore / VIVA_MAX_MARKS);
  const attempt = Math.max(1, Math.floor(attemptNumber));
  return {
    score: clamp01((1 - VIVA_RATE) * prev.score + VIVA_RATE * fraction),
    confidence: clamp01(prev.confidence + VIVA_CONFIDENCE_GAIN / attempt),
  };
}

/** Stored at three decimals (numeric(4,3)), and rounded the same way every time. */
export function roundMastery(value: number): number {
  return Math.round(value * 1000) / 1000;
}
