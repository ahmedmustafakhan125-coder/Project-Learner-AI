import { canonicalizeConcept } from './canonicalize.js';
import { NO_MASTERY, afterCheckpoint, afterQuestion, afterViva, roundMastery } from './mastery.js';
import type { Mastery } from './mastery.js';
import type {
  BrainEdge,
  BrainEdgeKind,
  BrainEvent,
  BrainEventPayload,
  BrainNode,
  BrainNodeKind,
  BrainProjection,
  BrainWatermark,
  QueryFingerprint,
} from './types.js';

/**
 * The projection: a learner's whole event log in, their brain out.
 *
 * A pure fold. Same events in — in any order — byte-identical projection out,
 * which is the property everything else rests on: the API can throw the stored
 * projection away and rebuild it at any moment, and a rebuild that came out
 * different would mean the brain was never really derived from the log.
 *
 * So nothing in here reads a clock, draws a random number, or depends on the
 * order a Map happened to be filled in beyond the order this file imposes.
 * Events are sorted first, and the output is sorted last.
 *
 * Full replay on every new event is deliberate at this scale. Once a learner's
 * log runs past a few thousand events it is worth folding incrementally from
 * the stored watermark instead — the fold is already shaped for it.
 */

/** Deterministic node ids. A link to one of these survives every rebuild. */
export const brainNodeId = {
  concept: (key: string) => `concept:${key}`,
  insight: (key: string) => `insight:${key}`,
  mistake: (key: string) => `mistake:${key}`,
  threadSession: (threadId: string) => `session:thread:${threadId}`,
  assessmentSession: (assessmentId: string) => `session:assessment:${assessmentId}`,
  project: (projectId: string) => `project:${projectId}`,
  checkpoint: (stepId: string) => `checkpoint:${stepId}`,
} as const;

/** What a failed checkpoint layer means, in words a learner recognises. */
const FAILED_LAYER_LABEL: Record<string, string> = {
  file_existence: 'required files missing',
  symbol_check: 'required code missing',
  tests: 'tests failing',
};

const SESSION_LABEL_CHARS = 80;

