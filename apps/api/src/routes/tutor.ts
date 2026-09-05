import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  askTutor,
  evaluateGate,
  parseStoredBlueprint,
  type SourceFile,
  type TutorTurn,
} from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { assembleFinished } from '../projectFiles.js';
import { rateLimitConfig } from '../rateLimit.js';

/**
 * The project tutor.
 *
 * Shaped like the follow-up route — screen, budget, provider, SSE straight to
 * the socket — because that is the shape that works here and re-inventing it
 * would only find the same bugs again.
 *
 * What is different is the gate. Whether the tutor may write code is decided
 * HERE, from rows in the database, and never from anything the request says.
 * The browser renders the learner's progress towards it, but a request that
 * skips the browser and posts straight to this route gets exactly the same
 * answer, because the only thing it can influence is its own question.
 *
 * The stronger half of that is not the gate at all: in locked mode the step's
 * reference solution is never loaded, so there is nothing in the context to
 * extract. Persuading the model to break its instruction wins nothing.
 */

const AskBody = z.object({
  /** Which step they are looking at. Null from the finished-project view. */
  stepIndex: z.number().int().min(0).nullable().optional(),
  message: z.string().min(1).max(4_000),
});

/**
 * How much conversation is replayed into each request.
 *
 * Every turn is re-sent, so an unbounded thread grows its own cost
 * quadratically. Twenty turns is a long working session and well past where
 * the earliest turns are still about anything current — and unlike the
 * follow-up route this is not a hard stop, it is a window: the conversation
 * continues, the model just stops being shown the beginning of it.
 */
const HISTORY_TURNS = 20;

/** Kept small. The rail is a transcript, not an archive. */
const TRANSCRIPT_LIMIT = 200;

const AGENT_UNAVAILABLE = 'The tutor is temporarily unavailable. Try again shortly.';

interface ProgressRow {
  hints_opened: unknown;
  tutor_asks: number | null;
  tutor_unlocked_at: string | null;
  last_run: unknown;
}

/* ------------------------------------------------------------------ *
 * Gate inputs
 * ------------------------------------------------------------------ */

/**
 * Everything the gate reasons over, read fresh for every request.
 *
 * Nothing here is cached and nothing is taken from the client. `failedAttempts`
 * counts graded submissions that did not pass — a junk submission refused by
 * the submit gate never becomes a row, so it cannot move this either, which is
 * what stops the reveal being farmed by pressing submit on empty files.
 */
