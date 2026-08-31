import { z } from 'zod';

/**
 * Open Knowledge Format (OKF v0.2) — the curated knowledge the agents consult.
 *
 * A bundle is a directory of Markdown files with YAML frontmatter. `type` is the
 * only required field; everything else is recommended or optional. Concepts link
 * to each other with ordinary Markdown links, and a broken link is legal — it
 * marks knowledge that has not been written yet rather than an error.
 *
 * Why this instead of retrieval: the alternative is embedding a pile of raw
 * documents and hoping the nearest neighbours are the relevant ones. A curated
 * bundle is small enough to select from deterministically, is reviewable in a
 * pull request, and renders as a readable wiki. There is no vector store, no
 * embedding model, and no extra round trip on the hot path.
 *
 * This module is portable by design — no fs, no I/O. Reading a bundle off disk
 * is `apps/api`'s job (see apps/api/src/knowledge.ts); everything here operates
 * on data that has already been loaded.
 */

/** Reserved filenames from the spec — never concept documents. */
export const OKF_RESERVED_FILENAMES = ['index.md', 'log.md'] as const;

export const KnowledgeConcept = z.object({
  /**
   * Bundle-relative path, e.g. `/concepts/closures.md`. This is the link target
   * other concepts use, so it is the stable identity of a concept.
   */
  path: z.string(),

  /** The one required OKF frontmatter field. Free-form by design. */
  type: z.string(),

  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),

  /** OKF lifecycle. `deprecated` concepts are kept but never selected. */
  status: z.enum(['draft', 'stable', 'deprecated']).default('stable'),

  /** The Markdown body, frontmatter already stripped. */
  body: z.string(),
});
export type KnowledgeConcept = z.infer<typeof KnowledgeConcept>;

/**
 * A loaded bundle.
 *
 * `index` is the OKF `index.md` — the directory listing. It is always sent, so
 * the model can see what else exists and say "there is a concept on X" instead
 * of inventing one. That is the progressive-disclosure half of the format.
 */
export const KnowledgeBundle = z.object({
  index: z.string().nullable().default(null),
  concepts: z.array(KnowledgeConcept).default([]),
});
export type KnowledgeBundle = z.infer<typeof KnowledgeBundle>;