function clipLabel(text: string, max = SESSION_LABEL_CHARS): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Total order on events: time, then id. Ids are unique, so no two events tie. */
export function compareEvents(a: BrainEvent, b: BrainEvent): number {
  return timeOf(a.createdAt) - timeOf(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function edgeKey(src: string, dst: string, kind: BrainEdgeKind): string {
  return `${src}\u0000${dst}\u0000${kind}`;
}

function count(metadata: Record<string, unknown>, field: string): number {
  const value = metadata[field];
  return typeof value === 'number' ? value : 0;
}

class Fold {
  readonly nodes = new Map<string, BrainNode>();
  readonly mastery = new Map<string, Mastery>();
  readonly edges = new Map<string, BrainEdge>();
  readonly fingerprints = new Map<string, QueryFingerprint>();
  /** Next ACTIVATED position per session — the order the wire walks. */
  private readonly nextOrder = new Map<string, number>();

  touch(id: string, kind: BrainNodeKind, key: string, label: string, at: string): BrainNode {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.lastSeenAt = at;
      return existing;
    }
    const node: BrainNode = {
      id,
      kind,
      key,
      label,
      score: null,
      confidence: null,
      metadata: {},
      firstSeenAt: at,
      lastSeenAt: at,
    };
    this.nodes.set(id, node);
    return node;
  }

  link(
    src: string,
    dst: string,
    kind: BrainEdgeKind,
    at: string,
    sourceId: string | null,
  ): { edge: BrainEdge; created: boolean } {
    const key = edgeKey(src, dst, kind);
    const existing = this.edges.get(key);
    if (existing) {
      existing.weight += 1;
      return { edge: existing, created: false };
    }
    const edge: BrainEdge = { src, dst, kind, weight: 1, sourceId, metadata: {}, createdAt: at };
    this.edges.set(key, edge);
    return { edge, created: true };
  }

  /** Session → concept, recording the order concepts were first reached in. */
  activate(sessionId: string, conceptId: string, at: string, sourceId: string): void {
    const { edge, created } = this.link(sessionId, conceptId, 'ACTIVATED', at, sourceId);
    if (created) {
      const order = this.nextOrder.get(sessionId) ?? 0;
      edge.metadata['order'] = order;
      this.nextOrder.set(sessionId, order + 1);
    }
  }

  /** Concepts that came up together are related; one edge per pair, smaller id first. */
  relate(conceptIds: readonly string[], at: string, sourceId: string): void {
    const unique = [...new Set(conceptIds)].sort();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        this.link(unique[i] as string, unique[j] as string, 'RELATED_TO', at, sourceId);
      }
    }
  }

  /** Touch a concept by its label. Returns null when the label canonicalises to nothing. */
  concept(label: string, at: string, okfPath: string | null = null): string | null {
    const key = canonicalizeConcept(label);
    if (!key) return null;
    const id = brainNodeId.concept(key);
    const node = this.touch(id, 'concept', key, clipLabel(label), at);
    if (okfPath && typeof node.metadata['okfPath'] !== 'string') node.metadata['okfPath'] = okfPath;
    node.metadata['evidence'] = count(node.metadata, 'evidence') + 1;
    return id;
  }

  /** The id of a concept that already exists, without touching it. */
  existingConcept(label: string): string | null {
    const key = canonicalizeConcept(label);
    if (!key) return null;
    const id = brainNodeId.concept(key);
    return this.nodes.has(id) ? id : null;
  }

  updateMastery(conceptId: string, next: (prev: Mastery) => Mastery): void {
    const updated = next(this.mastery.get(conceptId) ?? NO_MASTERY);
    this.mastery.set(conceptId, updated);
  }

  mistake(key: string, label: string, at: string, sourceId: string): string {
    const id = brainNodeId.mistake(key);
    const node = this.touch(id, 'mistake', key, clipLabel(label, 200), at);
    node.metadata['occurrences'] = count(node.metadata, 'occurrences') + 1;
    node.metadata['lastSourceId'] = sourceId;
    return id;
  }

  threadSession(threadId: string, label: string, at: string): BrainNode {
    const node = this.touch(
      brainNodeId.threadSession(threadId),
      'session',
      `thread:${threadId}`,
      clipLabel(label) || 'Conversation',
      at,
    );
    node.metadata['source'] = 'thread';
    node.metadata['threadId'] = threadId;
    return node;
  }

  assessmentSession(assessmentId: string, conceptLabel: string, at: string): BrainNode {
    const node = this.touch(
      brainNodeId.assessmentSession(assessmentId),
      'session',
      `assessment:${assessmentId}`,
      clipLabel(`Assessment: ${conceptLabel}`),
      at,
    );
    node.metadata['source'] = 'assessment';
    node.metadata['assessmentId'] = assessmentId;
    return node;
  }
}

/* ------------------------------------------------------------------ *
 * One handler per event kind
 * ------------------------------------------------------------------ */

function onQuestionAsked(fold: Fold, p: BrainEventPayload<'question_asked'>, at: string): void {
  const session = fold.threadSession(p.threadId, p.query, at);
  session.metadata['questions'] = count(session.metadata, 'questions') + 1;

  if (!p.fingerprint || !p.canonical) return;

  const earlier = fold.fingerprints.get(p.fingerprint);
  if (!earlier) {
    fold.fingerprints.set(p.fingerprint, {
      fingerprint: p.fingerprint,
      canonical: p.canonical,
      threadId: p.threadId,
      messageId: p.messageId,
      createdAt: at,
    });
    return;
  }

  // The same question again, in a different conversation. Within one thread a
  // repeat is just a learner rephrasing nothing; across threads it is a revisit.
  if (earlier.threadId !== p.threadId) {
    fold.link(session.id, brainNodeId.threadSession(earlier.threadId), 'DUPLICATE_OF', at, p.threadId);
  }
}

