import { z } from 'zod';

/**
 * Shared vocabulary. Every other schema derives from these, and the database
 * enums in `supabase/migrations/0001_init.sql` mirror them — if you change a
 * value here, change it there too.
 */

export const SkillLevel = z.enum(['beginner', 'intermediate', 'advanced']);
export type SkillLevel = z.infer<typeof SkillLevel>;

export const QueryIntent = z.enum([
  'project_generation',
  'concept_question',
  'debug_help',
  'other',
]);
export type QueryIntent = z.infer<typeof QueryIntent>;

export const AgentKind = z.enum(['simple', 'industry', 'practice', 'concepts']);
export type AgentKind = z.infer<typeof AgentKind>;

/** Ordering matters: `simple` is the fan-out's lead request. */
export const AGENT_ORDER = ['simple', 'industry', 'practice', 'concepts'] as const;

export const AgentStatus = z.enum(['pending', 'streaming', 'complete', 'error']);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** A file the learner attached to a query. */
export const AttachmentRef = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Server-extracted text. Always treated as untrusted data, never instructions. */
  extractedText: z.string().nullable().default(null),
  /** Set when the file was uploaded to the provider and can be referenced by id. */
  providerFileId: z.string().nullable().default(null),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;
