import { createHash } from 'node:crypto';
import {
  Extraction,
  buildExtractionRequest,
  canonicalizeQuery,
  normaliseExtraction,
  parseBrainEvent,
  projectBrain,
} from '@ai-edu/core';
import type { BrainEvent, BrainEventKind, BrainEventPayload, BrainSourceKind } from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { checkBudget, db, recordUsage } from './db.js';
import { knowledgeBundle } from './knowledge.js';

/**
 * Writing to the brain.
 *
 * Routes record what happened as events; this module turns the event log into
 * the stored projection. The projection itself is computed by `projectBrain`
 * in packages/core — this file only loads, hashes, and writes.
 *
 * Everything exported here is fire-and-forget safe: nothing throws. A learner's
 * answer, checkpoint, or grade must never fail because their memory could not
 * be updated, for the same reason `recordUsage` never throws.
 */

/* ------------------------------------------------------------------ *
 * Fingerprints
 * ------------------------------------------------------------------ */

/** sha256 of a canonical question. Lives here because packages/core cannot hash portably. */
export function fingerprintOf(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** A question's canonical form and fingerprint. Both empty when it was only filler. */
export function describeQuestion(query: string): { canonical: string; fingerprint: string } {
  const canonical = canonicalizeQuery(query);
  return { canonical, fingerprint: canonical ? fingerprintOf(canonical) : '' };
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface BrainEventInput<K extends BrainEventKind> {
  userId: string;
  kind: K;
  sourceKind: BrainSourceKind;
  sourceId: string;
  /** Names the real-world occurrence, so a retried write is a no-op. */
  dedupeKey: string;
  payload: BrainEventPayload<K>;
}

/** Postgres `unique_violation`: this occurrence was already recorded. */
const UNIQUE_VIOLATION = '23505';

/** Appends one event. True when a new row was written. */
export async function appendBrainEvent<K extends BrainEventKind>(input: BrainEventInput<K>): Promise<boolean> {
  // Widened to plain values: the client's insert typing cannot see through the generic `K`.
  const row: Record<string, unknown> = {
    user_id: input.userId,
    kind: input.kind,
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    dedupe_key: input.dedupeKey,
    payload: input.payload,
  };
  const { error } = await db().from('brain_events').insert(row);

  if (!error) return true;
  if (error.code !== UNIQUE_VIOLATION) {
    console.error(`[brain] failed to record ${input.kind}:`, error.message);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/** PostgREST caps a response at `max_rows` (1000 in supabase/config.toml), so the log is paged. */
const EVENT_PAGE = 1000;

export async function loadBrainEvents(userId: string): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];

  for (let from = 0; ; from += EVENT_PAGE) {
    const { data, error } = await db()
      .from('brain_events')
      .select('id, kind, source_kind, source_id, dedupe_key, payload, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + EVENT_PAGE - 1);

    if (error) throw new Error(`could not load brain events: ${error.message}`);

    const rows = (data ?? []) as Parameters<typeof parseBrainEvent>[0][];
    for (const row of rows) {
      const event = parseBrainEvent(row);
      if (event) events.push(event);
      else console.warn(`[brain] skipping malformed event ${row.id} (${row.kind})`);
    }
    if (rows.length < EVENT_PAGE) break;
  }

  return events;
}

/**
 * Rebuild one learner's projection from their whole log. False when a newer
 * rebuild had already landed — not an error, just a snapshot that lost the race.
 */
export async function rebuildProjection(userId: string): Promise<boolean> {
  const projection = projectBrain(await loadBrainEvents(userId));
  if (!projection.watermark) return true;

  const { data, error } = await db().rpc('brain_replace_projection', {
    p_user_id: userId,
    p_watermark_at: projection.watermark.createdAt,
    p_watermark_id: projection.watermark.id,
    p_nodes: projection.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      key: node.key,
      label: node.label,
      score: node.score,
      confidence: node.confidence,
      metadata: node.metadata,
      first_seen_at: node.firstSeenAt,
      last_seen_at: node.lastSeenAt,
    })),
    p_edges: projection.edges.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      kind: edge.kind,
      weight: edge.weight,
      source_id: edge.sourceId,
      metadata: edge.metadata,
      created_at: edge.createdAt,
    })),
    p_fingerprints: projection.fingerprints.map((fp) => ({
      fingerprint: fp.fingerprint,
      canonical: fp.canonical,
      thread_id: fp.threadId,
      message_id: fp.messageId,
      created_at: fp.createdAt,
    })),
  });

  if (error) throw new Error(`could not write brain projection: ${error.message}`);
  return data === true;
}

