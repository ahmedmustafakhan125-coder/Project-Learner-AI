import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Checkpoint, scorePacing, type PaceState, type AttemptSummary } from '@ai-edu/core';

import { requireAuth, userOf } from '../auth.js';
import { db } from '../db.js';
import { rateLimitConfig } from '../rateLimit.js';

/**
 * Step attempt submission, advancement, and hint gating.
 *
 * The server performs only static verification (Layer 1: file existence,
 * Layer 2: symbol grep). Sandbox tests (Layer 3) run client-side only —
 * the server never executes learner code.
 */

const AttemptBody = z.object({
  submittedFiles: z.array(z.object({
    path: z.string(),
    contents: z.string(),
  })),
  durationMs: z.number().int().nonnegative().optional(),
  /**
   * Outcome of the sandbox tests, which only the browser can run. Absent when
   * the step has no executable checkpoint — that is not a failure, it is a step
   * the static layers alone decide.
   */
  testResults: z
    .array(z.object({ name: z.string(), passed: z.boolean(), message: z.string() }))
    .optional(),
});

/**
 * A partial update of the learner's state on one step.
 *
 * Every field is optional and only what is sent is written: the editor
 * autosaves files on a debounce, while revealing an explanation or opening a
 * hint is a single immediate fact. One row, one endpoint, several writers.
 */
