import {
  GeneratedAssessment,
  GraderOutput,
  VIVA_COUNT,
  assessmentOffers,
  brainNodeId,
  buildGeneratorRequest,
  buildGraderRequest,
  combineDualGrades,
  graderContext,
  isStuck,
  retakeCooldownMs,
  MCQ_PASS,
  MCQ_RETRY_MS,
  scoreFromCriteria,
  scoreMcq,
  validateGeneratedAssessment,
  vivaPassed,
} from '@ai-edu/core';
import type {
  AssessmentStatus,
  BrainNode,
  CriterionGrade,
  GradeResult,
  PublicAssessment,
  PublicMcq,
  VivaQuestion,
} from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';
import type { LLMProvider } from '@ai-edu/llm';

import { loadProjection, recordBrainEvent } from './brain.js';
import { checkBudget, db, recordUsage } from './db.js';

/**
 * The assessment runtime: writing a sitting, marking the gate, grading the
 * viva, and writing the results into the brain.
 *
 * Everything that decides a mark lives in packages/core and is pure: the
 * gate is scored by option index, the viva by summing the rubric criteria the
 * grader found evidence for. This file loads, calls the model, and records.
 * Every model call goes through the daily budget and the usage ledger like any
 * other; every viva answer goes through the security gateway before a model
 * sees it (that happens in the route, which owns the refusal shape).
 */

/* ------------------------------------------------------------------ *
 * Rows and views
 * ------------------------------------------------------------------ */

interface AssessmentRow {
  id: string;
  user_id: string;
  concept_key: string;
  concept_label: string;
  attempt_number: number;
  status: AssessmentStatus;
  questions: PublicAssessment;
  mcq_answers: number[] | null;
  mcq_score: number | null;
  viva_score: number | null;
  report: AssessmentReport | null;
  retake_after: string | null;
  created_at: string;
  completed_at: string | null;
}

interface AnswerRow {
  question_index: number;
  answer: string;
  score: number;
  grade: GradeResult;
}

export interface AnsweredQuestion {
  questionIndex: number;
  answer: string;
  score: number;
  max: number;
  criteria: CriterionGrade[];
}

export interface AssessmentReport {
  total: number;
  max: number;
  passed: boolean;
  questions: Array<{ index: number; prompt: string; score: number; max: number; criteria: CriterionGrade[] }>;
}

/** What the learner's browser is sent. Never the gate's answers before it is marked. */
export interface AssessmentView {
  id: string;
  conceptKey: string;
  conceptLabel: string;
  attemptNumber: number;
  status: AssessmentStatus;
  createdAt: string;
  completedAt: string | null;
  mcq: PublicMcq[];
  /** Present once the gate has been marked — and only then. */
  mcqResult: {
    score: number;
    total: number;
    passed: boolean;
    answers: number[];
    correctIndexes: number[];
    explanations: string[];
  } | null;
  /** The viva, once the gate is passed. Rubrics included: they are shown before answering. */
  viva: VivaQuestion[];
  answers: AnsweredQuestion[];
  /** The first unanswered viva question, or null. */
  nextQuestion: number | null;
  vivaScore: number | null;
  report: AssessmentReport | null;
  retakeAfter: string | null;
  /** Fourth sitting or later: suggest trying another concept first. */
  stuck: boolean;
}

const COLUMNS =
  'id, user_id, concept_key, concept_label, attempt_number, status, questions, mcq_answers, mcq_score, viva_score, report, retake_after, created_at, completed_at';

async function loadRow(userId: string, id: string): Promise<AssessmentRow | null> {
  const { data, error } = await db().from('assessments').select(COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`could not load assessment: ${error.message}`);
  return (data as AssessmentRow | null) ?? null;
}

async function loadAnswers(userId: string, id: string): Promise<AnswerRow[]> {
  const { data, error } = await db()
    .from('assessment_answers')
    .select('question_index, answer, score, grade')
    .eq('assessment_id', id)
    .eq('user_id', userId)
    .order('question_index', { ascending: true });
  if (error) throw new Error(`could not load answers: ${error.message}`);
  return (data ?? []) as AnswerRow[];
}