function onQaDistilled(fold: Fold, p: BrainEventPayload<'qa_distilled'>, at: string): void {
  const session = fold.threadSession(p.threadId, 'Conversation', at);
  const { extraction } = p;

  const conceptIds: string[] = [];
  for (const concept of extraction.concepts) {
    const id = fold.concept(concept.label, at, concept.okfPath);
    if (!id || conceptIds.includes(id)) continue;
    conceptIds.push(id);
    fold.updateMastery(id, afterQuestion);
    fold.activate(session.id, id, at, p.threadId);
  }
  fold.relate(conceptIds, at, p.threadId);

  for (const insight of extraction.insights) {
    const key = canonicalizeConcept(insight.text);
    if (!key) continue;
    const id = brainNodeId.insight(key);
    const node = fold.touch(id, 'insight', key, clipLabel(insight.text, 240), at);
    if (typeof node.metadata['sourceId'] !== 'string') {
      node.metadata['sourceId'] = p.threadId;
      node.metadata['messageId'] = p.messageId;
    }
    fold.link(session.id, id, 'PRODUCED', at, p.threadId);
    for (const label of insight.concepts) {
      const conceptId = fold.existingConcept(label);
      if (conceptId) fold.link(id, conceptId, 'RELATED_TO', at, p.threadId);
    }
  }

  for (const mistake of extraction.mistakes) {
    const textKey = canonicalizeConcept(mistake.text);
    if (!textKey) continue;
    const id = fold.mistake(`qa:${textKey}`, mistake.text, at, p.threadId);
    fold.link(id, session.id, 'OCCURRED_IN', at, p.threadId);
    const conceptId = mistake.concept ? fold.existingConcept(mistake.concept) : null;
    if (conceptId) fold.link(id, conceptId, 'RELATED_TO', at, p.threadId);
  }
}

function onCheckpointResult(fold: Fold, p: BrainEventPayload<'checkpoint_result'>, at: string): void {
  const project = fold.touch(
    brainNodeId.project(p.projectId),
    'project',
    p.projectId,
    clipLabel(p.projectTitle ?? 'Project'),
    at,
  );
  project.metadata['source'] = 'project';
  project.metadata['projectId'] = p.projectId;

  const stepLabel = `Step ${p.stepIndex + 1}: ${p.stepTitle}`;
  const checkpoint = fold.touch(brainNodeId.checkpoint(p.stepId), 'checkpoint', p.stepId, clipLabel(stepLabel), at);
  checkpoint.metadata['projectId'] = p.projectId;
  checkpoint.metadata['stepIndex'] = p.stepIndex;
  checkpoint.metadata['attempts'] = count(checkpoint.metadata, 'attempts') + 1;
  // Once passed, a step stays passed: a later failing run on a passed step is
  // the learner experimenting, not losing the step.
  checkpoint.metadata['passed'] = checkpoint.metadata['passed'] === true || p.passed;
  fold.link(project.id, checkpoint.id, 'CONTAINS', at, p.projectId);

  const conceptIds: string[] = [];
  for (const label of p.concepts) {
    const id = fold.concept(label, at);
    if (!id || conceptIds.includes(id)) continue;
    conceptIds.push(id);
    fold.updateMastery(id, (prev) => afterCheckpoint(prev, p.passed));
    fold.activate(project.id, id, at, p.projectId);
    fold.link(checkpoint.id, id, 'RELATED_TO', at, p.projectId);
  }
  fold.relate(conceptIds, at, p.projectId);

  if (!p.passed && p.failedLayer) {
    const what = FAILED_LAYER_LABEL[p.failedLayer] ?? p.failedLayer;
    const id = fold.mistake(
      `checkpoint:${p.stepId}:${p.failedLayer}`,
      `${stepLabel} — ${what}`,
      at,
      p.projectId,
    );
    fold.link(id, project.id, 'OCCURRED_IN', at, p.projectId);
    fold.link(id, checkpoint.id, 'RELATED_TO', at, p.projectId);
  }
}

function onMcqAttempt(fold: Fold, p: BrainEventPayload<'mcq_attempt'>, at: string): void {
  const session = fold.assessmentSession(p.assessmentId, p.conceptLabel, at);
  session.metadata['attemptNumber'] = p.attemptNumber;
  session.metadata['mcqScore'] = p.score;
  session.metadata['mcqTotal'] = p.total;
  session.metadata['mcqPassed'] = p.passed;

  const conceptId = fold.concept(p.conceptLabel, at);
  if (!conceptId) return;
  const concept = fold.nodes.get(conceptId) as BrainNode;
  concept.metadata['mcqAttempts'] = count(concept.metadata, 'mcqAttempts') + 1;
  // The gate is not graded evidence — it moves no mastery.
  fold.activate(session.id, conceptId, at, p.assessmentId);
}

