import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentKind, followUpWithAgent, type FollowUpTurn } from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';

/**
 * Following up with one specialist.
 *
 * The fan-out is four agents on one connection; this is one agent on its own.
 * The saving that shapes `/api/agents/ask` — a shared cached prefix read by
 * four requests — has nothing to do here, so this route is deliberately the
 * simple version: one stream, one persisted turn pair.
 *
 * What it does share is the screening. This endpoint takes learner text
 * straight to a model, so the same gateway runs on it, before the budget check
 * and before a provider exists, and a refused prompt costs nothing.
 */

const AGENT_UNAVAILABLE_MESSAGE = 'This specialist is temporarily unavailable. Try again shortly.';

const FollowUpBody = z.object({
  /** The question whose four answers this follows up on. */
  messageId: z.string().uuid(),
  agent: AgentKind,
  question: z.string().min(1).max(4_000),
});

/**
 * A cap on one specialist's thread.
 *
 * Every turn is replayed into the next request, so an unbounded conversation
 * grows its own cost quadratically. Twenty turns is far past where a follow-up
 * thread stays about the original answer.
 */
const MAX_TURNS = 20;

export async function followUpRoutes(app: FastifyInstance): Promise<void> {
  /** One specialist's follow-up thread, for replaying a conversation. */
  app.get<{ Params: { messageId: string } }>(
    '/api/agents/followups/:messageId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = userOf(request);

      if (!z.string().uuid().safeParse(request.params.messageId).success) {
        return reply.code(400).send({ error: 'bad_request', message: 'Invalid message id.' });
      }

      const { data } = await db()
        .from('agent_followups')
        .select('agent, turn_index, role, content')
        .eq('message_id', request.params.messageId)
        .eq('user_id', user.id)
        .order('turn_index', { ascending: true });

      const byAgent: Record<string, Array<{ role: string; content: string }>> = {};
      for (const row of (data ?? []) as Array<{ agent: string; role: string; content: string }>) {
        (byAgent[row.agent] ??= []).push({ role: row.role, content: row.content });
      }

      return reply.send({ followups: byAgent });
    },
  );

  app.post('/api/agents/followup', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const parsed = FollowUpBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { messageId, agent, question } = parsed.data;

    /* ---- the question must be one of theirs ---- */

    const { data: message } = await db()
      .from('messages')
      .select('id, content')
      .eq('id', messageId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!message) {
      return reply.code(404).send({ error: 'not_found', message: 'No such conversation.' });
    }

    /* ---- screening, before anything is spent ---- */

    let safeQuestion: string;
    try {
      safeQuestion = await screenOrThrow(question, `followup:${user.id}:${agent}`);
    } catch (err) {
      const refusal = gatewayErrorReply(err);
      if (!refusal) throw err;
      request.log.warn({ userId: user.id, ...refusal.body }, 'follow-up refused');
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

    /* ---- the four opening answers, and this thread so far ---- */

    const [{ data: answers }, { data: turns }] = await Promise.all([
      db()
        .from('agent_responses')
        .select('agent, content_md')
        .eq('message_id', messageId)
        .eq('user_id', user.id),
      db()
        .from('agent_followups')
        .select('turn_index, role, content')
        .eq('message_id', messageId)
        .eq('agent', agent)
        .eq('user_id', user.id)
        .order('turn_index', { ascending: true }),
    ]);

    const siblingAnswers: Record<string, string> = {};
    for (const row of (answers ?? []) as Array<{ agent: string; content_md: string | null }>) {
      if (row.content_md) siblingAnswers[row.agent] = row.content_md;
    }

    const ownAnswer = siblingAnswers[agent] ?? '';
    if (!ownAnswer) {
      return reply.code(409).send({
        error: 'no_answer',
        message: 'This specialist has no answer to follow up on.',
      });
    }

    const history = ((turns ?? []) as Array<{ role: string; content: string }>).map((row) => ({
      role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: row.content,
    })) satisfies FollowUpTurn[];

    if (history.length >= MAX_TURNS) {
      return reply.code(409).send({
        error: 'thread_too_long',
        message: 'This conversation has gone as far as it can. Ask it as a new question.',
      });
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

    /* ---- persist the learner's turn before streaming ---- */

    const nextTurn = history.length;
    await db().from('agent_followups').insert({
      user_id: user.id,
      message_id: messageId,
      agent,
      turn_index: nextTurn,
      role: 'user',
      content: safeQuestion,
    });

    /* ---- stream ---- */

    // Same reason as the fan-out: plugin-set headers, CORS above all, live on
    // the reply object and are only flushed by `reply.send()`. This route
    // writes to the raw socket, so they have to be carried across by hand.
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

    send('meta', { agent, turnIndex: nextTurn + 1, model: provider.modelId });

    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    let answered = '';

    try {
      for await (const event of followUpWithAgent(agent, {
        provider,
        question: message.content as string,
        ownAnswer,
        siblingAnswers,
        history,
        followUp: safeQuestion,
        signal: controller.signal,
      })) {
        if (event.type === 'delta') {
          answered += event.text;
          send('delta', { text: event.text });
        } else if (event.type === 'done') {
          answered = event.text;
          void recordUsage({
            userId: user.id,
            task: `followup:${agent}`,
            provider: provider.id,
            model: provider.modelId,
            usage: event.usage,
            latencyMs: event.latencyMs,
          });
        } else {
          // The provider's own message names models and quotas. It is logged,
          // and what goes over the wire is fixed copy.
          request.log.warn({ agent, err: event.message }, 'follow-up failed');
          send('error', { message: AGENT_UNAVAILABLE_MESSAGE });
        }
      }

      // Whatever arrived is kept, including a partial answer from a stream the
      // learner walked away from — it is on their screen either way.
      if (answered) {
        await db().from('agent_followups').insert({
          user_id: user.id,
          message_id: messageId,
          agent,
          turn_index: nextTurn + 1,
          role: 'assistant',
          content: answered,
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
  });
}
