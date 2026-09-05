import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Checkpoint,
  CompiledQuery,
  ProjectBlueprint,
  SkillLevel,
  expandStep,
  finishProject,
  generateBlueprint,
  groundCheckpoint,
  parseStoredBlueprint,
  planExpansion,
  scorePacing,
  type PaceState,
  type AttemptSummary,
  type ProjectArtifact,
  type SourceFile,
} from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { assembleFinished, priorFilesFor } from '../projectFiles.js';
import { canExpand, loadProgress } from '../progress.js';
import { rateLimitConfig } from '../rateLimit.js';
import { archiveName, createZip } from '../zip.js';

/**
 * Project generation.
 *
 * Two phases, matching the two calls a learner actually makes:
 *
 *   POST /api/projects/blueprint   plan only, NOT persisted — the learner
 *                                  approves or rejects it before more is spent
 *   POST /api/projects             persist an approved blueprint as stubs
 *   POST /api/projects/:id/steps/:index/expand   fill in one step, lazily
 *   POST /api/projects/:id/finish  README + deploy config for the finished code
 *   GET  /api/projects/:id/export  the whole thing as a .zip
 *
 * Steps are stored as stubs and expanded on approach rather than all at once.
 * That is what leaves room for pacing to change a step before the learner ever
 * sees it.
 *
 * Each expansion is handed the project as it currently stands — the learner's
 * own passing code where they wrote it, the reference solution where they did
 * not — so a step continues the codebase instead of starting a new one. The
 * blueprint's file plan says which files that step may touch. Together those
 * are what make the finished project one thing rather than N exercises.
 */

