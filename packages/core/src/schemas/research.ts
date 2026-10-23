import { z } from 'zod';

/**
 * The Research Dossier (docs/project-studio.md §7).
 *
 * What a research pass read in allowlisted official documentation, kept as
 * notes, short cited snippets and links — never whole pages. Every brief and
 * step is generated against it, and the learner sees its references.
 *
 * Fetched text is data, never instructions (invariant 25): it reaches a prompt
 * only through `renderDossier`, which wraps it in `<docs_dossier>`.
 */

/** Longest snippet kept from a citation block. Steps paraphrase and link. */
export const MAX_CITED_CHARS = 150;

export const DocRef = z.object({
  /** 'd3', referenced from the notes as [d3]. */
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string(),
  citedText: z.string().max(MAX_CITED_CHARS),
  retrievedAt: z.string(),
  /** False only under the `general` profile, whose domains are not known in advance. */
  vetted: z.boolean(),
});
export type DocRef = z.infer<typeof DocRef>;

export const DossierScope = z.enum(['project', 'step']);
export type DossierScope = z.infer<typeof DossierScope>;

export const ResearchDossier = z.object({
  scope: DossierScope,
  /** Markdown under fixed headings; every claim tagged with a ref, e.g. [d3]. */
  notes: z.string(),
  docRefs: z.array(DocRef),
  versions: z.array(z.object({ tech: z.string(), versionSeen: z.string(), ref: z.string() })),
  apis: z.array(z.object({ symbol: z.string(), signature: z.string(), ref: z.string() })),
  toolchain: z.array(z.object({ tool: z.string(), install: z.string(), ref: z.string() })),
});
export type ResearchDossier = z.infer<typeof ResearchDossier>;

/**
 * A stored dossier, or null.
 *
 * Tolerant like `parseStoredBlueprint`: projects created before Project Studio
 * have none, and a dossier this version cannot read is treated as absent
 * rather than failing the page that shows it.
 */
export function parseStoredDossier(value: unknown): ResearchDossier | null {
  if (value === null || value === undefined) return null;
  const parsed = ResearchDossier.safeParse(value);
  return parsed.success ? parsed.data : null;
}