/**
 * Rebuilds for one learner run one at a time within this process. Across
 * processes the watermark check in `brain_replace_projection` does the same job.
 */
const rebuildQueues = new Map<string, Promise<void>>();

export function scheduleRebuild(userId: string): Promise<void> {
  const previous = rebuildQueues.get(userId) ?? Promise.resolve();
  const next = previous
    .then(() => rebuildProjection(userId))
    .then(
      () => undefined,
      (err: unknown) => {
        console.error('[brain] rebuild failed:', err instanceof Error ? err.message : err);
      },
    );
  rebuildQueues.set(userId, next);
  void next.then(() => {
    if (rebuildQueues.get(userId) === next) rebuildQueues.delete(userId);
  });
  return next;
}

/** Append an event and, if it was new, refresh the projection. Never throws. */
export async function recordBrainEvent<K extends BrainEventKind>(input: BrainEventInput<K>): Promise<void> {
  try {
    if (await appendBrainEvent(input)) await scheduleRebuild(input.userId);
  } catch (err) {
    console.error('[brain] could not record event:', err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ *
 * Distillation
 * ------------------------------------------------------------------ */

export interface DistillQaArgs {
  userId: string;
  threadId: string;
  messageId: string;
  /** The screened, compiled question — never the raw text. */
  question: string;
  /** What the `concepts` specialist answered. */
  conceptsAnswer: string;
}

function libraryTitles(): Array<{ title: string; path: string }> {
  try {
    return knowledgeBundle()
      .concepts.filter((concept) => concept.status !== 'deprecated')
      .map((concept) => ({ title: concept.title ?? concept.path, path: concept.path }));
  } catch {
    return [];
  }
}

/**
 * Distil one answered question into the brain.
 *
 * Costs one call on the utility model, so it goes through the same budget
 * check and usage accounting as every other model call. The question was
 * already screened by the gateway on its way into the fan-out.
 */
export async function distillQa(args: DistillQaArgs): Promise<void> {
  try {
    const budget = await checkBudget(args.userId);
    if (budget.exceeded) return;

    let provider;
    try {
      provider = createProviderForTask('utility');
    } catch {
      return;
    }

    const started = Date.now();
    const result = await provider.structured(
      buildExtractionRequest({
        modelId: provider.modelId,
        question: args.question,
        conceptsAnswer: args.conceptsAnswer,
        library: libraryTitles(),
      }),
      Extraction,
    );

    void recordUsage({
      userId: args.userId,
      task: 'brain:extract',
      provider: provider.id,
      model: provider.modelId,
      usage: result.usage,
      latencyMs: Date.now() - started,
    });

    const extraction = normaliseExtraction(result.data);
    if (extraction.concepts.length === 0 && extraction.insights.length === 0) return;

    await recordBrainEvent({
      userId: args.userId,
      kind: 'qa_distilled',
      sourceKind: 'thread',
      sourceId: args.threadId,
      dedupeKey: `distill:${args.messageId}`,
      payload: { threadId: args.threadId, messageId: args.messageId, extraction },
    });
  } catch (err) {
    console.error('[brain] distillation failed:', err instanceof Error ? err.message : err);
  }
}