const BlueprintBody = z.object({
  compiled: CompiledQuery,
  model: z.string().optional(),
  /**
   * Whether the plan should spend real steps teaching deployment.
   *
   * Independent of whether deployment CONFIG is produced: that happens either
   * way at the finish, because a project nobody else can run is not a portfolio
   * piece. This only decides whether shipping it is part of the curriculum.
   */
  teachDeployment: z.boolean().default(false),
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
      const blueprint = await generateBlueprint({
        provider,
        compiled: safeCompiled,
        teachDeployment: parsed.data.teachDeployment,
      });

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

  /* ---------------- delete ---------------- */

  /**
   * Delete a project and everything under it.
   *
   * A hard delete, and it takes real work with it: the steps, every attempt,
   * the drafts, the enrollment. That is deliberate - an archive flag the
   * learner cannot see is a library that fills up with things they thought
   * they had thrown away. The browser confirms by making them type the title.
   *
   * The cascade is the schema's, not this handler's. `project_steps` and
   * `enrollments` cascade from `projects`; `step_attempts` and `step_progress`
   * cascade from `project_steps`. Deleting the root row is sufficient and
   * deleting the children by hand here would only be a second, driftable copy
   * of that rule.
   *
   * `threads.project_id` is ON DELETE SET NULL rather than cascade, which is
   * correct and worth not "fixing": a question the learner asked while building
   * this is still their question, and their transcript should not disappear
   * because they cleared out a project.
   *
   * `db()` holds the service-role key and bypasses RLS, so the `user_id` filter
   * is the only thing standing between one learner and another's projects. It
   * is in the WHERE clause rather than a prior existence check on purpose:
   * checking first and deleting after is two statements and a race.
   */
  app.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid project id.' });
      }

      const { data, error } = await db()
        .from('projects')
        .delete()
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'failed to delete project');
        return reply
          .code(500)
          .send({ error: 'delete_failed', message: 'Could not delete that project.' });
      }
      // No row matched: it does not exist, or it is not theirs. The same answer
      // for both, so this cannot be used to probe for other learners' ids.
      if (!data) {
        return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
      }

      return reply.send({ ok: true });
    },
  );

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

      // Progress drives two things: the navigator's tick marks, and which
      // steps are open at all. Both come from the same rule as the server's
      // own enforcement, so the UI cannot show a lock the API disagrees with.
      const progress = await loadProgress(project.id, user.id);
      const passed = new Set(progress.steps.filter((step) => step.passed).map((step) => step.id));
      const unlocked = new Set(
        progress.locks.filter((lock) => lock.unlocked).map((lock) => lock.index),
      );

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
          passed: passed.has(step.id),
          /*
           * Steps unlock in sequence. A locked step is still readable once it
           * has been written — the learner can see what is coming — but the
           * editor and the checkpoint are closed until the step before it
           * passes. That matters more than it used to: each step's starter
           * files are now the previous step's output, so jumping ahead hands
           * them work that continues something they never did.
           */
          unlocked: unlocked.has(step.step_index),
        })),
        currentStepIndex: enrollment?.current_step_index ?? 0,
        unlockedThrough: progress.unlockedThrough,
        // Present once the README and deploy config have been written.
        artifactGeneratedAt: project.artifact_generated_at ?? null,
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

      /*
       * Generation is allowed one step past the frontier and no further, so
       * the next step is warm when the learner arrives but nothing beyond it
       * is paid for. Enforced here rather than in the client: this route bills
       * a model call, and a client-side check is not a spending control.
       *
       * It runs before the cached-return branch so a step expanded under the
       * old rules cannot be used to read ahead either.
       */
      const progress = await loadProgress(project.id, user.id);
      if (progress.steps.length > 0 && !canExpand(progress, stepIndex)) {
        return reply.code(403).send({
          error: 'step_locked',
          message: 'Finish the earlier steps first — this one builds on them.',
          unlockedThrough: progress.unlockedThrough,
        });
      }

      // Already done — return it rather than paying to generate it twice.
      if (step.expanded_at) {
        // The attempt history travels with the step. The hint gate is enforced
        // here against these rows, so a client that cannot see them counts from
        // zero after every reload and re-locks hints the learner has earned.
        const [{ data: attempts }, { data: progress }, priorFiles] = await Promise.all([
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
          /*
           * The rest of the project, as this step finds it.
           *
           * The expansion prompt has always received this — it is what stops a
           * step restarting the project instead of continuing it — but the
           * browser never did, so the editor showed ONLY the files this step
           * creates or edits. On step 3 of a todo list that is `app.js` alone:
           * `index.html` was neither visible nor editable, and the checkpoint
           * sandbox never received it either, so any test that touched the page
           * failed on a submission that was correct.
           */
          priorFilesFor(project.id, user.id, stepIndex),
        ]);

        return reply.send({
          step: {
            ...toExpansionPayload(step),
            priorFiles,
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

      // Tolerant on purpose: projects planned before file plans existed parse
      // with an empty plan and keep working, rather than 500-ing every learner
      // who had a project open when this shipped.
      const blueprint = parseStoredBlueprint(project.blueprint);
      if (!blueprint) {
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

      // The project as this step finds it. Without this the expansion sees
      // only earlier step TITLES and has to invent a starting point, which is
      // what made each step restart the project rather than continue it.
      const priorFiles = await priorFilesFor(project.id, user.id, stepIndex);

      const started = Date.now();
      try {
        const expansion = await expandStep({
          provider,
          blueprint,
          stepIndex,
          priorFiles,
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
            // Already loaded above for the prompt; the browser needs the same
            // view so the learner can read the project they are building on.
            priorFiles,
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

  /* ---------------- Phase C: the finished project ---------------- */

  /**
   * Assemble the project and, if it has not been written yet, generate the
   * README and deployment config for it.
   *
   * The assembly is free and always fresh — it is a pure overlay of rows the
   * learner already owns. The written parts cost a model call, so they are
   * cached on the project and only regenerated when asked for explicitly.
   */
  app.post<{ Params: { id: string }; Body: { regenerate?: boolean } }>(
    '/api/projects/:id/finish',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);

      const { data: project } = await db()
        .from('projects')
        .select('id, title, blueprint, artifact, artifact_generated_at')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project?.blueprint) return reply.code(404).send({ error: 'not_found' });

      const blueprint = parseStoredBlueprint(project.blueprint);
      if (!blueprint) {
        return reply.code(409).send({
          error: 'corrupt_blueprint',
          message: 'This project was stored with a blueprint this version cannot read.',
        });
      }

      const assembled = await assembleFinished(project.id, user.id);
      if (assembled.files.length === 0) {
        return reply.code(409).send({
          error: 'nothing_to_assemble',
          message: 'There is no code in this project yet. Work through a step first.',
        });
      }

      const regenerate = request.body?.regenerate === true;
      const cached = project.artifact as ProjectArtifact | null;

      // The written parts describe the code, so they are reused only while the
      // code they described is still the code. Anything else ships a README
      // that talks about functions the learner has since replaced.
      if (cached && !regenerate && stillDescribes(cached.files, assembled.files)) {
        return reply.send({ artifact: cached, cached: true });
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

      const started = Date.now();
      let written;
      try {
        written = await finishProject({
          provider,
          blueprint,
          files: assembled.files,
        });
      } catch (err) {
        request.log.error({ err }, 'finish generation failed');
        return reply.code(502).send({
          error: 'generation_failed',
          message: err instanceof Error ? err.message : 'Could not write the finishing files.',
        });
      }

      void recordUsage({
        userId: user.id,
        task: 'project:finish',
        provider: provider.id,
        model: provider.modelId,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: Date.now() - started,
      });

      const artifact: ProjectArtifact = {
        files: [
          ...assembled.files,
          { path: 'README.md', contents: written.readmeMd },
          ...written.deployFiles,
        ],
        readmeMd: written.readmeMd,
        deployment: blueprint.deployment,
        stepsFromReference: assembled.stepsFromReference,
        fullyLearnerWritten: assembled.fullyLearnerWritten,
        generatedAt: new Date().toISOString(),
      };

      const { error: saveErr } = await db()
        .from('projects')
        .update({ artifact, artifact_generated_at: artifact.generatedAt })
        .eq('id', project.id)
        .eq('user_id', user.id);

      // A cache that failed to save is not a failed request — the learner has
      // their project either way, they will just pay for it again next time.
      if (saveErr) request.log.error({ err: saveErr.message }, 'failed to cache project artifact');

      return reply.send({ artifact, cached: false });
    },
  );

  /** The finished project as a download. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/export',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      const { data: project } = await db()
        .from('projects')
        .select('id, title, artifact')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project) return reply.code(404).send({ error: 'not_found' });

      /*
       * The code is always assembled fresh, and only the WRITTEN files come
       * from the cache. Serving the stored artifact wholesale would hand the
       * learner a zip of the code as it was when they last pressed Assemble —
       * silently missing everything they have done since, which is the worst
       * possible thing for a download they are about to show someone.
       *
       * A README that no longer matches is dropped rather than shipped: better
       * an archive with no README than one describing different code.
       */
      const assembled = await assembleFinished(project.id, user.id);
      const cached = project.artifact as ProjectArtifact | null;
      const written =
        cached && stillDescribes(cached.files, assembled.files)
          ? cached.files.filter((file) => !assembled.files.some((a) => a.path === file.path))
          : [];
      const files = [...assembled.files, ...written];

      if (files.length === 0) {
        return reply
          .code(409)
          .send({ error: 'nothing_to_export', message: 'There is no code in this project yet.' });
      }

      const zip = createZip(files);
      const name = archiveName(String(project.title ?? 'project'));

      return reply
        .header('Content-Type', 'application/zip')
        // The name is a conservative slug of the learner's own title, so it
        // cannot break out of the quoted header value.
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Content-Length', String(zip.length))
        .send(zip);
    },
  );
}

/* ------------------------------------------------------------------ */

/**
 * Whether a cached artifact still describes the code it was written from.
 *
 * The artifact's files are the assembly PLUS the README and deploy config, so
 * this is a superset check rather than an equality one: every assembled file
 * must still be present, byte for byte. A learner who reworked step 3 after
 * finishing gets a README regenerated against what they actually have, instead
 * of one describing functions they have since replaced.
 */
function stillDescribes(cachedFiles: SourceFile[], assembled: SourceFile[]): boolean {
  const cached = new Map(cachedFiles.map((file) => [file.path, file.contents]));
  return assembled.every((file) => cached.get(file.path) === file.contents);
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
