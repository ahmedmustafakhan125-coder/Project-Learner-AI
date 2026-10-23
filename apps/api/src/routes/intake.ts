import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BriefRejectedError,
  CompiledQuery,
  ProfileId,
  ScopeSignals,
  answerSignals,
  applyAnswers,
  buildPinTable,
  classifyQuery,
  compileQuery,
  detectProfile,
  fingerprintRequest,
  generateBrief,
  generatePlannedBlueprint,
  getProfile,
  parseStoredBlueprint,
  parseStoredDossier,
  parseStoredStackBrief,
  pickTemplate,
  scopeQuestions,
  scopedSlots,
  scoreComplexity,
  slotsFor,
  verifyStackBrief,
} from '@ai-edu/core';
import type { DocRef, PlannedBlueprint, Profile, ResearchDossier, Slots, StackBrief } from '@ai-edu/core';
import {
  PROJECT_TIERS,
  ProjectGenerationUnavailableError,
  createProviderForStage,
  createProviderForTask,
  getModel,
  meterUsage,
} from '@ai-edu/llm';
import type { LLMUsage, ProjectStage, ProjectTier, StageProvider } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { memoryQueryFor, recallMemory } from '../brain.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { loadIntake, updateIntake } from '../intake.js';
import type { Intake } from '../intake.js';
import { techCards } from '../knowledge.js';
import { rateLimitConfig } from '../rateLimit.js';
import { runProjectResearch } from '../research.js';

/**
 * Project intake (docs/project-learner.md §12), registered only with
 * PROJECT_LEARNER on.
 *
 *   POST  /api/projects/intake                          scope: profile and tier, by code, and round-2 questions
 *   POST  /api/projects/intake/:id/answers              round 2's answers; the tier is scored again
 *   PATCH /api/projects/intake/:id/scope                change the profile, move the tier a step
 *   POST  /api/projects/intake/:id/research             the project dossier
 *   POST  /api/projects/intake/:id/stack-brief          the Stack Brief (again to regenerate)
 *   POST  /api/projects/intake/:id/stack-brief/approve
 *   POST  /api/projects/intake/:id/blueprint            the plan, against the approved brief
 *   GET   /api/projects/:id/stack                       a project's brief and sources
 *
 * `POST /api/projects { intakeId }` (routes/projects.ts) builds the project
 * from this row. Every stage reads what came before from the row, never from
 * the request body, so a browser cannot approve a brief no model wrote.
 *
 * A very similar project already stored (any learner's: same profile, tier
 * and named technologies, nearly the same words) is adapted instead of
 * planned again: its dossier and brief are copied and re-verified with no
 * call, and its plan is rewritten by one Sonnet call instead of Opus.
 */

/** Regenerations per intake, of the brief and of the plan (§9). */
export const MAX_REGENERATIONS = 2;

/** How many recent projects of the same kind and size are compared for a template. */
const TEMPLATE_CANDIDATES = 50;

const IntakeBody = z.object({ compiled: CompiledQuery });
const ScopeBody = z
  .object({
    profile: ProfileId.optional(),
    tierStep: z.union([z.literal(-1), z.literal(1)]).optional(),
  })
  .refine((b) => b.profile !== undefined || b.tierStep !== undefined, { message: 'Nothing to change.' });
const AnswersBody = z.object({ answers: z.record(z.string(), z.string().max(500)) });
const BlueprintBody = z.object({ teachDeployment: z.boolean().default(false) });
const Uuid = z.string().uuid();

const ResearchSummary = z.object({
  limitedSources: z.boolean(),
  fromCards: z.array(z.string()).default([]),
  fromCache: z.array(z.string()).default([]),
  researched: z.array(z.string()).default([]),
  failed: z.array(z.string()).default([]),
  uncovered: z.array(z.string()).default([]),
  /** Copied from the template project; nothing was read for this one. */
  fromTemplate: z.boolean().default(false),
});
type ResearchSummary = z.infer<typeof ResearchSummary>;

