import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Checkpoint,
  CompiledQuery,
  ProjectBlueprint,
  SkillLevel,
  expandStep,
  generateBlueprint,
  groundCheckpoint,
  planExpansion,
  scorePacing,
  type PaceState,
  type AttemptSummary,
  type SourceFile,
} from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { rateLimitConfig } from '../rateLimit.js';

/**
 * Project generation.
 *
 * Two phases, matching the two calls a learner actually makes:
 *
 *   POST /api/projects/blueprint   plan only, NOT persisted — the learner
 *                                  approves or rejects it before more is spent
 *   POST /api/projects             persist an approved blueprint as stubs
 *   POST /api/projects/:id/steps/:index/expand   fill in one step, lazily
 *
 * Steps are stored as stubs and expanded on approach rather than all at once.
 * That is what leaves room for pacing to change a step before the learner ever
 * sees it.
 */

const BlueprintBody = z.object({
  compiled: CompiledQuery,
  model: z.string().optional(),
});

const CreateBody = z.object({
  blueprint: ProjectBlueprint,
  skillLevel: SkillLevel.default('beginner'),
  areaOfInterest: z.string().nullable().default(null),
  model: z.string().optional(),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- Phase A: blueprint ---------------- */

  app.post('/api/projects/blueprint', { preHandler: requireAuth, config: rateLimitConfig.generation }, async (request, reply) => {
    const user = userOf(request);

    const parsed = BlueprintBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    /*
     * Like /api/agents/ask, this route takes a client-supplied CompiledQuery,
     * so it is a second way to hand the model a prompt that never passed
     * through the interview. It gets the same screening, before the budget
     * check and before a provider exists.
     */
    let safeCompiled;
    try {
      safeCompiled = {
        ...parsed.data.compiled,
        text: await screenOrThrow(parsed.data.compiled.text, `blueprint:${user.id}`),
      };
    } catch (err) {
      const refusal = gatewayErrorReply(err);
      if (!refusal) throw err;
      request.log.warn({ userId: user.id, ...refusal.body }, 'blueprint prompt refused');
      return reply.code(refusal.status).send(refusal.body);
    }

    const budget = await checkBudget(user.id);
    if (budget.exceeded) {
      return reply.code(429).send({
        error: 'budget_exceeded',
        message: `Daily allowance of $${budget.limitUSD.toFixed(2)} reached.`,
      });
    }

    let provider;
    try {
      provider = createProviderForTask('projectGen', parsed.data.model);
    } catch (err) {
      return reply
        .code(503)
        .send({ error: 'no_provider', message: err instanceof Error ? err.message : 'unavailable' });
    }

    const started = Date.now();
    try {
      const blueprint = await generateBlueprint({ provider, compiled: safeCompiled });

      void recordUsage({
        userId: user.id,
        task: 'project:blueprint',
        provider: provider.id,
        model: provider.modelId,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: Date.now() - started,
      });

      // Deliberately not persisted. A learner who rejects this plan should not
      // find a dead project in their dashboard.
      return reply.send({ blueprint, model: provider.modelId });
    } catch (err) {
      request.log.error({ err }, 'blueprint generation failed');
      return reply.code(502).send({
        error: 'generation_failed',
        message: err instanceof Error ? err.message : 'Could not generate a project plan.',
      });
    }
  });

  /* ---------------- Persist an approved blueprint ---------------- */

  app.post('/api/projects', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { blueprint, skillLevel, areaOfInterest, model } = parsed.data;

    const { data: project, error } = await db()
      .from('projects')
      .insert({
        user_id: user.id,
        title: blueprint.title,
        summary: blueprint.summary,
        area_of_interest: areaOfInterest,
        tech_stack: blueprint.techStack,
        skill_level: skillLevel,
        learning_goals: blueprint.learningObjectives,
        prerequisites: blueprint.prerequisites,
        estimated_hours: blueprint.estimatedHours,
        status: 'active',
        // Stored verbatim: it is the cached prefix for every step expansion, so
        // it must not drift from what those calls were generated against.
        blueprint,
        generation_model: model ?? null,
      })
      .select('id')
      .single();

    if (error || !project) {
      return reply.code(500).send({ error: 'persist_failed', message: error?.message });
    }

    const { error: stepsError } = await db()
      .from('project_steps')
      .insert(
        blueprint.steps.map((step, index) => ({
          project_id: project.id,
          user_id: user.id,
          step_index: index,
          title: step.title,
          objective: step.objective,
          concepts: step.concepts,
          est_minutes: step.estMinutes,
        })),
      );

    if (stepsError) {
      // Leave no half-built project behind.
      await db().from('projects').delete().eq('id', project.id);
      return reply.code(500).send({ error: 'persist_failed', message: stepsError.message });
    }

    await db()
      .from('enrollments')
      .insert({ user_id: user.id, project_id: project.id, current_step_index: 0 });

    return reply.code(201).send({ id: project.id });
  });

  /* ---------------- Read ---------------- */

  app.get('/api/projects', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const { data, error } = await db()
      .from('projects')
      .select('id, title, summary, tech_stack, skill_level, estimated_hours, status, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) return reply.code(500).send({ error: 'query_failed', message: error.message });
    return reply.send({ projects: data ?? [] });
  });

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      const { data: project, error } = await db()
        .from('projects')
        .select('*')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) return reply.code(500).send({ error: 'query_failed', message: error.message });
      if (!project) return reply.code(404).send({ error: 'not_found' });

      const { data: steps } = await db()
        .from('project_steps')
        .select('id, step_index, title, objective, concepts, est_minutes, expanded_at')
        .eq('project_id', project.id)
        .order('step_index', { ascending: true });

      const { data: enrollment } = await db()
        .from('enrollments')
        .select('current_step_index, status')
        .eq('project_id', project.id)
        .eq('user_id', user.id)
        .maybeSingle();

      return reply.send({
        project,
        // Step bodies are omitted here on purpose: the list is for navigation,
        // and shipping every solution file to the browser would hand the
        // learner every answer in the project up front.
        steps: (steps ?? []).map((step) => ({
          id: step.id,
          stepIndex: step.step_index,
          title: step.title,
          objective: step.objective,
          concepts: step.concepts,
          estMinutes: step.est_minutes,
          expanded: step.expanded_at !== null,
        })),
        currentStepIndex: enrollment?.current_step_index ?? 0,
      });
    },
  );

  /* ---------------- Phase B: expand one step ---------------- */

  app.post<{ Params: { id: string; index: string } }>(
    '/api/projects/:id/steps/:index/expand',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      const { data: project } = await db()
        .from('projects')
        .select('id, blueprint')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project?.blueprint) return reply.code(404).send({ error: 'not_found' });

      const { data: step } = await db()
        .from('project_steps')
        .select('*')
        .eq('project_id', project.id)
        .eq('step_index', stepIndex)
        .maybeSingle();

      if (!step) return reply.code(404).send({ error: 'not_found', message: 'No such step.' });

      // Already done — return it rather than paying to generate it twice.
      if (step.expanded_at) {
        // The attempt history travels with the step. The hint gate is enforced
        // here against these rows, so a client that cannot see them counts from
        // zero after every reload and re-locks hints the learner has earned.
        const [{ data: attempts }, { data: progress }] = await Promise.all([
          db()
            .from('step_attempts')
            .select('created_at, passed')
            .eq('step_id', step.id)
            .eq('user_id', user.id)
            .order('attempt_no', { ascending: true }),
          // Everything the learner has already done here. Absent means they
          // have not started, and the step opens as written.
          db()
            .from('step_progress')
            .select('files, revealed_at, last_run, hints_opened')
            .eq('step_id', step.id)
            .eq('user_id', user.id)
            .maybeSingle(),
        ]);

        return reply.send({
          step: {
            ...toExpansionPayload(step),
            attemptCount: attempts?.length ?? 0,
            firstAttemptAt: attempts?.[0]?.created_at ?? null,
            draftFiles:
              Array.isArray(progress?.files) && progress.files.length > 0 ? progress.files : null,
            // Passing is the attempts table's business, not the progress row's:
            // it is a graded event, and deriving it keeps one source of truth.
            passed: (attempts ?? []).some((attempt) => attempt.passed),
            revealed: progress?.revealed_at != null,
            lastRun: progress?.last_run ?? null,
            hintsOpened: Array.isArray(progress?.hints_opened) ? progress.hints_opened : [],
          },
          cached: true,
        });
      }

      const budget = await checkBudget(user.id);
      if (budget.exceeded) {
        return reply.code(429).send({
          error: 'budget_exceeded',
          message: `Daily allowance of $${budget.limitUSD.toFixed(2)} reached.`,
        });
      }

      let provider;
      try {
        provider = createProviderForTask('projectGen');
      } catch (err) {
        return reply
          .code(503)
          .send({ error: 'no_provider', message: err instanceof Error ? err.message : 'unavailable' });
      }

      const blueprint = ProjectBlueprint.safeParse(project.blueprint);
      if (!blueprint.success) {
        return reply.code(500).send({
          error: 'corrupt_blueprint',
          message: 'This project was stored with a blueprint this version cannot read.',
        });
      }

      // Compute pacing directive from previous step's attempts
      let directive = null;
      if (stepIndex > 0) {
        const { data: enrollment } = await db()
          .from('enrollments')
          .select('pace_state')
          .eq('project_id', project.id)
          .eq('user_id', user.id)
          .maybeSingle();

        const { data: prevStep } = await db()
          .from('project_steps')
          .select('id')
          .eq('project_id', project.id)
          .eq('step_index', stepIndex - 1)
          .maybeSingle();

        if (prevStep) {
          const { data: prevAttempts } = await db()
            .from('step_attempts')
            .select('duration_ms, hints_used, passed')
            .eq('step_id', prevStep.id)
            .eq('user_id', user.id);

          if (prevAttempts && prevAttempts.length > 0) {
            const summary: AttemptSummary = {
              attempts: prevAttempts.length,
              durationMs: prevAttempts.reduce((sum, a) => sum + (a.duration_ms ?? 0), 0),
              hintsUsed: Math.max(...prevAttempts.map((a) => a.hints_used ?? 0)),
              passed: true,
            };
            const paceState: PaceState = (enrollment?.pace_state as PaceState) ?? {
              recentAttemptCounts: [],
              recentDurations: [],
              // Windowed hint count — see PaceState in packages/core.
              recentHints: [],
              hintsUsedTotal: 0,
              streakPassed: 0,
              streakFailed: 0,
            };
            const result = scorePacing(paceState, summary);
            directive = result.directive;
          }
        }
      }

      const started = Date.now();
      try {
        const expansion = await expandStep({
          provider,
          blueprint: blueprint.data,
          stepIndex,
          directive,
        });

        await db()
          .from('project_steps')
          .update({
            instructions_md: expansion.instructionsMd,
            explanation_md: expansion.explanationMd,
            alternatives: expansion.alternatives,
            starter_files: expansion.starterFiles,
            solution_files: expansion.solutionFiles,
            checkpoint: { ...expansion.checkpoint, hints: expansion.hints },
            expanded_at: new Date().toISOString(),
            pacing_directive: directive,
          })
          .eq('id', step.id);

        void recordUsage({
          userId: user.id,
          task: `project:expand:${stepIndex}`,
          provider: provider.id,
          model: provider.modelId,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          latencyMs: Date.now() - started,
        });

        return reply.send({
          step: {
            stepIndex,
            title: step.title,
            objective: step.objective,
            instructionsMd: expansion.instructionsMd,
            explanationMd: expansion.explanationMd,
            alternatives: expansion.alternatives,
            starterFiles: expansion.starterFiles,
            checkpoint: expansion.checkpoint,
            hintCount: expansion.hints.length,
            attemptCount: 0,
            firstAttemptAt: null,
            draftFiles: null,
            passed: false,
            revealed: false,
            lastRun: null,
            hintsOpened: [],
          },
          cached: false,
        });
      } catch (err) {
        request.log.error({ err, stepIndex }, 'step expansion failed');
        return reply.code(502).send({
          error: 'generation_failed',
          message: err instanceof Error ? err.message : 'Could not write this step.',
        });
      }
    },
  );

  /** What the client should fetch next, so the UI never guesses. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/plan',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      const { data: steps } = await db()
        .from('project_steps')
        .select('step_index, expanded_at')
        .eq('project_id', request.params.id)
        .eq('user_id', user.id)
        .order('step_index', { ascending: true });

      const { data: enrollment } = await db()
        .from('enrollments')
        .select('current_step_index')
        .eq('project_id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      const plan = planExpansion(
        (steps ?? []).map((step) => ({
          index: step.step_index,
          expanded: step.expanded_at !== null,
          expanding: false,
        })),
        enrollment?.current_step_index ?? 0,
      );

      return reply.send(plan);
    },
  );
}

/* ------------------------------------------------------------------ */

