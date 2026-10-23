import { PROJECT_TIERS } from '@ai-edu/llm';
import { z } from 'zod';

import { ProfileId } from '../profiles/types.js';

/**
 * The Stack Brief (docs/project-learner.md §8).
 *
 * Generated after research and before the blueprint: every layer the profile
 * requires, explained — what it is, what it does here, why it was chosen,
 * pros, cons, realistic alternatives, what the learner must install and
 * learn, and the documentation it rests on. The learner approves it before a
 * plan is written, and it is the only source of stack truth afterwards:
 * `blueprint.techStack` is derived from it by code (invariant 17).
 *
 * `layer` is a string checked against the profile's vocabulary by
 * `verifyStackBrief`, not a fixed enum, so a kernel's "boot protocol" and a
 * game's "simulation core" are first-class layers.
 */

/** The same five tiers `PROJECT_MODELS` is keyed by. */
export const ComplexityTier = z.enum(PROJECT_TIERS);
export type ComplexityTier = z.infer<typeof ComplexityTier>;

export const HostOS = z.enum(['linux', 'macos', 'windows']);
export type HostOS = z.infer<typeof HostOS>;

/** Something to install before the project can run, with how, per host OS. */
export const ToolRequirement = z.object({
  tool: z.string(),
  /** From the dossier or the pin table only; null when neither says. */
  minVersion: z.string().nullable(),
  installHint: z.object({
    linux: z.string().optional(),
    macos: z.string().optional(),
    windows: z.string().optional(),
  }),
});
export type ToolRequirement = z.infer<typeof ToolRequirement>;

export const SwitchCost = z.enum(['low', 'medium', 'high']);

export const TechAlternative = z.object({
  name: z.string(),
  pros: z.array(z.string()).min(1),
  cons: z.array(z.string()).min(1),
  /** The concrete situation that favours it. */
  pickWhen: z.string(),
  switchCost: SwitchCost,
});
export type TechAlternative = z.infer<typeof TechAlternative>;

/** Which check a layer's steps can get, strongest first. Set by code, never by the model. */
export const Verification = z.enum(['browser', 'cli', 'static']);
export type Verification = z.infer<typeof Verification>;

export const LayerChoice = z.object({
  /** Validated against the profile's layer list. */
  layer: z.string(),
  name: z.string(),
  /** From the dossier or the pin table only (invariant 22). */
  versionMajor: z.string().nullable(),
  /** One plain sentence for a beginner. */
  whatItIs: z.string(),
  /** What it does in THIS project. */
  roleHere: z.string(),
  /** Argued against the named alternatives. */
  whyChosen: z.string(),
  pros: z.array(z.string()).min(2),
  cons: z.array(z.string()).min(1),
  /** What they must learn to use it. */
  learnerCost: z.string(),
  /** At most 2, and 1 for T1; the T1 limit is checked in code. */
  alternatives: z.array(TechAlternative).min(1).max(2),
  requestedByLearner: z.boolean(),
  /** Each becomes a round-2 chip: "Assumed: x86-64 under QEMU. Change?" */
  assumptions: z.array(z.string()).default([]),
  /** DocRef ids from the dossier. */
  docRefs: z.array(z.string()).min(1),
  verification: Verification,
  cardId: z.string().nullable(),
});
export type LayerChoice = z.infer<typeof LayerChoice>;

export const ArchitectureView = z.object({
  /** "Tauri shell + Rust core + SQLite" */
  style: z.string(),
  components: z.array(
    z.object({ id: z.string(), name: z.string(), layer: z.string(), purpose: z.string() }),
  ),
  flows: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
});
export type ArchitectureView = z.infer<typeof ArchitectureView>;

export const StackBrief = z.object({
  profile: ProfileId,
  tier: ComplexityTier,
  summary: z.string(),
  layers: z.array(LayerChoice).min(1),
  /** What to install, per host OS, from the dossier. */
  toolchain: z.array(ToolRequirement),
  architecture: ArchitectureView,
  /** One request, frame or boot traced end to end. */
  howItFitsTogether: z.string(),
  /** T4 and T5 only. */
  milestones: z.array(z.object({ title: z.string(), outcome: z.string() })).default([]),
  risks: z.array(z.string()).default([]),
  /** A requested technology that fits poorly, kept and explained. */
  friction: z.array(z.string()).default([]),
});
export type StackBrief = z.infer<typeof StackBrief>;

/**
 * A stored brief, or null for a project planned before PROJECT_LEARNER, which
 * falls back to its "Built with" list.
 */
export function parseStoredStackBrief(value: unknown): StackBrief | null {
  if (value === null || value === undefined) return null;
  const parsed = StackBrief.safeParse(value);
  return parsed.success ? parsed.data : null;
}
