import { z } from 'zod';

/**
 * A fully expanded tutorial step (Phase B).
 *
 * The shape mirrors what the product promises for every step: instructions, code
 * the learner writes THEMSELVES, an explanation of the approach used, and the
 * alternative tools with their tradeoffs.
 */

export const SourceFile = z.object({
  path: z.string(),
  contents: z.string(),
});
export type SourceFile = z.infer<typeof SourceFile>;

/* ------------------------------------------------------------------ *
 * Checkpoint
 * ------------------------------------------------------------------ */

export const CheckpointTest = z.object({
  name: z.string(),
  /**
   * A self-contained assertion evaluated in the sandbox against the learner's
   * code. Must be deterministic — a flaky test that blocks progress is worse
   * than no test.
   */
  code: z.string(),
  /** Shown when it fails. Must say what was wrong, not just "incorrect". */
  failureMessage: z.string(),
});
export type CheckpointTest = z.infer<typeof CheckpointTest>;

export const Checkpoint = z.object({
  /** Cheapest layer: files that must exist before anything is run. */
  requiredFiles: z.array(z.string()).default([]),
  /** Still cheap: identifiers that must appear. Catches empty submissions. */
  requiredSymbols: z.array(z.string()).default([]),
  /** Deterministic pass/fail. Run only after the static layers pass. */
  tests: z.array(CheckpointTest).default([]),
  /** Which runtime executes this step's code. */
  runtime: z.enum(['web', 'python', 'none']).default('web'),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/* ------------------------------------------------------------------ *
 * Alternatives
 * ------------------------------------------------------------------ */

/**
 * The "alternative tools with tradeoffs" the product promises.
 *
 * Requiring both pros AND cons is deliberate: a list of options with only
 * upsides teaches nothing about choosing between them, which is the actual
 * skill being taught here.
 */
export const Alternative = z.object({
  name: z.string(),
  /** The thing from this step it would replace. */
  insteadOf: z.string(),
  pros: z.array(z.string()).min(1),
  cons: z.array(z.string()).min(1),
  /** The concrete situation where you would reach for this instead. */
  whenToUse: z.string(),
});
export type Alternative = z.infer<typeof Alternative>;

/* ------------------------------------------------------------------ *
 * Hints
 * ------------------------------------------------------------------ */

/**
 * Tiered so a stuck learner gets help without being handed the answer.
 * Unlocked by attempt count and elapsed time, never all at once.
 */
export const Hint = z.object({
  tier: z.number().int().min(1).max(3),
  text: z.string(),
});
export type Hint = z.infer<typeof Hint>;

/* ------------------------------------------------------------------ *
 * Expanded step
 * ------------------------------------------------------------------ */

export const ExpandedStep = z.object({
  /** What to do. Markdown. Should not contain the finished solution. */
  instructionsMd: z.string(),
  /**
   * Scaffolding the learner does NOT have to write: boilerplate, imports,
   * markup. The part that teaches the concept is left blank with a TODO.
   */
  starterFiles: z.array(SourceFile).default([]),
  /** Reference solution. Never sent to the browser before the step passes. */
  solutionFiles: z.array(SourceFile).default([]),
  checkpoint: Checkpoint,
  /** Why this approach — shown AFTER the learner has written the code. */
  explanationMd: z.string(),
  alternatives: z.array(Alternative).default([]),
  hints: z.array(Hint).default([]),
});
export type ExpandedStep = z.infer<typeof ExpandedStep>;

/** A step as stored, combining its stub with its expansion when present. */
export const ProjectStep = z.object({
  id: z.string(),
  projectId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  title: z.string(),
  objective: z.string().nullable().default(null),
  concepts: z.array(z.string()).default([]),
  estMinutes: z.number().int().nullable().default(null),
  /** Null until Phase B has run for this step. */
  expansion: ExpandedStep.nullable().default(null),
  expandedAt: z.string().nullable().default(null),
});
export type ProjectStep = z.infer<typeof ProjectStep>;
