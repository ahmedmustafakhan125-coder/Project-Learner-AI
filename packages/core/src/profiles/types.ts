import { z } from 'zod';

import type { SlotDef } from '../interview/slots.js';
import type { ComplexityTier, StackBrief, ToolRequirement, Verification } from '../schemas/stack.js';

/**
 * Project profiles (docs/project-learner.md §6).
 *
 * A profile is a data file, not a prompt: the stack layers that kind of
 * software has, the questions it needs, the architecture rule that keeps it
 * testable, the harness that verifies its steps and where its documentation
 * lives. Adding a profile is a data edit plus golden fixtures.
 *
 * Its `promptAddendum` goes in the user turn, like TEACH_DEPLOYMENT, so the
 * cached system prefix stays byte-identical across every profile (invariant 21).
 */

/** Every kind of software Project Learner plans. `general` is the fallback. */
export const PROFILE_IDS = [
  'web-frontend',
  'web-fullstack',
  'api-backend',
  'cli-tool',
  'desktop-app',
  'mobile-app',
  'game',
  'graphics',
  'systems-os',
  'language-tooling',
  'systems-other',
  'data-ml',
  'embedded',
  'general',
] as const;

export const ProfileId = z.enum(PROFILE_IDS);
export type ProfileId = z.infer<typeof ProfileId>;

/** What can verify a step (§10). */
export const HARNESS_KINDS = [
  'unit',
  'exec-golden',
  'golden-image',
  'pixel-probes',
  'sim-ticks',
  'qemu-serial',
  'artifact',
  'headless-app',
] as const;

export const HarnessKind = z.enum(HARNESS_KINDS);
export type HarnessKind = z.infer<typeof HarnessKind>;

/** One entry of the Stack Brief's vocabulary for a profile. */
export interface LayerDef {
  /** 'boot-protocol', 'simulation-core'. What `LayerChoice.layer` names. */
  id: string;
  label: string;
  /** The card group on the brief: for a kernel, Toolchain, Boot, Kernel, Devices, Tools. */
  section: string;
  /** What the layer covers, for the brief prompt and the empty state. */
  description: string;
  /**
   * The research key that grounds this layer when the learner named nothing
   * for it: a tech card id (`tauri`) or a topic (`osdev-core`). Layers that
   * share a key are researched once.
   */
  research?: string;
  /**
   * The strongest check this layer's steps can get, when it is weaker than
   * the profile's: an updater is checked statically even in a CLI profile.
   */
  check?: Verification;
}

/**
 * The least tier a sub-goal needs. `keywords` match whole words in what the
 * learner said; `signal:<name>` matches a classify signal (`signal:persistence`).
 * A floor with no keywords is the profile's base floor and always applies.
 */
export interface TierFloor {
  goal: string;
  tier: ComplexityTier;
  keywords: string[];
}

/**
 * Checked by `verifyBlueprint`, deterministically, not left to the prompt.
 *
 * Globs match paths in the blueprint's file plan; `a|b` means either.
 */
export interface ArchitectureRule {
  /** Shown to the learner on the brief. */
  description: string;
  /** Globs that must exist in finalFileTree. */
  requiredPaths: string[];
  /** Globs step 1 must create. */
  firstStepCreates: string[];
  /** Globs every later step must extend. */
  everyStepEdits?: string[];
  forbiddenImports: { in: string; packages: string[] }[];
}

/**
 * A key into `knowledge/docs/sources.json`, such as `profile:systems-os` or
 * `tech:tauri`. The domains and entry URLs live there, read by apps/api at
 * startup; the research pass's allowlist is built from them (invariant 23).
 */
export type DocSourceKey = `profile:${string}` | `tech:${string}` | 'base';

export interface DocSourceRef {
  key: DocSourceKey;
}

export interface Profile {
  id: ProfileId;
  label: string;
  /**
   * True for the profiles with everything filled in (§6: `desktop-app`,
   * `systems-os`, `language-tooling`, `general`). The rest have their
   * vocabulary and slots; their rules, toolchains and addenda come in week 2.
   */
  deep: boolean;
  /** Words that point at this profile, matched by `detectProfile`. */
  signalWords: string[];
  /** The Stack Brief's vocabulary for this profile. */
  layers: LayerDef[];
  requiredLayersByTier: Record<ComplexityTier, string[]>;
  /** Extra interview slots, same shape as today's. */
  slots: SlotDef[];
  /** The least tier a sub-goal needs: a kernel past booting is T5. */
  tierFloors: TierFloor[];
  architectureRule: ArchitectureRule;
  harnesses: HarnessKind[];
  /** Whether the browser sandbox can run this brief's steps. */
  browserRunnable: (brief: StackBrief) => boolean;
  /** What `verify doctor` checks. */
  toolchain: ToolRequirement[];
  docSources: DocSourceRef[];
  /** The T5 checklist. */
  prerequisites: string[];
  /** Static text, sent in the user turn. */
  promptAddendum: string;
}
