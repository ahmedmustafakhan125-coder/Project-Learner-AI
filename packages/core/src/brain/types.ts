import { z } from 'zod';

/**
 * The brain's vocabulary.
 *
 * Events are the source of truth; nodes and edges are a projection of them
 * (see `project.ts`). The two enums below are mirrored by Postgres enums in
 * `supabase/migrations/0011_brain.sql` — change one, change the other.
 */

export const BrainNodeKind = z.enum(['concept', 'session', 'insight', 'mistake', 'project', 'checkpoint']);
export type BrainNodeKind = z.infer<typeof BrainNodeKind>;

export const BrainEdgeKind = z.enum([
  'ACTIVATED',
  'RELATED_TO',
  'PRODUCED',
  'OCCURRED_IN',
  'CONTAINS',
  'ASSESSED',
  'DUPLICATE_OF',
]);
export type BrainEdgeKind = z.infer<typeof BrainEdgeKind>;

export const BrainSourceKind = z.enum(['thread', 'project', 'assessment']);
export type BrainSourceKind = z.infer<typeof BrainSourceKind>;

/* ------------------------------------------------------------------ *
 * Extraction — what the distiller pulls out of one answered question
 * ------------------------------------------------------------------ */

/**
 * Deliberately lenient: no length or count limits in the schema the model sees,
 * because a model that writes nine concepts instead of eight should not fail
 * validation and cost a repair round trip. `normaliseExtraction` applies the
 * caps afterwards, in code.
 */
export const Extraction = z.object({
  concepts: z
    .array(
      z.object({
        label: z.string(),
        /** The OKF path when the concept is one the curated library covers. */
        okfPath: z.string().nullable().default(null),
      }),
    )
    .default([]),
  insights: z
    .array(
      z.object({
        text: z.string(),
        concepts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  mistakes: z
    .array(
      z.object({
        text: z.string(),
        concept: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type Extraction = z.infer<typeof Extraction>;

/* ------------------------------------------------------------------ *
 * Event payloads
 * ------------------------------------------------------------------ */

export const QuestionAskedPayload = z.object({
  threadId: z.string(),
  messageId: z.string(),
  /** Canonical form of the question. Empty when nothing but filler was asked. */
  canonical: z.string(),
  /** sha256 of `canonical`, computed by the API. Empty when `canonical` is. */
  fingerprint: z.string(),
  /** The question as typed, truncated — used only as a label. */
  query: z.string(),
});
export type QuestionAskedPayload = z.infer<typeof QuestionAskedPayload>;

export const QaDistilledPayload = z.object({
  threadId: z.string(),
  messageId: z.string(),
  extraction: Extraction,
});
export type QaDistilledPayload = z.infer<typeof QaDistilledPayload>;

export const CheckpointResultPayload = z.object({
  projectId: z.string(),
  projectTitle: z.string().nullable().default(null),
  stepId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepTitle: z.string(),
  concepts: z.array(z.string()).default([]),
  passed: z.boolean(),
  /** `file_existence` | `symbol_check` | `tests`. Null on a pass. */
  failedLayer: z.string().nullable().default(null),
  attemptNo: z.number().int().positive(),
});
export type CheckpointResultPayload = z.infer<typeof CheckpointResultPayload>;

export const McqAttemptPayload = z.object({
  assessmentId: z.string(),
  conceptKey: z.string(),
  conceptLabel: z.string(),
  attemptNumber: z.number().int().positive(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passed: z.boolean(),
});
export type McqAttemptPayload = z.infer<typeof McqAttemptPayload>;

export const VivaAnswerPayload = z.object({
  assessmentId: z.string(),
  conceptKey: z.string(),
  questionIndex: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(5),
});
export type VivaAnswerPayload = z.infer<typeof VivaAnswerPayload>;

export const VivaScorePayload = z.object({
  assessmentId: z.string(),
  conceptKey: z.string(),
  conceptLabel: z.string(),
  attemptNumber: z.number().int().positive(),
  mcqScore: z.number().int().nonnegative(),
  vivaScore: z.number().int().min(0).max(25),
  /** The rubrics the answers were marked against, frozen at grading time. */
  rubricSnapshot: z.array(z.unknown()),
  missedCriteria: z
    .array(
      z.object({
        questionIndex: z.number().int().nonnegative(),
        criterionId: z.string(),
        text: z.string(),
      }),
    )
    .default([]),
});
export type VivaScorePayload = z.infer<typeof VivaScorePayload>;

export const OfferDismissedPayload = z.object({
  conceptKey: z.string(),
});
export type OfferDismissedPayload = z.infer<typeof OfferDismissedPayload>;

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

const eventBase = {
  id: z.string(),
  sourceKind: BrainSourceKind,
  sourceId: z.string(),
  dedupeKey: z.string(),
  /** ISO-8601. The projection orders by this, then by `id`. */
  createdAt: z.string(),
};

export const BrainEvent = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('question_asked'), payload: QuestionAskedPayload }),
  z.object({ ...eventBase, kind: z.literal('qa_distilled'), payload: QaDistilledPayload }),
  z.object({ ...eventBase, kind: z.literal('checkpoint_result'), payload: CheckpointResultPayload }),
  z.object({ ...eventBase, kind: z.literal('mcq_attempt'), payload: McqAttemptPayload }),
  z.object({ ...eventBase, kind: z.literal('viva_answer'), payload: VivaAnswerPayload }),
  z.object({ ...eventBase, kind: z.literal('viva_score'), payload: VivaScorePayload }),
  z.object({ ...eventBase, kind: z.literal('offer_dismissed'), payload: OfferDismissedPayload }),
]);
export type BrainEvent = z.infer<typeof BrainEvent>;
export type BrainEventKind = BrainEvent['kind'];

/** Payload type for one event kind. */
export type BrainEventPayload<K extends BrainEventKind> = Extract<BrainEvent, { kind: K }>['payload'];

/**
 * A stored event as the database returns it (snake_case), parsed into a
 * `BrainEvent`. Returns null for a row that no longer validates — one malformed
 * payload must cost the learner one event, never their whole brain.
 */
export function parseBrainEvent(row: {
  id: string;
  kind: string;
  source_kind: string;
  source_id: string;
  dedupe_key: string;
  payload: unknown;
  created_at: string;
}): BrainEvent | null {
  const parsed = BrainEvent.safeParse({
    id: row.id,
    kind: row.kind,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

export interface BrainNode {
  /** Deterministic: `concept:<key>`, `session:thread:<uuid>`, … */
  id: string;
  kind: BrainNodeKind;
  key: string;
  label: string;
  /** Mastery for concepts (0..1). Null elsewhere. */
  score: number | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface BrainEdge {
  src: string;
  dst: string;
  kind: BrainEdgeKind;
  weight: number;
  /** The thread, project, or assessment the edge was formed in. */
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface QueryFingerprint {
  fingerprint: string;
  canonical: string;
  threadId: string;
  messageId: string;
  createdAt: string;
}

export interface BrainWatermark {
  createdAt: string;
  id: string;
}

export interface BrainProjection {
  nodes: BrainNode[];
  edges: BrainEdge[];
  fingerprints: QueryFingerprint[];
  /** The last event folded in. Null for an empty log. */
  watermark: BrainWatermark | null;
}
