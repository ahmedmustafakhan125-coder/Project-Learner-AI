import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MAX_ANSWER_CHARS, MCQ_COUNT, MCQ_OPTIONS, VIVA_COUNT } from '@ai-edu/core';

import {
  dismissOffer,
  getAssessment,
  listOffers,
  startAssessment,
  submitMcq,
  submitViva,
} from '../assessment.js';
import { requireAuth, userOf } from '../auth.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { rateLimitConfig } from '../rateLimit.js';

/**
 * The assessment runtime.
 *
 * Its own routes rather than a mode on the chat route: a different spend
 * profile, different limits, and a grader that must never see the chat. The
 * fan-out has no part in a sitting.
 *
 * Every lookup is scoped to the caller inside the service; the service-role
 * client bypasses RLS, so that scoping is what keeps one learner's sittings
 * their own.
 */

const IdParams = z.object({ id: z.string().uuid() });
const StartBody = z.object({ conceptKey: z.string().min(1).max(120) });
const McqBody = z.object({
  answers: z.array(z.number().int().min(0).max(MCQ_OPTIONS - 1)).length(MCQ_COUNT),
});
const VivaBody = z.object({
  questionIndex: z.number().int().min(0).max(VIVA_COUNT - 1),
  answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
});
const ConceptParams = z.object({ conceptKey: z.string().min(1).max(120) });

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'No such assessment.' });

export async function assessmentRoutes(app: FastifyInstance): Promise<void> {
  /* ---- start (or resume) a sitting on a concept ---- */
  app.post(
    '/api/assessment/start',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const parsed = StartBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });

      const result = await startAssessment(user.id, parsed.data.conceptKey);
      switch (result.kind) {
        case 'ok':
          return reply.send({ assessment: result.view, resumed: result.resumed });
        case 'not_found':
          return reply.code(404).send({ error: 'not_found', message: 'That concept is not in your brain yet.' });
        case 'cooldown':
          return reply.code(409).send({
            error: 'cooldown',
            message: 'A retake opens after a short break — time to go back over it first.',
            retakeAfter: result.retakeAfter,
          });
        case 'budget':
          return reply.code(429).send({ error: 'budget_exceeded', message: result.message });
        case 'no_provider':
          return reply.code(503).send({ error: 'no_provider', message: result.message });
        case 'generation_failed':
          return reply.code(502).send({ error: 'generation_failed', message: result.message });
      }
    },
  );

  /* ---- offers: "want to test whether it stuck?" ---- */
  // Registered before `/:id`; find-my-way prefers the static segment either way.
  app.get('/api/assessment/offers', { preHandler: requireAuth }, async (request) => ({
    offers: await listOffers(userOf(request).id),
  }));

  app.post('/api/assessment/offers/:conceptKey/dismiss', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = ConceptParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    await dismissOffer(userOf(request).id, parsed.data.conceptKey);
    return { ok: true };
  });

  /* ---- read a sitting ---- */
  app.get('/api/assessment/:id', { preHandler: requireAuth }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request', message: 'Invalid assessment id.' });
    const view = await getAssessment(userOf(request).id, params.data.id);
    return view ? { assessment: view } : notFound(reply);
  });

  /* ---- the multiple-choice gate ---- */
  app.post(
    '/api/assessment/:id/mcq',
    { preHandler: requireAuth, config: rateLimitConfig.attempt },
    async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'bad_request', message: 'Invalid assessment id.' });
      const body = McqBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });

      const result = await submitMcq(userOf(request).id, params.data.id, body.data.answers);
      if (result.kind === 'not_found') return notFound(reply);
      if (result.kind === 'conflict') return reply.code(409).send({ error: 'conflict', message: result.message });
      return { assessment: result.view };
    },
  );

  /* ---- one viva answer ---- */
  app.post(
    '/api/assessment/:id/viva',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request, reply) => {
      const user = userOf(request);
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'bad_request', message: 'Invalid assessment id.' });
      const body = VivaBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });

      // The answer is learner text headed for a model, so it is screened like
      // any other. A masked answer is graded as masked — never the original.
      let answer: string;
      try {
        answer = await screenOrThrow(body.data.answer, `viva:${user.id}:${params.data.id}:${body.data.questionIndex}`);
      } catch (err) {
        const refusal = gatewayErrorReply(err);
        if (!refusal) throw err;
        request.log.warn({ userId: user.id, ...refusal.body }, 'viva answer refused by security gateway');
        return reply.code(refusal.status).send(refusal.body);
      }

      const result = await submitViva(user.id, params.data.id, body.data.questionIndex, answer);
      switch (result.kind) {
        case 'ok':
          return reply.send({ assessment: result.view, grade: result.grade });
        case 'not_found':
          return notFound(reply);
        case 'conflict':
          return reply.code(409).send({ error: 'conflict', message: result.message });
        case 'budget':
          return reply.code(429).send({ error: 'budget_exceeded', message: result.message });
        case 'no_provider':
          return reply.code(503).send({ error: 'no_provider', message: result.message });
        case 'grading_failed':
          return reply.code(502).send({ error: 'grading_failed', message: result.message });
      }
    },
  );
}