/**
 * Solution files are deliberately absent: sending them would hand the learner
 * the answer to a step they have not attempted.
 */
function toExpansionPayload(step: Record<string, unknown>) {
  const stored = (step['checkpoint'] ?? {}) as Record<string, unknown>;
  const hints = Array.isArray(stored['hints']) ? stored['hints'] : [];

  /*
   * Two things happen on the way out.
   *
   * The hints are dropped. They live inside the checkpoint JSON, so returning
   * it verbatim shipped all three tiers to the browser and made the gated
   * hints endpoint decorative — the ladder was readable in devtools.
   *
   * And the checkpoint is grounded against what the sandbox can run. Steps
   * written before that rule existed can still carry tests for packages the
   * browser cannot install; grounding on read repairs them in place instead of
   * charging the learner for a regeneration.
   */
  const parsed = Checkpoint.safeParse(stored);
  const files = [
    ...(Array.isArray(step['starter_files']) ? step['starter_files'] : []),
    ...(Array.isArray(step['solution_files']) ? step['solution_files'] : []),
  ] as SourceFile[];
  const checkpoint = parsed.success ? groundCheckpoint(parsed.data, files) : stored;

  return {
    stepIndex: step['step_index'],
    title: step['title'],
    objective: step['objective'],
    instructionsMd: step['instructions_md'],
    explanationMd: step['explanation_md'],
    alternatives: step['alternatives'],
    starterFiles: step['starter_files'],
    checkpoint,
    hintCount: hints.length,
    // Persisted by the expand route but previously never returned, so the
    // learner-facing pacing banner had nothing to render and silently never
    // appeared.
    pacingDirective: step['pacing_directive'] ?? null,
  };
}
