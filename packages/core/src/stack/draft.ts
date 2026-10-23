import { z } from 'zod';

import { SwitchCost } from '../schemas/stack.js';

/**
 * What the brief model is asked to return (docs/project-learner.md §8).
 *
 * Looser than `StackBrief` on purpose. Counts such as "at least two pros" are
 * checked by `verifyStackBrief`, which can name the problem and repair or
 * retry, instead of failing structured output with a schema error nobody can
 * act on. Fields code decides — `requestedByLearner`, `verification`,
 * `cardId`, the profile and the tier — are not asked for at all.
 */

export const AlternativeDraft = z.object({
  name: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  pickWhen: z.string(),
  switchCost: SwitchCost,
});
export type AlternativeDraft = z.infer<typeof AlternativeDraft>;

export const LayerDraft = z.object({
  /** One of the layer ids the user turn lists. */
  layer: z.string(),
  name: z.string(),
  /** Only when the docs dossier or a tech card states it; otherwise null. */
  versionMajor: z.string().nullable(),
  whatItIs: z.string(),
  roleHere: z.string(),
  whyChosen: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  learnerCost: z.string(),
  alternatives: z.array(AlternativeDraft),
  assumptions: z.array(z.string()),
  /** Reference ids from the docs dossier, such as "d3". */
  docRefs: z.array(z.string()),
});
export type LayerDraft = z.infer<typeof LayerDraft>;

export const BriefDraft = z.object({
  summary: z.string(),
  layers: z.array(LayerDraft),
  toolchain: z.array(
    z.object({
      tool: z.string(),
      minVersion: z.string().nullable(),
      installHint: z.object({
        linux: z.string().optional(),
        macos: z.string().optional(),
        windows: z.string().optional(),
      }),
    }),
  ),
  architecture: z.object({
    style: z.string(),
    components: z.array(z.object({ id: z.string(), name: z.string(), layer: z.string(), purpose: z.string() })),
    flows: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
  }),
  howItFitsTogether: z.string(),
  milestones: z.array(z.object({ title: z.string(), outcome: z.string() })),
  risks: z.array(z.string()),
  friction: z.array(z.string()),
});
export type BriefDraft = z.infer<typeof BriefDraft>;
