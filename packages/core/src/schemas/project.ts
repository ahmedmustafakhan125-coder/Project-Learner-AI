import { z } from 'zod';
import { SkillLevel } from './common.js';

/**
 * Project generation schemas.
 *
 * Generation is split in two because doing it in one call is slow, expensive,
 * and forecloses adaptation:
 *
 *   Phase A — Blueprint: the plan, the FILE PLAN, and step *stubs*. One call.
 *             Fast enough to show the learner something to approve before more
 *             is spent.
 *   Phase B — Expansion: one call per step, run lazily as the learner
 *             approaches it (see `step.ts`).
 *   Phase C — Finish: the README and deployment artifacts, generated once from
 *             the project the learner actually built (see `finish.ts`).
 *
 * The split is what makes adaptive pacing possible at all: later steps have not
 * been written yet, so a pacing directive can still change them. A fully
 * pre-generated project can only be followed, never adapted.
 *
 * What the split cost, until the file plan existed, was coherence. Each
 * expansion saw the blueprint and a list of earlier step TITLES — never the
 * code — so it invented its own starting point and the twelve steps added up
 * to twelve unrelated exercises rather than one project. `finalFileTree` plus
 * the per-step `creates`/`edits` manifest is the contract that fixes it: Phase
 * A decides the architecture once, and every Phase B call is held to it.
 */

export const TechChoice = z.object({
  name: z.string(),
  /** What this does in the project — "HTTP server", "state management". */
  role: z.string(),
  /** Why this one rather than the obvious alternatives. */
  why: z.string(),
});
export type TechChoice = z.infer<typeof TechChoice>;

/** One file in the finished project, and what it is for. */
export const PlannedFile = z.object({
  path: z.string(),
  /** What this file does in the finished project. */
  purpose: z.string(),
});
export type PlannedFile = z.infer<typeof PlannedFile>;

export const StepStub = z.object({
  title: z.string(),
  /** One sentence: what the learner will have working when this step is done. */
  objective: z.string(),
  /** The ideas this step teaches. Drives the Q&A context for the step. */
  concepts: z.array(z.string()).default([]),
  estMinutes: z.number().int().positive(),
  /**
   * Files this step writes for the first time. Every path must appear in
   * `finalFileTree`, and no path may be created by two different steps.
   */
  creates: z.array(z.string()).default([]),
  /**
   * Files from earlier steps this step changes. A path may only be edited
   * after some earlier step has created it — that ordering is what makes the
   * project grow instead of restarting.
   */
  edits: z.array(z.string()).default([]),
});
export type StepStub = z.infer<typeof StepStub>;

/* ------------------------------------------------------------------ *
 * Deployment
 * ------------------------------------------------------------------ */

/**
 * Where the finished project is meant to run.
 *
 * Chosen by the planner from what the project actually is — a static page does
 * not want a Dockerfile, and a Postgres-backed API cannot live on GitHub Pages.
 * `local` means the honest answer is "run it on your machine", which is the
 * right answer for a CLI tool.
 */
export const DeploymentTarget = z.enum([
  'local',
  'docker',
  'vercel',
  'netlify',
  'github-pages',
  'fly',
]);
export type DeploymentTarget = z.infer<typeof DeploymentTarget>;

export const DeploymentPlan = z.object({
  target: DeploymentTarget,
  /** Why this target suits this project, in one line. */
  rationale: z.string(),
  /**
   * Config files that make the project shippable — Dockerfile, CI workflow,
   * host config. Written in Phase C against the finished code, not guessed at
   * plan time.
   */
  artifacts: z.array(PlannedFile).default([]),
  /**
   * True when the learner asked to be TAUGHT deployment, which adds real steps
   * to the plan. The artifacts above are produced either way — a project you
   * cannot run is not a portfolio piece — but only an opt-in spends steps on it.
   */
  taught: z.boolean().default(false),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;

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
  /**
   * Every source file the finished project contains, decided once, up front.
   *
   * This is the architecture each step is held to. Without it a lazily
   * expanded step has nothing to build on but its own guess at what the
   * earlier steps left behind.
   *
   * Deployment artifacts and the README are NOT listed here: they are written
   * in Phase C from the finished code, and no step creates them.
   */
  finalFileTree: z.array(PlannedFile).min(1),
  /** Where this project is meant to run when it is done. */
  deployment: DeploymentPlan,
  steps: z.array(StepStub).min(MIN_STEPS).max(MAX_STEPS),
});
export type ProjectBlueprint = z.infer<typeof ProjectBlueprint>;

/**
 * A blueprint as it might be sitting in the database.
 *
 * Projects planned before the file plan existed have no `finalFileTree` and no
 * `deployment`, and their steps have no `creates`/`edits`. Parsing those with
 * the strict schema fails, which would turn every one of a learner's existing
 * projects into a 500 the moment this shipped.
 *
 * The strict schema stays strict on the generation path — it is what compels
 * the model to produce a file plan at all, since a defaulted field is optional
 * in the JSON schema the provider is handed. Tolerance belongs here, at the
 * point where old rows are read back.
 */
const StoredBlueprint = ProjectBlueprint.extend({
  finalFileTree: z.array(PlannedFile).default([]),
  deployment: DeploymentPlan.default({
    target: 'local',
    rationale: 'Planned before deployment targets were part of a blueprint.',
    artifacts: [],
    taught: false,
  }),
});

/**
 * Read a blueprint out of storage, upgrading an older one rather than failing.
 *
 * An upgraded blueprint has an empty file plan, and the generation code treats
 * that as "no manifest": steps still receive the accumulated codebase, which is
 * already a large improvement on the titles they used to get, but nothing tells
 * them which files to touch. New projects get the contract; old ones keep
 * working.
 */
export function parseStoredBlueprint(value: unknown): ProjectBlueprint | null {
  const parsed = StoredBlueprint.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether this blueprint carries the file-plan contract at all. */
export function hasFilePlan(blueprint: ProjectBlueprint): boolean {
  return blueprint.finalFileTree.length > 0;
}

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

/* ------------------------------------------------------------------ *
 * The finished project
 * ------------------------------------------------------------------ */

/**
 * What a learner walks away with.
 *
 * Assembled from the code they actually wrote, plus a README and deployment
 * config written against it. This is the difference between "I did a tutorial"
 * and "here is a thing I built" — the second one needs a repository someone
 * else can clone and run.
 */
export const ProjectArtifact = z.object({
  /** Every file of the finished project, README and deploy config included. */
  files: z.array(z.object({ path: z.string(), contents: z.string() })),
  readmeMd: z.string(),
  deployment: DeploymentPlan,
  /** Steps whose code came from the reference solution, not the learner. */
  stepsFromReference: z.array(z.number().int().nonnegative()).default([]),
  /** True when every step contributed the learner's own passing submission. */
  fullyLearnerWritten: z.boolean().default(false),
  generatedAt: z.string(),
});
export type ProjectArtifact = z.infer<typeof ProjectArtifact>;
