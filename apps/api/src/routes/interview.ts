import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AttachmentRef,
  InterviewContext,
  InterviewState,
  beginInterview,
  continueInterview,
  extractDurableSlots,
} from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { checkBudget, db, recordUsage } from '../db.js';

/**
 * The context interview.
 *
 * Two endpoints matching the two states a learner can be in: they have just
 * asked something, or they have just answered our questions. Both return the
 * same shape — either questions to answer, or a compiled query ready to fan out.
 *
 * The interview runs on the cheap task-default model. It is extraction and
 * phrasing, not reasoning, and it happens on every single query.
 */

const StartBody = z.object({
  query: z.string().min(1).max(8000),
  threadId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  stepId: z.string().uuid().nullable().default(null),
  attachments: z.array(AttachmentRef).default([]),
});

const ContinueBody = z.object({
  state: InterviewState,
  answers: z.record(z.string(), z.string()).default({}),
  attachments: z.array(AttachmentRef).default([]),
  skip: z.boolean().default(false),
});

export async function interviewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/interview/start', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const parsed = StartBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { query, projectId, stepId, attachments } = parsed.data;

    const budget = await checkBudget(user.id);
    if (budget.exceeded) {
      return reply.code(429).send({
        error: 'budget_exceeded',
        message: `Daily allowance of $${budget.limitUSD.toFixed(2)} reached.`,
      });
    }

    let provider;
    try {
      provider = createProviderForTask('interview');
    } catch (err) {
      return reply
        .code(503)
        .send({ error: 'no_provider', message: err instanceof Error ? err.message : 'unavailable' });
    }

    const context = await buildContext(user.id, projectId, stepId);
    const started = Date.now();

    try {
      const outcome = await beginInterview({ provider, rawQuery: query, context, attachments });
      void recordUsage({
        userId: user.id,
        task: 'interview:start',
        provider: provider.id,
        model: provider.modelId,
        // The provider layer reports usage per call; the interview aggregates
        // several, so this row is indicative rather than exact.
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: Date.now() - started,
      });
      return reply.send(serialise(outcome));
    } catch (err) {
      return interviewFailure(reply, err, query, attachments);
    }
  });

  app.post('/api/interview/continue', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const parsed = ContinueBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { state, answers, attachments, skip } = parsed.data;

    let provider;
    try {
      provider = createProviderForTask('interview');
    } catch (err) {
      return reply
        .code(503)
        .send({ error: 'no_provider', message: err instanceof Error ? err.message : 'unavailable' });
    }

    try {
      const outcome = await continueInterview({ provider, state, answers, attachments, skip });

      // Durable answers graduate into the learner's profile so the next query
      // asks less. Only self-reported values qualify — never inferred ones.
      if (outcome.status === 'ready') {
        void persistDurableSlots(user.id, extractDurableSlots(outcome.state.slots));
      }

      return reply.send(serialise(outcome));
    } catch (err) {
      return interviewFailure(reply, err, state.rawQuery, attachments);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function serialise(outcome: Awaited<ReturnType<typeof beginInterview>>) {
  return outcome.status === 'ready'
    ? { status: 'ready' as const, compiled: outcome.compiled, state: outcome.state }
    : { status: 'awaiting_answers' as const, questions: outcome.questions, state: outcome.state };
}

/**
 * If the interview itself fails, fall through to answering the raw question
 * rather than blocking the learner. A degraded answer beats an error page.
 */
function interviewFailure(
  reply: FastifyReply,
  err: unknown,
  rawQuery: string,
  attachments: z.infer<typeof AttachmentRef>[],
) {
  console.error('[interview] failed, falling back to the raw query:', err);
  return reply.send({
    status: 'ready' as const,
    degraded: true,
    compiled: {
      intent: 'other' as const,
      originalQuery: rawQuery,
      text: `<learner_question>\n${rawQuery}\n</learner_question>`,
      slots: {},
      attachments,
      partial: true,
    },
  });
}

/**
 * Everything the interview can know without asking. This is what makes it
 * adaptive: a learner mid-project should not be asked which language they use.
 */
async function buildContext(
  userId: string,
  projectId: string | null,
  stepId: string | null,
): Promise<z.infer<typeof InterviewContext>> {
  const context: z.infer<typeof InterviewContext> = InterviewContext.parse({});

  const { data: profile } = await db()
    .from('profiles')
    .select('default_skill')
    .eq('id', userId)
    .maybeSingle();
  if (profile?.default_skill) context.skillLevel = profile.default_skill;

  const { data: learned } = await db()
    .from('user_context_profile')
    .select('slots')
    .eq('user_id', userId)
    .maybeSingle();

  const slots = (learned?.slots ?? {}) as Record<string, string>;
  if (slots['skill_level']) context.skillLevel = slots['skill_level'] as typeof context.skillLevel;
  if (slots['goal']) context.goals = [slots['goal']];

  if (projectId) {
    const { data: project } = await db()
      .from('projects')
      .select('title, tech_stack')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    if (project) {
      context.projectTitle = project.title;
      context.projectTech = Array.isArray(project.tech_stack) ? project.tech_stack : [];
    }
  }

  if (stepId) {
    const { data: step } = await db()
      .from('project_steps')
      .select('title, concepts')
      .eq('id', stepId)
      .eq('user_id', userId)
      .maybeSingle();
    if (step) {
      context.stepTitle = step.title;
      context.stepConcepts = Array.isArray(step.concepts) ? step.concepts : [];
    }
  }

  return context;
}

async function persistDurableSlots(
  userId: string,
  durable: Record<string, string>,
): Promise<void> {
  if (Object.keys(durable).length === 0) return;

  const { data: existing } = await db()
    .from('user_context_profile')
    .select('slots')
    .eq('user_id', userId)
    .maybeSingle();

  const merged = { ...((existing?.slots as Record<string, string>) ?? {}), ...durable };

  const { error } = await db()
    .from('user_context_profile')
    .upsert({ user_id: userId, slots: merged }, { onConflict: 'user_id' });

  if (error) console.error('[interview] failed to persist durable slots:', error.message);
}
