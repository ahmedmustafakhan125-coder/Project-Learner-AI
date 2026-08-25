import { z } from 'zod';
import { SkillLevel } from './common.js';

/**
 * Project generation schemas.
 *
 * Generation is split in two because doing it in one call is slow, expensive,
 * and forecloses adaptation:
 *
 *   Phase A — Blueprint: the plan plus step *stubs*. One call. Fast enough to
 *             show the learner something to approve before more is spent.
 *   Phase B — Expansion: one call per step, run lazily as the learner
 *             approaches it (see `step.ts`).
 *
 * The split is what makes adaptive pacing possible at all: later steps have not
 * been written yet, so a pacing directive can still change them. A fully
 * pre-generated project can only be followed, never adapted.
 */

export const TechChoice = z.object({
  name: z.string(),
  /** What this does in the project — "HTTP server", "state management". */
  role: z.string(),
  /** Why this one rather than the obvious alternatives. */
  why: z.string(),
});
export type TechChoice = z.infer<typeof TechChoice>;

export const StepStub = z.object({
  title: z.string(),
  /** One sentence: what the learner will have working when this step is done. */
  objective: z.string(),
  /** The ideas this step teaches. Drives the Q&A context for the step. */
  concepts: z.array(z.string()).default([]),
  estMinutes: z.number().int().positive(),
});
export type StepStub = z.infer<typeof StepStub>;

/** Deliberately bounded. A 30-step project reads as a course, not a project. */
export const MIN_STEPS = 3;
export const MAX_STEPS = 12;

export const ProjectBlueprint = z.object({
  title: z.string(),
  /** Two or three sentences a learner can decide from. */
  summary: z.string(),
  /** What they will be able to do afterwards that they cannot do now. */
  learningObjectives: z.array(z.string()).min(1),
  techStack: z.array(TechChoice).min(1),
  /** Things they must already know. Honest, not aspirational. */
  prerequisites: z.array(z.string()).default([]),
  estimatedHours: z.number().positive(),
  steps: z.array(StepStub).min(MIN_STEPS).max(MAX_STEPS),
});
export type ProjectBlueprint = z.infer<typeof ProjectBlueprint>;

/** A generated project as stored and rendered. */
export const Project = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable().default(null),
  areaOfInterest: z.string().nullable().default(null),
  techStack: z.array(TechChoice).default([]),
  skillLevel: SkillLevel,
  learningObjectives: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  estimatedHours: z.number().nullable().default(null),
  status: z.enum(['draft', 'generating', 'active', 'completed', 'abandoned']),
  stepCount: z.number().int().nonnegative().default(0),
  currentStepIndex: z.number().int().nonnegative().default(0),
});
export type Project = z.infer<typeof Project>;
