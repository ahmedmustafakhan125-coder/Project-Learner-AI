import { createHash } from 'node:crypto';
import {
  Extraction,
  brainNodeId,
  buildExtractionRequest,
  buildMemoryBlock,
  canonicalizeQuery,
  findRecall,
  normaliseExtraction,
  parseBrainEvent,
  projectBrain,
} from '@ai-edu/core';
import type {
  BrainEdge,
  BrainEvent,
  BrainEventKind,
  BrainEventPayload,
  BrainNode,
  BrainSourceKind,
  CompiledQuery,
  MemoryBlock,
  RecallCandidate,
  RecallMatch,
} from '@ai-edu/core';
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

  // An empty log goes through the same call with no watermark, which clears
  // the projection (0012). That only happens after forgetting, and then the
  // stored brain must go too — skipping the write would leave it standing.
  const { data, error } = await db().rpc('brain_replace_projection', {
    p_user_id: userId,
    p_watermark_at: projection.watermark?.createdAt ?? null,
    p_watermark_id: projection.watermark?.id ?? null,
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

/* ------------------------------------------------------------------ *
 * Reading the stored projection
 * ------------------------------------------------------------------ */

interface NodeRow {
  id: string;
  kind: BrainNode['kind'];
  key: string;
  label: string;
  score: number | string | null;
  confidence: number | string | null;
  metadata: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface EdgeRow {
  src: string;
  dst: string;
  kind: BrainEdge['kind'];
  weight: number | string;
  source_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** `numeric` columns can arrive as strings depending on the driver; a null stays null. */
function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadAll<Row>(
  table: string,
  columns: string,
  userId: string,
  orderBy: string[],
  kinds?: readonly string[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += EVENT_PAGE) {
    let query = db().from(table).select(columns).eq('user_id', userId);
    if (kinds) query = query.in('kind', [...kinds]);
    for (const column of orderBy) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + EVENT_PAGE - 1);
    if (error) throw new Error(`could not load ${table}: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < EVENT_PAGE) break;
  }
  return rows;
}

export interface ProjectionFilter {
  nodeKinds?: readonly BrainNode['kind'][];
  edgeKinds?: readonly BrainEdge['kind'][];
}

/**
 * One learner's stored brain, as the pure graph functions in packages/core
 * take it. A filter loads only the kinds a caller needs — recall reads
 * concepts, insights and mistakes, not every session the learner ever had.
 */
export async function loadProjection(
  userId: string,
  filter: ProjectionFilter = {},
): Promise<{ nodes: BrainNode[]; edges: BrainEdge[] }> {
  const [nodeRows, edgeRows] = await Promise.all([
    loadAll<NodeRow>(
      'brain_nodes',
      'id, kind, key, label, score, confidence, metadata, first_seen_at, last_seen_at',
      userId,
      ['id'],
      filter.nodeKinds,
    ),
    loadAll<EdgeRow>(
      'brain_edges',
      'src, dst, kind, weight, source_id, metadata, created_at',
      userId,
      ['src', 'dst', 'kind'],
      filter.edgeKinds,
    ),
  ]);

  return {
    nodes: nodeRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      label: row.label,
      score: numeric(row.score),
      confidence: numeric(row.confidence),
      metadata: row.metadata ?? {},
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
    edges: edgeRows.map((row) => ({
      src: row.src,
      dst: row.dst,
      kind: row.kind,
      weight: numeric(row.weight) ?? 0,
      sourceId: row.source_id,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Recall
 * ------------------------------------------------------------------ */

/**
 * How long a question will wait for its memory. Recall is an improvement to
 * an answer, never a precondition for one: past this, the answer goes ahead
 * without it.
 */
export const MEMORY_RECALL_TIMEOUT_MS = 1_500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** What a question's memory block is built from. Sessions and checkpoints are not needed. */
const MEMORY_FILTER: ProjectionFilter = {
  nodeKinds: ['concept', 'insight', 'mistake'],
  edgeKinds: ['RELATED_TO'],
};

/**
 * The learner's memory for one question, rendered for the prompt. Null when
 * the brain has nothing relevant, is slow, or fails — never an error.
 */
export async function recallMemory(userId: string, query: string): Promise<MemoryBlock | null> {
  try {
    const source = await withTimeout(loadProjection(userId, MEMORY_FILTER), MEMORY_RECALL_TIMEOUT_MS);
    if (!source) return null;
    return buildMemoryBlock({ nodes: source.nodes, edges: source.edges, query });
  } catch (err) {
    console.error('[brain] memory recall failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The text a question's memory is matched against: what the learner typed,
 * plus the topic and technology the interview established — "how do I fix
 * this" says nothing until the interview has filled in that it is about
 * closures in JavaScript.
 */
export function memoryQueryFor(compiled: CompiledQuery): string {
  return [compiled.originalQuery, compiled.slots['topic']?.value, compiled.slots['tech']?.value]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

/** How many of a learner's latest questions a near match is searched among. */
const RECALL_WINDOW = 500;

export interface QuestionRecall extends RecallMatch {
  /** The earlier conversation's title, for the banner. */
  title: string | null;
  /** That conversation's node in the brain. */
  nodeId: string;
}

interface FingerprintRow {
  fingerprint: string;
  canonical: string;
  thread_id: string;
  created_at: string;
}

const toCandidate = (row: FingerprintRow): RecallCandidate => ({
  fingerprint: row.fingerprint,
  canonical: row.canonical,
  threadId: row.thread_id,
  createdAt: row.created_at,
});

/**
 * Has the learner asked this before, in another conversation? Exact matches
 * are looked up by fingerprint across all of history; near matches among the
 * most recent questions. A match whose conversation has since been deleted is
 * not offered — there would be nothing to open.
 */
export async function findQuestionRecall(
  userId: string,
  query: string,
  currentThreadId: string | null,
): Promise<QuestionRecall | null> {
  const { canonical, fingerprint } = describeQuestion(query);
  if (!canonical) return null;

  const columns = 'fingerprint, canonical, thread_id, created_at';
  const [exact, recent] = await Promise.all([
    db()
      .from('brain_query_fingerprints')
      .select(columns)
      .eq('user_id', userId)
      .eq('fingerprint', fingerprint)
      .maybeSingle(),
    db()
      .from('brain_query_fingerprints')
      .select(columns)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(RECALL_WINDOW),
  ]);
  const failure = exact.error ?? recent.error;
  if (failure) throw new Error(`could not read fingerprints: ${failure.message}`);

  const candidates = [
    ...(exact.data ? [toCandidate(exact.data as FingerprintRow)] : []),
    ...((recent.data ?? []) as FingerprintRow[]).map(toCandidate),
  ];
  const match = findRecall(canonical, fingerprint, candidates, { excludeThreadId: currentThreadId });
  if (!match) return null;

  const { data: thread } = await db()
    .from('threads')
    .select('id, title')
    .eq('id', match.threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!thread) return null;

  return {
    ...match,
    title: typeof thread.title === 'string' ? thread.title : null,
    nodeId: brainNodeId.threadSession(match.threadId),
  };
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

/**
 * Forget everything the brain learned from one conversation or project, after
 * the learner deleted it. Its events go, and the projection is rebuilt from
 * what remains. Never throws: the deletion the learner asked for has already
 * happened, and a failure here is logged rather than turned into an error on a
 * request that succeeded.
 */
export async function forgetSource(
  userId: string,
  sourceKind: Extract<BrainSourceKind, 'thread' | 'project'>,
  sourceId: string,
): Promise<void> {
  try {
    const { data, error } = await db().rpc('brain_forget_source', {
      p_user_id: userId,
      p_source_kind: sourceKind,
      p_source_id: sourceId,
    });
    if (error) throw new Error(error.message);
    if (typeof data === 'number' && data > 0) await scheduleRebuild(userId);
  } catch (err) {
    console.error(`[brain] could not forget ${sourceKind} ${sourceId}:`, err instanceof Error ? err.message : err);
  }
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