async function loadKey(id: string): Promise<{ correctIndexes: number[]; explanations: string[] } | null> {
  const { data, error } = await db()
    .from('assessment_keys')
    .select('correct_indexes, explanations')
    .eq('assessment_id', id)
    .maybeSingle();
  if (error) throw new Error(`could not load key: ${error.message}`);
  if (!data) return null;
  return {
    correctIndexes: (data.correct_indexes ?? []) as number[],
    explanations: (data.explanations ?? []) as string[],
  };
}

async function toView(userId: string, row: AssessmentRow): Promise<AssessmentView> {
  // Marked only if there really are answers. This line is what keeps the key
  // off the page, so it does not trust a column merely being non-null.
  const marked = Array.isArray(row.mcq_answers) && row.mcq_answers.length > 0;
  const [answers, key] = await Promise.all([
    row.status === 'viva' || row.status === 'graded' ? loadAnswers(userId, row.id) : Promise.resolve([]),
    marked ? loadKey(row.id) : Promise.resolve(null),
  ]);
  const showViva = row.status === 'viva' || row.status === 'graded';
  const answered = new Set(answers.map((a) => a.question_index));
  const viva = showViva ? row.questions.viva : [];
  const next = showViva && row.status === 'viva' ? viva.findIndex((_, i) => !answered.has(i)) : -1;

  return {
    id: row.id,
    conceptKey: row.concept_key,
    conceptLabel: row.concept_label,
    attemptNumber: row.attempt_number,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    mcq: row.questions.mcq,
    mcqResult:
      marked && key
        ? {
            score: row.mcq_score ?? 0,
            total: key.correctIndexes.length,
            passed: (row.mcq_score ?? 0) >= MCQ_PASS,
            answers: row.mcq_answers ?? [],
            correctIndexes: key.correctIndexes,
            explanations: key.explanations,
          }
        : null,
    viva,
    answers: answers.map((a) => ({
      questionIndex: a.question_index,
      answer: a.answer,
      score: a.score,
      max: a.grade.max,
      criteria: a.grade.criteria,
    })),
    nextQuestion: next >= 0 ? next : null,
    vivaScore: row.viva_score,
    report: row.report,
    retakeAfter: row.retake_after,
    stuck: isStuck(row.attempt_number),
  };
}

export async function getAssessment(userId: string, id: string): Promise<AssessmentView | null> {
  const row = await loadRow(userId, id);
  return row ? toView(userId, row) : null;
}

/* ------------------------------------------------------------------ *
 * Starting a sitting
 * ------------------------------------------------------------------ */

export type StartResult =
  | { kind: 'ok'; view: AssessmentView; resumed: boolean }
  | { kind: 'not_found' }
  | { kind: 'cooldown'; retakeAfter: string }
  | { kind: 'budget'; message: string }
  | { kind: 'no_provider'; message: string }
  | { kind: 'generation_failed'; message: string };

/** Attempts at a valid generation before giving up. The repair path inside `structured` comes first. */
const GENERATION_ATTEMPTS = 2;