function onVivaScore(fold: Fold, p: BrainEventPayload<'viva_score'>, at: string): void {
  const session = fold.assessmentSession(p.assessmentId, p.conceptLabel, at);
  session.metadata['attemptNumber'] = p.attemptNumber;
  session.metadata['vivaScore'] = p.vivaScore;

  const conceptId = fold.concept(p.conceptLabel, at);
  if (!conceptId) return;
  const concept = fold.nodes.get(conceptId) as BrainNode;
  fold.updateMastery(conceptId, (prev) => afterViva(prev, p.vivaScore, p.attemptNumber));

  // Retakes never erase the first attempt. 12 → 22 is a stronger signal than a
  // flat 22, and keeping all three numbers is what lets the brain show it.
  const firstScore = typeof concept.metadata['firstScore'] === 'number' ? concept.metadata['firstScore'] : p.vivaScore;
  const bestScore = Math.max(
    typeof concept.metadata['bestScore'] === 'number' ? concept.metadata['bestScore'] : 0,
    p.vivaScore,
  );
  concept.metadata['firstScore'] = firstScore;
  concept.metadata['bestScore'] = bestScore;
  concept.metadata['latestScore'] = p.vivaScore;
  concept.metadata['assessments'] = count(concept.metadata, 'assessments') + 1;
  concept.metadata['lastAssessedAt'] = at;

  const { edge } = fold.link(session.id, conceptId, 'ASSESSED', at, p.assessmentId);
  edge.metadata = {
    mcq_score: p.mcqScore,
    viva_score: p.vivaScore,
    attempt_number: p.attemptNumber,
    rubric_snapshot: p.rubricSnapshot,
    first_score: firstScore,
    best_score: bestScore,
    latest_score: p.vivaScore,
  };

  for (const missed of p.missedCriteria) {
    const textKey = canonicalizeConcept(missed.text);
    if (!textKey) continue;
    const id = fold.mistake(`viva:${concept.key}:${textKey}`, missed.text, at, p.assessmentId);
    fold.link(id, session.id, 'OCCURRED_IN', at, p.assessmentId);
    fold.link(id, conceptId, 'RELATED_TO', at, p.assessmentId);
  }
}

function onOfferDismissed(fold: Fold, p: BrainEventPayload<'offer_dismissed'>): void {
  const concept = fold.nodes.get(brainNodeId.concept(p.conceptKey));
  if (!concept) return;
  // Not a learning event, so `lastSeenAt` stays where it was.
  concept.metadata['offerDismissals'] = count(concept.metadata, 'offerDismissals') + 1;
}

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

export function projectBrain(events: readonly BrainEvent[]): BrainProjection {
  const ordered = [...events].sort(compareEvents);

  // The database already enforces one event per dedupe key; this makes the
  // function true on its own, so a fixture or a replayed export cannot double
  // count. The earliest occurrence wins.
  const seen = new Set<string>();
  const fold = new Fold();
  let watermark: BrainWatermark | null = null;

  for (const event of ordered) {
    if (seen.has(event.dedupeKey)) continue;
    seen.add(event.dedupeKey);
    watermark = { createdAt: event.createdAt, id: event.id };

    const at = event.createdAt;
    switch (event.kind) {
      case 'question_asked':
        onQuestionAsked(fold, event.payload, at);
        break;
      case 'qa_distilled':
        onQaDistilled(fold, event.payload, at);
        break;
      case 'checkpoint_result':
        onCheckpointResult(fold, event.payload, at);
        break;
      case 'mcq_attempt':
        onMcqAttempt(fold, event.payload, at);
        break;
      case 'viva_score':
        onVivaScore(fold, event.payload, at);
        break;
      case 'offer_dismissed':
        onOfferDismissed(fold, event.payload);
        break;
      case 'viva_answer':
        // Per-answer progress. The graded total arrives as `viva_score`, and
        // that is the event the brain learns from.
        break;
    }
  }

  for (const [id, mastery] of fold.mastery) {
    const node = fold.nodes.get(id);
    if (!node) continue;
    node.score = roundMastery(mastery.score);
    node.confidence = roundMastery(mastery.confidence);
  }

  const nodes = [...fold.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...fold.edges.values()]
    .map((edge) => ({ ...edge, weight: roundMastery(edge.weight) }))
    .sort(
      (a, b) =>
        (a.src < b.src ? -1 : a.src > b.src ? 1 : 0) ||
        (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    );
  const fingerprints = [...fold.fingerprints.values()].sort((a, b) =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
  );

  return { nodes, edges, fingerprints, watermark };
}
