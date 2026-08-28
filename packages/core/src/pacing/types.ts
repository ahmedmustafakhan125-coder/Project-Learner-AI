import { z } from 'zod';

/**
 * The pacing contract.
 *
 * The scoring that produces a directive lands in P4; the shape lives here now
 * because Phase-B step expansion consumes it, and defining it up front keeps
 * expansion from having to change later.
 *
 * A directive may only ever affect steps that have NOT been generated yet.
 * Rewriting a step the learner has already seen would move the goalposts under
 * them mid-task.
 */

export const PacingAdjustment = z.enum([
  /** Struggling: break the work down further and scaffold more heavily. */
  'scaffold',
  /** Struggling badly: insert a smaller intermediate step before this one. */
  'insert_micro_step',
  /** On track: leave it exactly as the blueprint planned. */
  'hold',
  /** Cruising: less hand-holding, more to figure out. */
  'compress',
  /** Cruising well ahead: add optional depth beyond the original objective. */
  'stretch',
]);
export type PacingAdjustment = z.infer<typeof PacingAdjustment>;

export const PacingDirective = z.object({
  adjustment: PacingAdjustment,
  /** Plain-language reason, shown to the learner so pacing is not a black box. */
  reason: z.string(),
  /** Extra guidance injected into the expansion prompt. */
  notes: z.array(z.string()).default([]),
});
export type PacingDirective = z.infer<typeof PacingDirective>;

/**
 * Render a directive for the expansion prompt.
 *
 * Returns null for `hold` so the common case adds no bytes at all — and, more
 * importantly, so an on-track learner's prompt stays byte-identical to the
 * default and keeps hitting the cache.
 */
export function renderPacingDirective(directive: PacingDirective): string | null {
  if (directive.adjustment === 'hold') return null;

  const guidance: Record<Exclude<PacingAdjustment, 'hold'>, string> = {
    scaffold:
      'This learner is finding the project harder than expected. Break this step into smaller ' +
      'numbered sub-tasks, give more starter scaffolding, and leave a smaller gap for them to ' +
      'fill. Do not reduce what they learn — reduce how much they must hold in their head at once.',
    insert_micro_step:
      'This learner is stuck. Before the main work of this step, add a short warm-up exercise ' +
      'that practises the single hardest idea in isolation, then continue with the step as planned.',
    compress:
      'This learner is moving quickly and finding it easy. Tighten the instructions, assume more, ' +
      'and leave a larger gap for them to work out. Skip explanations of things they have ' +
      'clearly already understood.',
    stretch:
      'This learner is well ahead. Keep the core objective, then add one optional extension at ' +
      'the end that goes beyond it — clearly marked optional so skipping it breaks nothing.',
  };

  const lines = [
    '<pacing_directive>',
    guidance[directive.adjustment],
    ...directive.notes.map((note) => `- ${note}`),
    '</pacing_directive>',
  ];

  return lines.join('\n');
}

export const AttemptSummary = z.object({
  attempts: z.number().int().min(1),
  durationMs: z.number().int().nonnegative(),
  hintsUsed: z.number().int().nonnegative(),
  passed: z.boolean(),
});
export type AttemptSummary = z.infer<typeof AttemptSummary>;

export const PaceState = z.object({
  recentAttemptCounts: z.array(z.number()).default([]),
  recentDurations: z.array(z.number()).default([]),
  hintsUsedTotal: z.number().default(0),
  streakPassed: z.number().default(0),    // consecutive first-try passes
  streakFailed: z.number().default(0),    // consecutive multi-attempt steps
});
export type PaceState = z.infer<typeof PaceState>;