/** What the generator is told about the learner and this concept, from the brain. */
async function generatorContext(userId: string, concept: BrainNode) {
  const { nodes, edges } = await loadProjection(userId, {
    nodeKinds: ['insight', 'mistake', 'session'],
    edgeKinds: ['RELATED_TO', 'ACTIVATED'],
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Everything wired INTO the concept: insights and mistakes relate to it,
  // sessions activated it. Most recent first.
  const into = (kind: BrainNode['kind'], edgeKind: 'RELATED_TO' | 'ACTIVATED') =>
    edges
      .filter((e) => e.kind === edgeKind && e.dst === concept.id)
      .map((e) => byId.get(e.src))
      .filter((n): n is BrainNode => n?.kind === kind)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return {
    insights: into('insight', 'RELATED_TO').map((n) => n.label),
    mistakes: into('mistake', 'RELATED_TO')
      .sort((a, b) => Number(b.metadata['occurrences'] ?? 0) - Number(a.metadata['occurrences'] ?? 0))
      .map((n) => n.label),
    questions: into('session', 'ACTIVATED').map((n) => n.label),
  };
}

async function skillLevelOf(userId: string): Promise<string | null> {
  const { data } = await db().from('profiles').select('default_skill').eq('id', userId).maybeSingle();
  return typeof data?.default_skill === 'string' ? data.default_skill : null;
}

export async function startAssessment(userId: string, conceptKey: string): Promise<StartResult> {
  const { data: conceptRow } = await db()
    .from('brain_nodes')
    .select('id, kind, key, label, score, confidence, metadata, first_seen_at, last_seen_at')
    .eq('user_id', userId)
    .eq('id', brainNodeId.concept(conceptKey))
    .maybeSingle();
  if (!conceptRow) return { kind: 'not_found' };
  const concept: BrainNode = {
    id: conceptRow.id,
    kind: 'concept',
    key: conceptRow.key,
    label: conceptRow.label,
    score: conceptRow.score === null ? null : Number(conceptRow.score),
    confidence: conceptRow.confidence === null ? null : Number(conceptRow.confidence),
    metadata: conceptRow.metadata ?? {},
    firstSeenAt: conceptRow.first_seen_at,
    lastSeenAt: conceptRow.last_seen_at,
  };

  const { data: history, error: historyError } = await db()
    .from('assessments')
    .select(COLUMNS)
    .eq('user_id', userId)
    .eq('concept_key', conceptKey)
    .order('attempt_number', { ascending: false });
  if (historyError) throw new Error(`could not load attempts: ${historyError.message}`);
  const attempts = (history ?? []) as AssessmentRow[];
  const latest = attempts[0];

  // A sitting already under way is resumed, never duplicated.
  if (latest && (latest.status === 'mcq' || latest.status === 'viva')) {
    return { kind: 'ok', view: await toView(userId, latest), resumed: true };
  }
  if (latest?.retake_after && Date.parse(latest.retake_after) > Date.now()) {
    return { kind: 'cooldown', retakeAfter: latest.retake_after };
  }

  const budget = await checkBudget(userId);
  if (budget.exceeded) {
    return { kind: 'budget', message: `Daily allowance of $${budget.limitUSD.toFixed(2)} reached.` };
  }
  let provider: LLMProvider;
  try {
    provider = createProviderForTask('assessment');
  } catch (err) {
    return { kind: 'no_provider', message: err instanceof Error ? err.message : 'No provider configured.' };
  }

  const [context, skillLevel] = await Promise.all([generatorContext(userId, concept), skillLevelOf(userId)]);
  const request = buildGeneratorRequest({
    modelId: provider.modelId,
    concept: {
      label: concept.label,
      okfPath: typeof concept.metadata['okfPath'] === 'string' ? concept.metadata['okfPath'] : null,
    },
    skillLevel,
    ...context,
    avoidTopics: attempts.flatMap((a) => a.questions.viva.map((q) => q.topic)).filter(Boolean),
  });

  let validated: ReturnType<typeof validateGeneratedAssessment> | null = null;
  let lastIssues: string[] = [];
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const result = await provider.structured(request, GeneratedAssessment);
      void recordUsage({
        userId,
        task: 'assessment:generate',
        provider: provider.id,
        model: provider.modelId,
        usage: result.usage,
        latencyMs: Date.now() - started,
      });
      validated = validateGeneratedAssessment(result.data);
      if (validated.ok) break;
      lastIssues = validated.issues;
    } catch (err) {
      lastIssues = [err instanceof Error ? err.message : String(err)];
    }
  }
  if (!validated?.ok) {
    console.error('[assessment] generation failed:', lastIssues.join('; '));
    return { kind: 'generation_failed', message: 'Could not write a fair test for this concept just now. Try again shortly.' };
  }

  const { data: inserted, error: insertError } = await db()
    .from('assessments')
    .insert({
      user_id: userId,
      concept_key: conceptKey,
      concept_label: concept.label,
      attempt_number: (latest?.attempt_number ?? 0) + 1,
      status: 'mcq',
      questions: validated.assessment,
    })
    .select(COLUMNS)
    .single();
  if (insertError || !inserted) throw new Error(`could not save assessment: ${insertError?.message}`);
  const row = inserted as AssessmentRow;

  const { error: keyError } = await db().from('assessment_keys').insert({
    assessment_id: row.id,
    correct_indexes: validated.key.correctIndexes,
    explanations: validated.key.explanations,
  });
  if (keyError) {
    // A gate with no answer key cannot be marked. Remove the sitting rather
    // than leave the learner one they can never finish.
    await db().from('assessments').delete().eq('id', row.id).eq('user_id', userId);
    throw new Error(`could not save answer key: ${keyError.message}`);
  }

  return { kind: 'ok', view: await toView(userId, row), resumed: false };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

export type McqSubmitResult =
  | { kind: 'ok'; view: AssessmentView }
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string };