const ProgressBody = z.object({
  files: z
    .array(z.object({ path: z.string(), contents: z.string() }))
    .optional(),
  /** True once the learner has chosen to see the explanation. Never unset. */
  revealed: z.boolean().optional(),
  /** The checkpoint panel as they last saw it. */
  lastRun: z
    .object({
      status: z.enum(['passed', 'failed']),
      layers: z.array(
        z.object({
          status: z.enum(['pending', 'running', 'passed', 'failed']),
          message: z.string().nullable(),
        }),
      ),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** Hint tiers the learner has opened. */
  hintsOpened: z.array(z.number().int().min(1).max(3)).optional(),
});

const HintsQuery = z.object({
  tier: z.coerce.number().int().min(1).max(3),
});

/* ------------------------------------------------------------------ */
/* Static verification helpers                                        */
/* ------------------------------------------------------------------ */

/** Layer 1 — every required file must exist in the submission. */
function checkRequiredFiles(
  requiredFiles: string[],
  submitted: Array<{ path: string; contents: string }>,
): { ok: boolean; missing: string[] } {
  const paths = new Set(submitted.map((f) => f.path));
  const missing = requiredFiles.filter((f) => !paths.has(f));
  return { ok: missing.length === 0, missing };
}

/** Layer 2 — every required symbol must appear somewhere in the submitted code. */
function checkRequiredSymbols(
  requiredSymbols: string[],
  submitted: Array<{ path: string; contents: string }>,
): { ok: boolean; missing: string[] } {
  const haystack = submitted.map((f) => f.contents).join('\n');
  const missing = requiredSymbols.filter((sym) => !haystack.includes(sym));
  return { ok: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ */

const MAX_FILES = 20;
const MAX_FILE_BYTES = 102_400; // 100 KB per file
const MAX_TOTAL_BYTES = 1_048_576; // 1 MB total

/**
 * Why this file set is too big to accept, or null when it is fine.
 *
 * Shared by attempts and drafts: a draft is written far more often than an
 * attempt, so it is the more attractive of the two for storing arbitrary blobs
 * and needs the same ceiling.
 */
function oversizeReason(files: Array<{ path: string; contents: string }>): string | null {
  if (files.length > MAX_FILES) {
    return `Too many files. Maximum is ${MAX_FILES}, received ${files.length}.`;
  }

  let totalBytes = 0;
  for (const file of files) {
    // Byte length, not string length. `.length` counts UTF-16 code units, so a
    // file of non-Latin text or emoji passes a byte cap it actually exceeds by
    // two or three times.
    const size = Buffer.byteLength(file.contents, 'utf8');
    if (size > MAX_FILE_BYTES) {
      return `File "${file.path}" exceeds the ${MAX_FILE_BYTES / 1024} KB limit.`;
    }
    totalBytes += size;
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    return `Total submission size exceeds the ${MAX_TOTAL_BYTES / 1048576} MB limit.`;
  }

  return null;
}

export async function attemptRoutes(app: FastifyInstance): Promise<void> {
  /* --------------- POST /api/projects/:id/steps/:index/attempt --------------- */

  app.post<{ Params: { id: string; index: string } }>(
    '/api/projects/:id/steps/:index/attempt',
    { preHandler: requireAuth, config: rateLimitConfig.attempt },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      const parsed = AttemptBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
      }

      const files = parsed.data.submittedFiles;
      const oversize = oversizeReason(files);
      if (oversize) {
        return reply.code(413).send({ error: 'payload_too_large', message: oversize });
      }

      // 1. Verify project ownership
      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project) return reply.code(404).send({ error: 'not_found' });

      // 2. Load the step (need checkpoint + solution_files)
      const { data: step } = await db()
        .from('project_steps')
        .select('id, checkpoint, solution_files')
        .eq('project_id', project.id)
        .eq('step_index', stepIndex)
        .maybeSingle();

      if (!step) return reply.code(404).send({ error: 'not_found', message: 'No such step.' });
      if (!step.checkpoint) {
        return reply.code(400).send({ error: 'not_expanded', message: 'Step has not been expanded yet.' });
      }

      const checkpointResult = Checkpoint.safeParse(step.checkpoint);
      if (!checkpointResult.success) {
        return reply.code(500).send({ error: 'corrupt_checkpoint', message: 'Stored checkpoint is invalid.' });
      }
      const checkpoint = checkpointResult.data;

      // 3. Static verification (Layer 1 + Layer 2)
      const fileCheck = checkRequiredFiles(checkpoint.requiredFiles, parsed.data.submittedFiles);
      const symbolCheck = fileCheck.ok
        ? checkRequiredSymbols(checkpoint.requiredSymbols, parsed.data.submittedFiles)
        : { ok: false, missing: [] }; // skip symbols when files already fail

      /*
       * Layer 3 is reported, not re-run. The sandbox tests execute in the
       * browser and the server never runs learner code, so their outcome can
       * only arrive here as a report.
       *
       * Recording it matters even so. Grading on the static layers alone marked
       * an attempt passed while the learner was looking at failing tests, which
       * let `advance` wave them past a step they had not finished and fed the
       * pacing model a stream of successes that never happened.
       */
      const testResults = parsed.data.testResults;
      const failingTest = testResults?.find((t) => !t.passed);
      const passed = fileCheck.ok && symbolCheck.ok && !failingTest;

      let failedLayer: string | undefined;
      let message: string | undefined;
      if (!fileCheck.ok) {
        failedLayer = 'file_existence';
        message = `Missing required files: ${fileCheck.missing.join(', ')}`;
      } else if (!symbolCheck.ok) {
        failedLayer = 'symbol_check';
        message = `Missing required symbols: ${symbolCheck.missing.join(', ')}`;
      } else if (failingTest) {
        failedLayer = 'tests';
        message = failingTest.message;
      }

      // 4. Count existing attempts for attempt_no, and read what the hints cost
      const [{ data: existingAttempts }, { data: progress }] = await Promise.all([
        db()
          .from('step_attempts')
          .select('id')
          .eq('step_id', step.id)
          .eq('user_id', user.id)
          .order('attempt_no', { ascending: false }),
        db()
          .from('step_progress')
          .select('hints_opened')
          .eq('step_id', step.id)
          .eq('user_id', user.id)
          .maybeSingle(),
      ]);

      const attemptNo = (existingAttempts?.length ?? 0) + 1;
      // Previously copied from the previous attempt, which started at zero and
      // therefore stayed at zero forever — the pacing model has never once seen
      // a learner use a hint.
      const hintsUsed = Array.isArray(progress?.hints_opened) ? progress.hints_opened.length : 0;

      // 5. Insert the attempt
      const { error: insertError } = await db()
        .from('step_attempts')
        .insert({
          step_id: step.id,
          user_id: user.id,
          attempt_no: attemptNo,
          submitted_files: parsed.data.submittedFiles,
          passed,
          hints_used: hintsUsed,
          duration_ms: parsed.data.durationMs ?? null,
          run_output: null,
          test_results: testResults ?? null,
          ai_review: null,
        });

      if (insertError) {
        return reply.code(500).send({ error: 'insert_failed', message: insertError.message });
      }

      // 6. On pass, return solution files
      if (passed) {
        const solutionFiles = (step.solution_files as Array<{ path: string; contents: string }>) ?? [];
        return reply.send({ passed: true, solutionFiles });
      }

      return reply.send({ passed: false, failedLayer, message });
    },
  );

  /* --------------- PUT /api/projects/:id/steps/:index/progress --------------- */

  /*
   * What the learner has already done on this step.
   *
   * Idempotent by design: one row per learner per step, overwritten. The editor
   * autosaves through here far more often than anything is submitted, and a
   * POST that appended would turn an afternoon of typing into thousands of rows.
   *
   * None of it is graded. It exists so that reopening a project resumes where
   * the learner stopped rather than presenting the step as untouched.
   */
  app.put<{ Params: { id: string; index: string } }>(
    '/api/projects/:id/steps/:index/progress',
    { preHandler: requireAuth, config: rateLimitConfig.draft },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      const parsed = ProgressBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
      }

      if (parsed.data.files) {
        const oversize = oversizeReason(parsed.data.files);
        if (oversize) {
          return reply.code(413).send({ error: 'payload_too_large', message: oversize });
        }
      }

      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project) return reply.code(404).send({ error: 'not_found' });

      const { data: step } = await db()
        .from('project_steps')
        .select('id')
        .eq('project_id', project.id)
        .eq('step_index', stepIndex)
        .maybeSingle();

      if (!step) return reply.code(404).send({ error: 'not_found', message: 'No such step.' });

      // Only the fields that were sent are written. Anything absent keeps the
      // value already in the row, so an editor autosave cannot wipe out the
      // hints the learner opened a moment earlier.
      const patch: Record<string, unknown> = {
        user_id: user.id,
        step_id: step.id,
        updated_at: new Date().toISOString(),
      };
      if (parsed.data.files) patch['files'] = parsed.data.files;
      if (parsed.data.lastRun !== undefined) patch['last_run'] = parsed.data.lastRun;
      if (parsed.data.hintsOpened) patch['hints_opened'] = [...new Set(parsed.data.hintsOpened)].sort();
      // Revealing is one-way. A client that sends `false` is not asking for the
      // explanation to be taken back; it is reporting a state it has not loaded.
      if (parsed.data.revealed) patch['revealed_at'] = new Date().toISOString();

      const { error } = await db()
        .from('step_progress')
        .upsert(patch, { onConflict: 'user_id,step_id' });

      if (error) {
        return reply.code(500).send({ error: 'save_failed', message: error.message });
      }

      return reply.send({ ok: true });
    },
  );

  /* --------------- POST /api/projects/:id/steps/:index/advance --------------- */

  app.post<{ Params: { id: string; index: string } }>(
    '/api/projects/:id/steps/:index/advance',
    { preHandler: requireAuth, config: rateLimitConfig.attempt },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      // Verify project ownership
      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project) return reply.code(404).send({ error: 'not_found' });

      // Load the step
      const { data: step } = await db()
        .from('project_steps')
        .select('id')
        .eq('project_id', project.id)
        .eq('step_index', stepIndex)
        .maybeSingle();

      if (!step) return reply.code(404).send({ error: 'not_found', message: 'No such step.' });

      // Check for at least one passing attempt
      const { data: passingAttempt } = await db()
        .from('step_attempts')
        .select('id')
        .eq('step_id', step.id)
        .eq('user_id', user.id)
        .eq('passed', true)
        .limit(1)
        .maybeSingle();

      if (!passingAttempt) {
        return reply.code(403).send({ error: 'no_passing_attempt', message: 'Pass this step before advancing.' });
      }

      // Advance the enrollment
      const { error: advanceError } = await db()
        .from('enrollments')
        .update({ current_step_index: stepIndex + 1 })
        .eq('project_id', project.id)
        .eq('user_id', user.id);

      if (advanceError) {
        return reply.code(500).send({ error: 'advance_failed', message: advanceError.message });
      }

      // Update pacing state based on this step's attempts
      const { data: enrollment } = await db()
        .from('enrollments')
        .select('pace_state')
        .eq('project_id', project.id)
        .eq('user_id', user.id)
        .maybeSingle();

      const { data: allAttempts } = await db()
        .from('step_attempts')
        .select('duration_ms, hints_used, passed')
        .eq('step_id', step.id)
        .eq('user_id', user.id);

      if (allAttempts && allAttempts.length > 0) {
        const summary: AttemptSummary = {
          attempts: allAttempts.length,
          durationMs: allAttempts.reduce((sum, a) => sum + (a.duration_ms ?? 0), 0),
          hintsUsed: Math.max(...allAttempts.map((a) => a.hints_used ?? 0)),
          passed: true,
        };
        const paceState = (enrollment?.pace_state as PaceState) ?? {
          recentAttemptCounts: [],
          recentDurations: [],
          hintsUsedTotal: 0,
          streakPassed: 0,
          streakFailed: 0,
        };
        const result = scorePacing(paceState, summary);

        await db()
          .from('enrollments')
          .update({ pace_state: result.newState })
          .eq('project_id', project.id)
          .eq('user_id', user.id);
      }

      return reply.send({ ok: true, nextStepIndex: stepIndex + 1 });
    },
  );

  /* --------------- GET /api/projects/:id/steps/:index/hints --------------- */

  app.get<{ Params: { id: string; index: string }; Querystring: { tier?: string } }>(
    '/api/projects/:id/steps/:index/hints',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      const queryParsed = HintsQuery.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.code(400).send({ error: 'bad_request', issues: queryParsed.error.issues });
      }
      const requestedTier = queryParsed.data.tier;

      // Verify project ownership
      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (!project) return reply.code(404).send({ error: 'not_found' });

      // Load step with checkpoint (hints are stored inside checkpoint JSON)
      const { data: step } = await db()
        .from('project_steps')
        .select('id, checkpoint')
        .eq('project_id', project.id)
        .eq('step_index', stepIndex)
        .maybeSingle();

      if (!step) return reply.code(404).send({ error: 'not_found', message: 'No such step.' });
      if (!step.checkpoint) {
        return reply.code(400).send({ error: 'not_expanded', message: 'Step has not been expanded yet.' });
      }

      // Extract hints from checkpoint
      const checkpointRaw = step.checkpoint as Record<string, unknown>;
      const hints = (Array.isArray(checkpointRaw['hints']) ? checkpointRaw['hints'] : []) as Array<{
        tier: number;
        text: string;
      }>;

      const hint = hints.find((h) => h.tier === requestedTier);
      if (!hint) {
        return reply.code(404).send({ error: 'no_hint', message: `No tier-${requestedTier} hint for this step.` });
      }

      // Count attempts and get time since first attempt
      const { data: attempts } = await db()
        .from('step_attempts')
        .select('id, created_at')
        .eq('step_id', step.id)
        .eq('user_id', user.id)
        .order('attempt_no', { ascending: true });

      const attemptCount = attempts?.length ?? 0;
      const firstAttemptAt = attempts?.[0]?.created_at ? new Date(attempts[0].created_at).getTime() : null;
      const elapsedMs = firstAttemptAt ? Date.now() - firstAttemptAt : 0;

      // Gating rules: tier N requires N attempts OR N*5 min elapsed
      const requiredAttempts = requestedTier;
      const requiredMs = requestedTier * 5 * 60 * 1000;

      const unlocked = attemptCount >= requiredAttempts || elapsedMs >= requiredMs;

      if (!unlocked) {
        const attemptsRemaining = Math.max(0, requiredAttempts - attemptCount);
        const minutesRemaining = Math.max(0, Math.ceil((requiredMs - elapsedMs) / 60_000));
        return reply.code(403).send({
          error: 'hint_locked',
          message: `Tier ${requestedTier} requires ${requiredAttempts} attempt(s) or ${requiredMs / 60_000} min elapsed. ` +
            `${attemptsRemaining} attempt(s) or ~${minutesRemaining} min remaining.`,
          attemptsUsed: attemptCount,
          attemptsRequired: requiredAttempts,
          elapsedMs,
          requiredMs,
        });
      }

      return reply.send({ tier: requestedTier, text: hint.text });
    },
  );
}