async function gateInputsFor(
  stepId: string,
  userId: string,
  hintTiersAvailable: number,
): Promise<{
  signals: Parameters<typeof evaluateGate>[0];
  progress: ProgressRow | null;
  alreadyUnlocked: boolean;
}> {
  const [{ data: attempts }, { data: progress }] = await Promise.all([
    db()
      .from('step_attempts')
      .select('created_at, passed')
      .eq('step_id', stepId)
      .eq('user_id', userId)
      .order('attempt_no', { ascending: true }),
    db()
      .from('step_progress')
      .select('hints_opened, tutor_asks, tutor_unlocked_at, last_run')
      .eq('step_id', stepId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const rows = (attempts ?? []) as Array<{ created_at: string; passed: boolean }>;
  const firstAt = rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : null;
  const row = (progress ?? null) as ProgressRow | null;

  return {
    signals: {
      failedAttempts: rows.filter((attempt) => !attempt.passed).length,
      asksThisStep: row?.tutor_asks ?? 0,
      hintTiersSpent: Array.isArray(row?.hints_opened) ? row.hints_opened.length : 0,
      hintTiersAvailable,
      msOnStep: firstAt ? Date.now() - firstAt : 0,
    },
    progress: row,
    alreadyUnlocked: row?.tutor_unlocked_at != null,
  };
}

/** The step row the tutor needs, or null when the step is not expanded yet. */
async function loadStep(projectId: string, userId: string, stepIndex: number) {
  const { data } = await db()
    .from('project_steps')
    .select('id, step_index, title, objective, instructions_md, checkpoint, solution_files')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('step_index', stepIndex)
    .maybeSingle();
  return data;
}

/* ------------------------------------------------------------------ */

export async function tutorRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- the transcript ---------------- */

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/tutor',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!project) return reply.code(404).send({ error: 'not_found' });

      const { data } = await db()
        .from('project_chat_messages')
        .select('role, content, step_index, revealed_code, created_at')
        .eq('project_id', project.id)
        .eq('user_id', user.id)
        .order('turn_index', { ascending: true })
        .limit(TRANSCRIPT_LIMIT);

      return reply.send({
        turns: (data ?? []).map((row) => ({
          role: row.role,
          content: row.content,
          stepIndex: row.step_index,
          revealedCode: row.revealed_code,
          at: row.created_at,
        })),
      });
    },
  );

  /* ---------------- how close they are ---------------- */

  /**
   * Read by the panel so it can say what is still outstanding.
   *
   * Advisory: the answer is computed again on every ask, from the same rows.
   * This endpoint existing does not make it the authority, and a client that
   * lies to itself about it changes nothing.
   */
  app.get<{ Params: { id: string; index: string } }>(
    '/api/projects/:id/tutor/gate/:index',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);
      const stepIndex = Number(request.params.index);
      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid step index.' });
      }

      const { data: project } = await db()
        .from('projects')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!project) return reply.code(404).send({ error: 'not_found' });

      const step = await loadStep(project.id, user.id, stepIndex);
      if (!step) return reply.send({ unlocked: false, score: 0, threshold: 0, missing: [] });

      const checkpoint = (step.checkpoint ?? {}) as Record<string, unknown>;
      const hints = Array.isArray(checkpoint['hints']) ? checkpoint['hints'] : [];

      const { signals, alreadyUnlocked } = await gateInputsFor(step.id, user.id, hints.length);
      const gate = evaluateGate(signals);

      // A reveal already earned stays earned, like a spent hint.
      return reply.send(alreadyUnlocked ? { ...gate, unlocked: true, missing: [] } : gate);
    },
  );

  /* ---------------- ask ---------------- */

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/tutor',
    { preHandler: requireAuth, config: rateLimitConfig.attempt },
    async (request, reply) => {
      const user = userOf(request);

      const parsed = AskBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
      }
      const { message } = parsed.data;
      const stepIndex = parsed.data.stepIndex ?? null;

      const { data: project } = await db()
        .from('projects')
        .select('id, title, summary, blueprint, skill_level, tech_stack')
        .eq('id', request.params.id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!project) return reply.code(404).send({ error: 'not_found' });

      /* ---- screening, before anything is spent ---- */

      let safeMessage: string;
      try {
        safeMessage = await screenOrThrow(message, `tutor:${user.id}`);
      } catch (err) {
        const refusal = gatewayErrorReply(err);
        if (!refusal) throw err;
        request.log.warn({ userId: user.id, ...refusal.body }, 'tutor message refused');
        return reply.code(refusal.status).send(refusal.body);
      }

      const budget = await checkBudget(user.id);
      if (budget.exceeded) {
        return reply.code(429).send({
          error: 'budget_exceeded',
          message:
            `You have used $${budget.spentUSD.toFixed(2)} of your $${budget.limitUSD.toFixed(2)} ` +
            `daily allowance. It resets 24 hours after each request.`,
        });
      }

      const blueprint = parseStoredBlueprint(project.blueprint);
      if (!blueprint) {
        return reply.code(409).send({
          error: 'corrupt_blueprint',
          message: 'This project was stored with a blueprint this version cannot read.',
        });
      }

      const step = stepIndex === null ? null : await loadStep(project.id, user.id, stepIndex);
      if (stepIndex !== null && !step) {
        return reply.code(409).send({
          error: 'step_not_ready',
          message: 'That step has not been written yet.',
        });
      }

      /* ---- the gate ---- */

      const checkpoint = (step?.checkpoint ?? {}) as Record<string, unknown>;
      const hintList = (Array.isArray(checkpoint['hints']) ? checkpoint['hints'] : []) as Array<{
        tier: number;
        text: string;
      }>;

      let unlocked = false;
      let stillMissing: string[] = [];
      let progress: ProgressRow | null = null;

      if (step) {
        const inputs = await gateInputsFor(step.id, user.id, hintList.length);
        progress = inputs.progress;
        const gate = evaluateGate(inputs.signals);
        unlocked = inputs.alreadyUnlocked || gate.unlocked;
        stillMissing = gate.missing;

        /*
         * The ask is counted BEFORE the answer, and by the server.
         *
         * It is one of the gate's own inputs, so counting it after a
         * successful stream would mean a learner who closed the tab mid-answer
         * asked for free. Counting it here also means the browser never has to
         * be trusted with it.
         */
        await db()
          .from('step_progress')
          .upsert(
            {
              step_id: step.id,
              user_id: user.id,
              tutor_asks: (progress?.tutor_asks ?? 0) + 1,
            },
            // Column order matches the primary key on step_progress, as the other
            // upsert in attempts.ts does.
            { onConflict: 'user_id,step_id' },
          );

        // Earned now, and it stays earned: a spent reveal cannot be un-spent
        // by reloading, exactly like a hint.
        if (unlocked && !inputs.alreadyUnlocked) {
          await db()
            .from('step_progress')
            .update({ tutor_unlocked_at: new Date().toISOString() })
            .eq('step_id', step.id)
            .eq('user_id', user.id);
        }
      }

      let provider;
      try {
        provider = createProviderForTask('fanout');
      } catch (err) {
        return reply.code(503).send({
          error: 'no_provider',
          message: err instanceof Error ? err.message : 'No LLM provider configured.',
        });
      }

      /* ---- context ---- */

      const files: SourceFile[] = (await assembleFinished(project.id, user.id)).files;

      const { data: historyRows } = await db()
        .from('project_chat_messages')
        .select('role, content, step_index, turn_index')
        .eq('project_id', project.id)
        .eq('user_id', user.id)
        .order('turn_index', { ascending: false })
        .limit(HISTORY_TURNS);

      const history = ((historyRows ?? []) as Array<{
        role: string;
        content: string;
        step_index: number | null;
        turn_index: number;
      }>)
        .slice()
        .reverse()
        .map<TutorTurn>((row) => ({
          role: row.role === 'assistant' ? 'assistant' : 'user',
          content: row.content,
          ...(row.step_index === null ? {} : { stepIndex: row.step_index }),
        }));

      const nextTurn =
        ((historyRows ?? []) as Array<{ turn_index: number }>).reduce(
          (max, row) => Math.max(max, row.turn_index),
          -1,
        ) + 1;

      const lastRun = progress?.last_run as { layers?: Array<{ message: string | null }> } | null;
      const lastFailure =
        lastRun?.layers
          ?.map((layer) => layer.message)
          .filter((m): m is string => Boolean(m))
          .join(' ') ?? null;

      const seenTiers = Array.isArray(progress?.hints_opened) ? progress.hints_opened : [];

      /* ---- persist their turn before streaming ---- */

      await db().from('project_chat_messages').insert({
        user_id: user.id,
        project_id: project.id,
        step_index: stepIndex,
        turn_index: nextTurn,
        role: 'user',
        content: safeMessage,
      });

      /* ---- stream ---- */

      // Plugin-set headers, CORS above all, live on the reply object and are
      // only flushed by reply.send(). This route writes to the raw socket, so
      // they have to be carried across by hand.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('meta', { turnIndex: nextTurn + 1, unlocked, missing: stillMissing });

      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());

      let answered = '';

      try {
        for await (const event of askTutor({
          provider,
          mode: unlocked ? 'unlocked' : 'locked',
          project: {
            projectTitle: (project.title as string) ?? blueprint.title,
            projectSummary: (project.summary as string) ?? blueprint.summary,
            skillLevel: (project.skill_level as string) ?? 'beginner',
            techStack: blueprint.techStack.map((tech) => tech.name),
            stepTitles: blueprint.steps.map((s) => s.title),
          },
          step: {
            stepIndex: stepIndex ?? 0,
            title: step?.title ?? 'the finished project',
            objective: (step?.objective as string | null) ?? null,
            instructionsMd: (step?.instructions_md as string) ?? '',
            requiredFiles: Array.isArray(checkpoint['requiredFiles'])
              ? (checkpoint['requiredFiles'] as string[])
              : [],
            requiredSymbols: Array.isArray(checkpoint['requiredSymbols'])
              ? (checkpoint['requiredSymbols'] as string[])
              : [],
            lastFailure,
            hintsAlreadySeen: hintList
              .filter((hint) => seenTiers.includes(hint.tier))
              .map((hint) => hint.text),
            /*
             * The load-bearing line in this file.
             *
             * In locked mode the reference solution is not merely forbidden,
             * it is absent — so prompt injection, persuasion and a learner
             * claiming an administrator granted permission all extract
             * nothing, because there is nothing in the context to extract.
             */
            ...(unlocked && Array.isArray(step?.solution_files)
              ? { solutionFiles: step.solution_files as SourceFile[] }
              : {}),
          },
          files,
          history,
          message: safeMessage,
          stillMissing,
          signal: controller.signal,
        })) {
          if (event.type === 'delta') {
            answered += event.text;
            send('delta', { text: event.text });
          } else if (event.type === 'done') {
            answered = event.text;
            void recordUsage({
              userId: user.id,
              task: 'tutor',
              provider: provider.id,
              model: provider.modelId,
              usage: event.usage,
              latencyMs: event.latencyMs,
            });
          } else {
            // The provider's own message names models and quotas. It is logged;
            // what goes over the wire is fixed copy.
            request.log.warn({ err: event.message }, 'tutor answer failed');
            send('error', { message: AGENT_UNAVAILABLE });
          }
        }

        // Whatever arrived is kept, including a partial answer from a stream
        // the learner walked away from — it was on their screen either way.
        if (answered) {
          await db().from('project_chat_messages').insert({
            user_id: user.id,
            project_id: project.id,
            step_index: stepIndex,
            turn_index: nextTurn + 1,
            role: 'assistant',
            content: answered,
            revealed_code: unlocked,
            model: provider.modelId,
          });
        }

        send('done', { text: answered });
      } catch (err) {
        send('fatal', { message: err instanceof Error ? err.message : 'Stream failed.' });
      } finally {
        reply.raw.end();
      }

      return reply;
    },
  );
}