export async function submitMcq(userId: string, id: string, answers: number[]): Promise<McqSubmitResult> {
  const row = await loadRow(userId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'mcq') return { kind: 'conflict', message: 'This multiple-choice round has already been marked.' };

  const key = await loadKey(id);
  if (!key) throw new Error('assessment has no answer key');
  const result = scoreMcq(key, answers);
  const retakeAfter = result.passed ? null : new Date(Date.now() + MCQ_RETRY_MS).toISOString();

  // Conditional on still being in the gate, so two submissions cannot both mark it.
  const { data: updated, error } = await db()
    .from('assessments')
    .update({
      mcq_answers: answers,
      mcq_score: result.score,
      status: result.passed ? 'viva' : 'mcq_failed',
      retake_after: retakeAfter,
      ...(result.passed ? {} : { completed_at: new Date().toISOString() }),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'mcq')
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`could not mark the gate: ${error.message}`);
  if (!updated) return { kind: 'conflict', message: 'This multiple-choice round has already been marked.' };

  void recordBrainEvent({
    userId,
    kind: 'mcq_attempt',
    sourceKind: 'assessment',
    sourceId: id,
    dedupeKey: `mcq:${id}`,
    payload: {
      assessmentId: id,
      conceptKey: row.concept_key,
      conceptLabel: row.concept_label,
      attemptNumber: row.attempt_number,
      score: result.score,
      total: result.total,
      passed: result.passed,
    },
  });

  return { kind: 'ok', view: await toView(userId, updated as AssessmentRow) };
}

/* ------------------------------------------------------------------ *
 * The viva
 * ------------------------------------------------------------------ */

export type VivaSubmitResult =
  | { kind: 'ok'; view: AssessmentView; grade: AnsweredQuestion }
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | { kind: 'budget'; message: string }
  | { kind: 'no_provider'; message: string }
  | { kind: 'grading_failed'; message: string };

async function gradeOnce(provider: LLMProvider, userId: string, question: VivaQuestion, answer: string): Promise<GradeResult> {
  const context = graderContext(question, answer);
  const started = Date.now();
  const result = await provider.structured(buildGraderRequest(provider.modelId, context), GraderOutput);
  void recordUsage({
    userId,
    task: 'assessment:grade',
    provider: provider.id,
    model: provider.modelId,
    usage: result.usage,
    latencyMs: Date.now() - started,
  });
  return scoreFromCriteria(context, result.data);
}

/**
 * Grade one viva answer and, if it was the last, close the sitting.
 * `answer` must already have been through the security gateway.
 */
export async function submitViva(
  userId: string,
  id: string,
  questionIndex: number,
  answer: string,
): Promise<VivaSubmitResult> {
  const row = await loadRow(userId, id);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'viva') return { kind: 'conflict', message: 'This viva is not open for answers.' };
  const question = row.questions.viva[questionIndex];
  if (!question) return { kind: 'not_found' };

  const already = await loadAnswers(userId, id);
  if (already.some((a) => a.question_index === questionIndex)) {
    return { kind: 'conflict', message: 'That question has already been answered and graded.' };
  }

  const budget = await checkBudget(userId);
  if (budget.exceeded) return { kind: 'budget', message: `Daily allowance of $${budget.limitUSD.toFixed(2)} reached.` };
  let provider: LLMProvider;
  try {
    provider = createProviderForTask('assessment');
  } catch (err) {
    return { kind: 'no_provider', message: err instanceof Error ? err.message : 'No provider configured.' };
  }

  let grade: GradeResult;
  try {
    // First sitting on a concept: graded twice, the lower stands. A wrong pass
    // is the failure that hurts, and the first sitting is where it costs most.
    grade =
      row.attempt_number === 1
        ? combineDualGrades(...((await Promise.all([
            gradeOnce(provider, userId, question, answer),
            gradeOnce(provider, userId, question, answer),
          ])) as [GradeResult, GradeResult]))
        : await gradeOnce(provider, userId, question, answer);
  } catch (err) {
    console.error('[assessment] grading failed:', err instanceof Error ? err.message : err);
    return { kind: 'grading_failed', message: 'Could not grade that answer just now. Your answer was not used — try again.' };
  }

  const { error: insertError } = await db().from('assessment_answers').insert({
    assessment_id: id,
    user_id: userId,
    question_index: questionIndex,
    answer,
    grade,
    score: grade.score,
  });
  if (insertError) {
    if (insertError.code === '23505') {
      return { kind: 'conflict', message: 'That question has already been answered and graded.' };
    }
    throw new Error(`could not save the answer: ${insertError.message}`);
  }

  void recordBrainEvent({
    userId,
    kind: 'viva_answer',
    sourceKind: 'assessment',
    sourceId: id,
    dedupeKey: `viva:${id}:${questionIndex}`,
    payload: { assessmentId: id, conceptKey: row.concept_key, questionIndex, score: grade.score },
  });

  const answers = await loadAnswers(userId, id);
  if (answers.length >= VIVA_COUNT) await closeViva(userId, row, answers);

  // Reloaded rather than patched up, so the view is right whichever request
  // closed the sitting.
  const latest = (await loadRow(userId, id)) ?? row;
  return {
    kind: 'ok',
    view: await toView(userId, latest),
    grade: { questionIndex, answer, score: grade.score, max: grade.max, criteria: grade.criteria },
  };
}