type Refusal = { status: number; body: { error: string; message: string; [key: string]: unknown } };

const refuse = (reply: FastifyReply, r: Refusal) => reply.code(r.status).send(r.body);

const spent = (u: LLMUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0;

/** The references a brief cites, in the order its layers cite them. */
export function citedSources(brief: StackBrief | null, dossier: ResearchDossier | null): DocRef[] {
  if (!brief || !dossier) return [];
  const ids = [...new Set(brief.layers.flatMap((l) => l.docRefs))];
  return ids.map((id) => dossier.docRefs.find((r) => r.id === id)).filter((r): r is DocRef => r !== undefined);
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

/**
 * The newest very similar stored project, if any. Any learner's project may
 * serve; its request is compared here, on the server, and never returned.
 */
async function findTemplate(compiled: CompiledQuery, profile: Profile, tier: ProjectTier): Promise<string | null> {
  const { data: projects, error } = await db()
    .from('projects')
    .select('id, intake_id')
    .eq('project_profile', profile.id)
    .eq('complexity_tier', tier)
    .not('stack_brief', 'is', null)
    .not('intake_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(TEMPLATE_CANDIDATES);
  if (error || !projects?.length) return null;

  const { data: intakes } = await db()
    .from('project_intakes')
    .select('id, compiled_query')
    .in('id', projects.map((p) => p.intake_id as string));
  const requests = new Map((intakes ?? []).map((i) => [i.id as string, i.compiled_query]));

  const candidates = projects.flatMap((p) => {
    const request = CompiledQuery.safeParse(requests.get(p.intake_id as string));
    return request.success ? [{ fingerprint: fingerprintRequest(request.data, profile, tier), value: p.id as string }] : [];
  });
  return pickTemplate(fingerprintRequest(compiled, profile, tier), candidates)?.value ?? null;
}

interface Template {
  id: string;
  brief: StackBrief;
  dossier: ResearchDossier | null;
  blueprint: PlannedBlueprint;
}

async function loadTemplate(projectId: string | null): Promise<Template | null> {
  if (!projectId) return null;
  const { data } = await db().from('projects').select('id, blueprint, stack_brief, dossier').eq('id', projectId).maybeSingle();
  if (!data) return null;
  const brief = parseStoredStackBrief(data.stack_brief);
  const blueprint = parseStoredBlueprint(data.blueprint);
  if (!brief || !blueprint) return null;
  return { id: data.id, brief, dossier: parseStoredDossier(data.dossier), blueprint: blueprint as PlannedBlueprint };
}

/* ------------------------------------------------------------------ *
 * Shared checks
 * ------------------------------------------------------------------ */

/** The weekly project allowance (§11); Q&A keeps its own. */
async function budgetRefusal(userId: string): Promise<Refusal | null> {
  const budget = await checkBudget(userId, 'project');
  if (!budget.exceeded) return null;
  return {
    status: 429,
    body: {
      error: 'project_budget_exceeded',
      message: `Weekly project allowance of $${budget.limitUSD.toFixed(2)} reached. Questions still work.`,
    },
  };
}

function stageFor(stage: ProjectStage, tier: ProjectTier): { ok: true; call: StageProvider } | { ok: false; refusal: Refusal } {
  try {
    return { ok: true, call: createProviderForStage(stage, tier) };
  } catch (err) {
    return {
      ok: false,
      refusal: {
        status: 503,
        body:
          err instanceof ProjectGenerationUnavailableError
            ? { error: 'project_generation_unavailable', message: 'Project generation is unavailable right now. Please try again later.' }
            : { error: 'no_provider', message: err instanceof Error ? err.message : 'unavailable' },
      },
    };
  }
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'not_found', message: 'No such intake, or it expired. Start the project again.' });
}

function wrongStage(reply: FastifyReply, message: string) {
  return reply.code(409).send({ error: 'intake_out_of_order', message });
}

/** The learner's text, screened, for the model calls that read it. */
async function screened(request: FastifyRequest, reply: FastifyReply, compiled: CompiledQuery, userId: string) {
  try {
    return {
      ...compiled,
      originalQuery: await screenOrThrow(compiled.originalQuery, `intake:${userId}:query`),
      text: await screenOrThrow(compiled.text, `intake:${userId}`),
    };
  } catch (err) {
    const refusal = gatewayErrorReply(err);
    if (!refusal) throw err;
    request.log.warn({ userId, ...refusal.body }, 'intake prompt refused');
    await reply.code(refusal.status).send(refusal.body);
    return null;
  }
}

const ROUND_ONE_SLOTS = new Set(slotsFor('project_generation').map((s) => s.key));

/** Tier and profile facts the message states, added to the slots without replacing any the interview settled. */
function withStated(slots: Slots, stated: Record<string, string>): Slots {
  const merged: Slots = { ...slots };
  for (const [key, value] of Object.entries(stated)) {
    if (!ROUND_ONE_SLOTS.has(key) && !merged[key]?.value?.trim()) merged[key] = { value, source: 'query' };
  }
  return merged;
}

/** The compiled query with the tier and profile slots rendered too, so the brief and the plan read them. */
function recompile(compiled: CompiledQuery, slots: Slots, tier: ProjectTier, profile: Profile): CompiledQuery {
  return compileQuery({
    intent: compiled.intent,
    rawQuery: compiled.originalQuery,
    slots,
    attachments: compiled.attachments,
    skipped: compiled.partial,
    slotDefs: scopedSlots(tier, profile),
  });
}

function scope(intake: Pick<Intake, 'signals' | 'compiled'>, profile: Profile, tierStep: -1 | 1 | undefined) {
  const score = scoreComplexity(intake.signals, profile, intake.compiled.slots);
  if (!tierStep) return { tier: score.tier, reasons: score.reasons, overTime: score.overTime };
  const index = Math.min(PROJECT_TIERS.length - 1, Math.max(0, PROJECT_TIERS.indexOf(score.tier) + tierStep));
  const tier = PROJECT_TIERS[index]!;
  if (tier === score.tier) return { tier, reasons: score.reasons, overTime: score.overTime };
  return { tier, reasons: [...score.reasons, `Moved ${tierStep > 0 ? 'up' : 'down'} one step by you`], overTime: score.overTime };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- scope ---------------- */

  app.post('/api/projects/intake', { preHandler: requireAuth, config: rateLimitConfig.generation }, async (request, reply) => {
    const user = userOf(request);
    const parsed = IntakeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    const compiled = await screened(request, reply, parsed.data.compiled, user.id);
    if (!compiled) return reply;

    const refusal = await budgetRefusal(user.id);
    if (refusal) return refuse(reply, refusal);

    // Expired, unapproved intakes go when a new one starts; nothing schedules it in the database.
    void db()
      .rpc('purge_expired_intakes')
      .then(({ error }) => error && console.warn('[intake] purge failed:', error.message));

    // The classify call reports what the learner said; code decides the profile and tier (§5).
    let signals: ScopeSignals = ScopeSignals.parse({});
    let stated: Record<string, string> = {};
    let provider = null;
    try {
      provider = createProviderForTask('interview');
    } catch (err) {
      request.log.warn({ err }, 'intake scoping without signals: no interview model');
    }
    if (provider) {
      const metered = meterUsage(provider);
      const started = Date.now();
      try {
        const classification = await classifyQuery({ provider: metered.provider, rawQuery: compiled.text, scoping: true });
        signals = classification.signals ?? signals;
        if (classification.intent === 'project_generation') stated = classification.extracted;
      } catch (err) {
        // Scoring from the slots alone is a weaker tier, not a failed project.
        request.log.warn({ err }, 'intake scoping without signals: classify failed');
      }
      if (spent(metered.usage())) {
        void recordUsage({
          userId: user.id,
          task: 'project:scope',
          provider: provider.id,
          model: provider.modelId,
          usage: metered.usage(),
          latencyMs: Date.now() - started,
        });
      }
    }

    // Facts the message states for the tier and profile slots join them, so
    // round 2 never asks what the learner already said.
    const slots = withStated(compiled.slots, stated);
    const detection = detectProfile(signals, slots);
    const profile = getProfile(detection.profile);
    const { tier, reasons, overTime } = scope({ signals, compiled: { ...compiled, slots } }, profile, undefined);
    const scoped = recompile(compiled, slots, tier, profile);
    const templateId = await findTemplate(scoped, profile, tier);

    const { data, error } = await db()
      .from('project_intakes')
      .insert({
        user_id: user.id,
        compiled_query: scoped,
        signals,
        project_profile: profile.id,
        profile_confidence: detection.confidence,
        tier,
        tier_reasons: reasons,
        template_project_id: templateId,
        status: 'scoped',
      })
      .select('id')
      .single();
    if (error || !data) return reply.code(500).send({ error: 'persist_failed', message: error?.message ?? 'no row' });

    return reply.code(201).send({
      intakeId: data.id,
      profile: profile.id,
      confidence: detection.confidence,
      alternatives: detection.alternatives,
      tier,
      reasons,
      overTime,
      adapted: templateId !== null,
      // Round 2, for a project big enough to have one (§5); written by code, no call.
      questions: scopeQuestions({ tier, profile, slots, signals }),
    });
  });

  app.post<{ Params: { id: string } }>('/api/projects/intake/:id/answers', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const parsed = AnswersBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    const intake = await loadIntake(request.params.id, user.id);
    if (!intake) return notFound(reply);
    if (intake.row.status !== 'scoped') return wrongStage(reply, 'Answer these before research starts.');

    // Only what round 2 asked is taken, worked out again from the row rather
    // than trusted from the body.
    const { compiled } = intake;
    const asked = new Set(
      scopeQuestions({ tier: intake.row.tier, profile: intake.profile, slots: compiled.slots, signals: intake.signals }).map((q) => q.slot),
    );
    const answers = Object.fromEntries(Object.entries(parsed.data.answers).filter(([slot]) => asked.has(slot)));
    const slots = applyAnswers(compiled.slots, answers);

    // The answers are facts the tier is scored from, like the message's own signals.
    const signals = answerSignals(intake.signals, answers);
    const { tier, reasons, overTime } = scoreComplexity(signals, intake.profile, slots);
    const scoped = recompile(compiled, slots, tier, intake.profile);
    const templateId = await findTemplate(scoped, intake.profile, tier);

    const ok = await updateIntake(intake, user.id, {
      compiled_query: scoped,
      signals,
      tier,
      tier_reasons: reasons,
      template_project_id: templateId,
    });
    if (!ok) return reply.code(500).send({ error: 'persist_failed', message: 'Could not save the answers.' });
    const detection = detectProfile(signals, slots);
    return reply.send({
      profile: intake.profile.id,
      confidence: intake.profile.id === detection.profile ? detection.confidence : 1,
      alternatives: [detection.profile, ...detection.alternatives].filter((id) => id !== intake.profile.id).slice(0, 3),
      tier,
      reasons,
      overTime,
      adapted: templateId !== null,
    });
  });

  app.patch<{ Params: { id: string } }>('/api/projects/intake/:id/scope', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const parsed = ScopeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

    const intake = await loadIntake(request.params.id, user.id);
    if (!intake) return notFound(reply);
    if (intake.row.status === 'approved') return wrongStage(reply, 'The stack is already approved; start a new project to change its scope.');

    const profile = getProfile(parsed.data.profile ?? intake.profile.id);
    const { tier, reasons, overTime } = scope(intake, profile, parsed.data.tierStep);
    const templateId = await findTemplate(intake.compiled, profile, tier);

    // What research and the brief were written for no longer holds.
    const ok = await updateIntake(intake, user.id, {
      project_profile: profile.id,
      tier,
      tier_reasons: reasons,
      template_project_id: templateId,
      dossier: null,
      research_summary: null,
      brief: null,
      brief_revisions: [],
      blueprint: null,
      blueprint_revisions: 0,
      status: 'scoped',
    });
    if (!ok) return reply.code(500).send({ error: 'persist_failed', message: 'Could not save the change.' });
    const detection = detectProfile(intake.signals, intake.compiled.slots);
    return reply.send({
      profile: profile.id,
      confidence: profile.id === detection.profile ? detection.confidence : 1,
      alternatives: [detection.profile, ...detection.alternatives].filter((id) => id !== profile.id).slice(0, 3),
      tier,
      reasons,
      overTime,
      adapted: templateId !== null,
    });
  });

  /* ---------------- research ---------------- */

  app.post<{ Params: { id: string } }>(
    '/api/projects/intake/:id/research',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const intake = await loadIntake(request.params.id, user.id);
      if (!intake) return notFound(reply);

      // Research runs once per scope; asking again returns what it found.
      const stored = parseStoredDossier(intake.row.dossier);
      const storedSummary = ResearchSummary.safeParse(intake.row.research_summary);
      if (stored && storedSummary.success) return reply.send({ dossier: stored, ...storedSummary.data });
      if (intake.row.status === 'approved') return wrongStage(reply, 'The stack is already approved.');

      const template = await loadTemplate(intake.row.template_project_id);
      if (template?.dossier) {
        const summary: ResearchSummary = { ...ResearchSummary.parse({ limitedSources: false }), fromTemplate: true };
        await updateIntake(intake, user.id, { dossier: template.dossier, research_summary: summary, status: 'researched' });
        return reply.send({ dossier: template.dossier, ...summary });
      }

      const refusal = await budgetRefusal(user.id);
      if (refusal) return refuse(reply, refusal);

      const compiled = await screened(request, reply, intake.compiled, user.id);
      if (!compiled) return reply;

      const started = Date.now();
      try {
        const run = await runProjectResearch({ compiled, profile: intake.profile, tier: intake.row.tier, slots: compiled.slots });
        if (run.model && spent(run.usage)) {
          void recordUsage({
            userId: user.id,
            task: 'project:research',
            provider: getModel(run.model)?.vendor ?? 'anthropic',
            model: run.model,
            usage: run.usage,
            latencyMs: Date.now() - started,
          });
        }
        if (run.violations.length) {
          request.log.warn({ violations: run.violations.slice(0, 20) }, 'research dossier repaired');
        }
        const summary = ResearchSummary.parse(run);
        await updateIntake(intake, user.id, {
          dossier: run.dossier,
          research_summary: summary,
          status: 'researched',
          generation_models: { ...intake.row.generation_models, ...(run.model ? { research: run.model } : {}) },
        });
        return reply.send({ dossier: run.dossier, ...summary });
      } catch (err) {
        request.log.error({ err }, 'research failed');
        return reply.code(502).send({ error: 'research_failed', message: 'Could not read the documentation. Try again.' });
      }
    },
  );

  /* ---------------- the Stack Brief ---------------- */

  app.post<{ Params: { id: string } }>(
    '/api/projects/intake/:id/stack-brief',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const intake = await loadIntake(request.params.id, user.id);
      if (!intake) return notFound(reply);
      if (intake.row.status === 'scoped') return wrongStage(reply, 'Research the project first.');
      if (intake.row.status === 'approved') return wrongStage(reply, 'The stack is already approved.');

      const dossier = parseStoredDossier(intake.row.dossier);
      const summary = ResearchSummary.safeParse(intake.row.research_summary);
      const limitedSources = summary.success ? summary.data.limitedSources : true;
      const previous = parseStoredStackBrief(intake.row.brief);
      const revisions = intake.row.brief_revisions ?? [];
      if (previous && revisions.length >= MAX_REGENERATIONS) {
        return reply.code(429).send({ error: 'regenerate_limit', message: 'The brief can be regenerated twice. Approve it or start again.' });
      }

      const cards = techCards();
      const pins = buildPinTable(cards);
      const tier = intake.row.tier;
      const slots = intake.compiled.slots;
      const respond = (brief: StackBrief, reused: boolean, revisionCount: number) =>
        reply.send({
          brief,
          sources: citedSources(brief, dossier),
          limitedSources,
          reused,
          regenerationsLeft: MAX_REGENERATIONS - revisionCount,
        });

      // The first brief of a templated intake is the template's, re-checked
      // against this learner's requests. A regeneration means the learner
      // wants something else, so it plans from nothing and drops the template.
      const template = previous ? null : await loadTemplate(intake.row.template_project_id);
      if (template) {
        const check = verifyStackBrief(template.brief, { profile: intake.profile, tier, slots, dossier, pins, cards });
        if (check.brief) {
          await updateIntake(intake, user.id, { brief: check.brief, status: 'briefed' });
          return respond(check.brief, true, 0);
        }
      }

      const refusal = await budgetRefusal(user.id);
      if (refusal) return refuse(reply, refusal);
      const compiled = await screened(request, reply, intake.compiled, user.id);
      if (!compiled) return reply;
      const stage = stageFor('brief', tier);
      if (!stage.ok) return refuse(reply, stage.refusal);
      const { provider } = stage.call;

      const memory = await recallMemory(user.id, memoryQueryFor(compiled));
      const started = Date.now();
      // BriefRejectedError carries what its attempts spent; that is recorded too.
      const record = (usage: LLMUsage) => {
        if (!spent(usage)) return;
        void recordUsage({ userId: user.id, task: 'project:brief', provider: provider.id, model: provider.modelId, usage, latencyMs: Date.now() - started });
      };

      try {
        const { data, usage } = await generateBrief({
          provider,
          compiled,
          profile: intake.profile,
          tier,
          slots,
          dossier,
          limitedSources,
          cards,
          pins,
          memory: memory?.text ?? null,
          reasoning: stage.call.reasoning,
          maxTokens: stage.call.maxTokens,
        });
        record(usage);
        if (data.repaired.length) request.log.info({ repaired: data.repaired }, 'stack brief repaired in code');

        const nextRevisions = previous ? [...revisions, previous] : revisions;
        await updateIntake(intake, user.id, {
          brief: data.brief,
          brief_revisions: nextRevisions,
          status: 'briefed',
          ...(previous ? { template_project_id: null } : {}),
          generation_models: { ...intake.row.generation_models, brief: provider.modelId },
        });
        return respond(data.brief, false, nextRevisions.length);
      } catch (err) {
        if (err instanceof BriefRejectedError) {
          record(err.usage);
          request.log.warn({ violations: err.violations }, 'stack brief rejected');
          return reply.code(502).send({
            error: 'stack_brief_rejected',
            message: 'The Stack Brief did not pass its checks. Each attempt is planned afresh, so trying again often works.',
          });
        }
        request.log.error({ err }, 'stack brief failed');
        return reply.code(502).send({ error: 'generation_failed', message: 'Could not write the Stack Brief. Try again.' });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/intake/:id/stack-brief/approve', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const intake = await loadIntake(request.params.id, user.id);
    if (!intake) return notFound(reply);
    if (intake.row.status === 'approved') return reply.send({ ok: true });
    if (intake.row.status !== 'briefed' || !parseStoredStackBrief(intake.row.brief)) {
      return wrongStage(reply, 'There is no Stack Brief to approve yet.');
    }
    const ok = await updateIntake(intake, user.id, { status: 'approved' });
    return ok ? reply.send({ ok: true }) : reply.code(500).send({ error: 'persist_failed', message: 'Could not approve.' });
  });

  /* ---------------- the plan ---------------- */

  app.post<{ Params: { id: string } }>(
    '/api/projects/intake/:id/blueprint',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const parsed = BlueprintBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

      const intake = await loadIntake(request.params.id, user.id);
      if (!intake) return notFound(reply);
      const brief = parseStoredStackBrief(intake.row.brief);
      if (intake.row.status !== 'approved' || !brief) return wrongStage(reply, 'Approve the Stack Brief first.');
      const regenerating = intake.row.blueprint !== null;
      if (regenerating && intake.row.blueprint_revisions >= MAX_REGENERATIONS) {
        return reply.code(429).send({ error: 'regenerate_limit', message: 'The plan can be regenerated twice. Approve it or start again.' });
      }

      const refusal = await budgetRefusal(user.id);
      if (refusal) return refuse(reply, refusal);
      const compiled = await screened(request, reply, intake.compiled, user.id);
      if (!compiled) return reply;

      // The first plan of a templated intake adapts the template's; asking
      // again plans from nothing, as the learner did not want the adaptation.
      const template = regenerating ? null : await loadTemplate(intake.row.template_project_id);
      const tier = intake.row.tier;
      const stage = stageFor(template ? 'adapt' : 'blueprint', tier);
      if (!stage.ok) return refuse(reply, stage.refusal);
      const { provider } = stage.call;

      const dossier = parseStoredDossier(intake.row.dossier);
      const summary = ResearchSummary.safeParse(intake.row.research_summary);
      const memory = await recallMemory(user.id, memoryQueryFor(compiled));
      const started = Date.now();
      try {
        const { data, usage } = await generatePlannedBlueprint({
          provider,
          compiled,
          teachDeployment: parsed.data.teachDeployment,
          memory: memory?.text ?? null,
          reasoning: stage.call.reasoning,
          maxTokens: stage.call.maxTokens,
          brief,
          dossier,
          limitedSources: summary.success ? summary.data.limitedSources : true,
          profile: intake.profile,
          tier,
          slots: compiled.slots,
          template: template?.blueprint ?? null,
          onViolations: (violations, willRetry) =>
            request.log.warn({ willRetry, violations: violations.filter((v) => v.severity !== 'repaired') }, 'blueprint broke its checks'),
        });
        if (spent(usage)) {
          void recordUsage({
            userId: user.id,
            task: template ? 'project:adapt' : 'project:blueprint',
            provider: provider.id,
            model: provider.modelId,
            usage,
            latencyMs: Date.now() - started,
          });
        }

        const revisions = regenerating ? intake.row.blueprint_revisions + 1 : intake.row.blueprint_revisions;
        await updateIntake(intake, user.id, {
          blueprint: data.blueprint,
          blueprint_revisions: revisions,
          ...(regenerating ? { template_project_id: null } : {}),
          generation_models: { ...intake.row.generation_models, blueprint: provider.modelId },
        });
        return reply.send({
          blueprint: data.blueprint,
          model: provider.modelId,
          warnings: data.violations.filter((v) => v.severity !== 'repaired').map((v) => v.message),
          adapted: template !== null,
          regenerationsLeft: MAX_REGENERATIONS - revisions,
          recalled: memory?.items ?? [],
        });
      } catch (err) {
        request.log.error({ err }, 'blueprint against the brief failed');
        return reply.code(502).send({
          error: 'generation_failed',
          message: err instanceof Error ? err.message : 'Could not generate a project plan.',
        });
      }
    },
  );

  /* ---------------- a project's stack ---------------- */

  app.get<{ Params: { id: string } }>('/api/projects/:id/stack', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send({ error: 'not_found' });
    const { data } = await db()
      .from('projects')
      .select('stack_brief, dossier, tech_stack')
      .eq('id', request.params.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!data) return reply.code(404).send({ error: 'not_found' });
    const brief = parseStoredStackBrief(data.stack_brief);
    const dossier = parseStoredDossier(data.dossier);
    // An old project has no brief and falls back to its "Built with" list.
    return reply.send({ brief, sources: citedSources(brief, dossier), builtWith: data.tech_stack ?? [] });
  });
}
