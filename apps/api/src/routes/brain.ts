import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nodeDetail, projectGraph } from '@ai-edu/core';

import { requireAuth, userOf } from '../auth.js';
import { findQuestionRecall, loadProjection, scheduleRebuild } from '../brain.js';
import { rateLimitConfig } from '../rateLimit.js';

/**
 * The brain, read.
 *
 * Read-only by construction: these routes load the stored projection and hand
 * it to the pure functions in packages/core. The only write is `rebuild`, and
 * it rewrites the caller's projection from the caller's own event log — there
 * is nothing a learner can send that changes what the brain says.
 *
 * `loadProjection` filters on `user_id` by hand; the service-role client
 * bypasses RLS, so that filter is what keeps one learner's brain their own.
 */

const GraphQuery = z.object({
  /** Days. Absent means all time. */
  window: z.coerce.number().int().positive().max(3650).optional(),
  focus: z.string().min(1).max(300).optional(),
  depth: z.coerce.number().int().min(0).max(4).optional(),
});

const NodeParams = z.object({ id: z.string().min(1).max(300) });

const RecallBody = z.object({
  query: z.string().min(1).max(8000),
  /** The conversation the learner is in; a match there is not a revisit. */
  threadId: z.string().uuid().nullable().default(null),
});

export async function brainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/brain/graph', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const parsed = GraphQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    let projection;
    try {
      projection = await loadProjection(user.id);
    } catch (err) {
      request.log.error({ err }, 'brain graph load failed');
      return reply.code(500).send({ error: 'brain_unavailable', message: 'Could not load your brain.' });
    }

    return projectGraph(projection.nodes, projection.edges, {
      now: new Date().toISOString(),
      windowDays: parsed.data.window ?? null,
      focus: parsed.data.focus ?? null,
      ...(parsed.data.depth !== undefined ? { depth: parsed.data.depth } : {}),
    });
  });

  app.get('/api/brain/node/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const parsed = NodeParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    let projection;
    try {
      projection = await loadProjection(user.id);
    } catch (err) {
      request.log.error({ err }, 'brain node load failed');
      return reply.code(500).send({ error: 'brain_unavailable', message: 'Could not load your brain.' });
    }

    const detail = nodeDetail(parsed.data.id, projection.nodes, projection.edges);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  /*
   * Assisted recall: has the caller asked this before, in another
   * conversation? Called alongside the interview, never in front of it — the
   * new question is answered whatever this says. No model is involved, so
   * there is nothing for the gateway to screen and nothing to budget.
   */
  app.post('/api/brain/recall', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);
    const parsed = RecallBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    try {
      return { match: await findQuestionRecall(user.id, parsed.data.query, parsed.data.threadId) };
    } catch (err) {
      // A recall failure is not worth an error on screen: the learner asked a
      // question, and the answer is on its way regardless.
      request.log.warn({ err }, 'question recall failed');
      return { match: null };
    }
  });

  /*
   * Recompute the caller's projection from their event log. Cheap to call and
   * harmless to repeat — the result is a pure function of the log — but it
   * reads the whole log, so it sits on the tighter limit.
   */
  app.post(
    '/api/brain/rebuild',
    { preHandler: requireAuth, config: rateLimitConfig.generation },
    async (request) => {
      await scheduleRebuild(userOf(request).id);
      return { ok: true };
    },
  );
}