/** All five answered: total, report, retake timing, and the result into the brain. */
async function closeViva(userId: string, row: AssessmentRow, answers: AnswerRow[]): Promise<void> {
  const total = answers.reduce((sum, a) => sum + a.score, 0);
  const passed = vivaPassed(total);
  const report: AssessmentReport = {
    total,
    max: VIVA_COUNT * 5,
    passed,
    questions: answers.map((a) => ({
      index: a.question_index,
      prompt: row.questions.viva[a.question_index]?.prompt ?? '',
      score: a.score,
      max: a.grade.max,
      criteria: a.grade.criteria,
    })),
  };

  // Conditional on still being open, so two final answers landing together
  // close it once and write the score into the brain once.
  const { data: closed, error } = await db()
    .from('assessments')
    .update({
      status: 'graded',
      viva_score: total,
      report,
      completed_at: new Date().toISOString(),
      retake_after: passed ? null : new Date(Date.now() + retakeCooldownMs(row.attempt_number)).toISOString(),
    })
    .eq('id', row.id)
    .eq('user_id', userId)
    .eq('status', 'viva')
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`could not close the viva: ${error.message}`);
  if (!closed) return;

  void recordBrainEvent({
    userId,
    kind: 'viva_score',
    sourceKind: 'assessment',
    sourceId: row.id,
    dedupeKey: `viva_score:${row.id}`,
    payload: {
      assessmentId: row.id,
      conceptKey: row.concept_key,
      conceptLabel: row.concept_label,
      attemptNumber: row.attempt_number,
      mcqScore: row.mcq_score ?? 0,
      vivaScore: total,
      // Frozen with the score, so it can be read against the rubric it was marked by.
      rubricSnapshot: row.questions.viva.map((q) => ({ prompt: q.prompt, rubric: q.rubric })),
      missedCriteria: answers.flatMap((a) =>
        a.grade.criteria.filter((c) => !c.met).map((c) => ({ questionIndex: a.question_index, criterionId: c.id, text: c.text })),
      ),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Offers
 * ------------------------------------------------------------------ */

export interface AssessmentOffer {
  conceptKey: string;
  label: string;
  score: number;
}

export async function listOffers(userId: string): Promise<AssessmentOffer[]> {
  const { nodes } = await loadProjection(userId, { nodeKinds: ['concept'], edgeKinds: [] });
  return assessmentOffers(nodes, new Date().toISOString()).map((node) => ({
    conceptKey: node.key,
    label: node.label,
    score: node.score ?? 0,
  }));
}

/** "Not now." Recorded in the brain; after two, the concept stops being offered. */
export async function dismissOffer(userId: string, conceptKey: string): Promise<void> {
  // A dismissal belongs to no sitting; it gets an id of its own so the event
  // still names a source, as every event must.
  await recordBrainEvent({
    userId,
    kind: 'offer_dismissed',
    sourceKind: 'assessment',
    sourceId: crypto.randomUUID(),
    dedupeKey: `dismiss:${conceptKey}:${crypto.randomUUID()}`,
    payload: { conceptKey },
  });
}
