import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ORDER, CompiledQuery, fanOut } from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { checkBudget, db, recordUsage } from '../db.js';

/**
 * The four-agent fan-out, streamed to the browser.
 *
 * All four agents share ONE SSE connection rather than opening four. Browsers
 * cap concurrent HTTP/1.1 connections per origin at six, so four streams per
 * question would starve every other request on the page — and a single
 * multiplexed stream is also the shape that ports to a WebSocket on mobile.
 */

const AskBody = z.object({
  threadId: z.string().uuid().nullable().default(null),
  compiled: CompiledQuery,
  /** Registry model id. Falls back to the task default when absent or unusable. */
  model: z.string().optional(),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/agents/ask', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const parsed = AskBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { compiled, model, threadId } = parsed.data;

    // Budget is checked before the call, never after — one expensive request
    // could otherwise sail past the ceiling with nothing to stop it.
    const budget = await checkBudget(user.id);
    if (budget.exceeded) {
      return reply.code(429).send({
        error: 'budget_exceeded',
        message:
          `You have used $${budget.spentUSD.toFixed(2)} of your $${budget.limitUSD.toFixed(2)} ` +
          `daily allowance. It resets 24 hours after each request.`,
        spentUSD: budget.spentUSD,
        limitUSD: budget.limitUSD,
      });
    }

    let provider;
    try {
      provider = createProviderForTask('fanout', model);
    } catch (err) {
      return reply.code(503).send({
        error: 'no_provider',
        message: err instanceof Error ? err.message : 'No LLM provider configured.',
      });
    }

    /* ---- persist the question and four placeholder rows ---- */

    const messageId = await persistQuestion(user.id, threadId, compiled);

    /* ---- open the SSE stream ---- */

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer streamed responses by default, which makes a
      // token-by-token UI arrive as one lump at the end.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { messageId, model: provider.modelId, agents: AGENT_ORDER });

    // Aborting on disconnect is what actually stops tokens being spent. The
    // fan-out detaches its in-flight work when the consumer walks away, so
    // without this the requests would run to completion unread.
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    const buffers = new Map<string, string>();

    try {
      for await (const event of fanOut({
        provider,
        compiled,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'start':
            send('agent', { agent: event.agent, type: 'start' });
            break;

          case 'delta':
            buffers.set(event.agent, (buffers.get(event.agent) ?? '') + event.text);
            send('agent', { agent: event.agent, type: 'delta', text: event.text });
            break;

          case 'done': {
            send('agent', { agent: event.agent, type: 'done' });
            void recordUsage({
              userId: user.id,
              task: `fanout:${event.agent}`,
              provider: provider.id,
              model: provider.modelId,
              usage: event.usage,
              latencyMs: event.latencyMs,
            });
            void finaliseAgent(messageId, event.agent, {
              status: 'complete',
              content: event.text,
              model: provider.modelId,
              usage: event.usage,
              latencyMs: event.latencyMs,
            });
            break;
          }

          case 'error':
            // Reported per agent. The other three still stream — a learner
            // getting three of four angles is far better than getting none.
            send('agent', { agent: event.agent, type: 'error', message: event.message });
            void finaliseAgent(messageId, event.agent, {
              status: 'error',
              content: buffers.get(event.agent) ?? '',
              error: event.message,
            });
            break;
        }
      }

      send('done', { messageId });
    } catch (err) {
      send('fatal', { message: err instanceof Error ? err.message : 'Stream failed.' });
    } finally {
      reply.raw.end();
    }

    return reply;
  });
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

async function persistQuestion(
  userId: string,
  threadId: string | null,
  compiled: z.infer<typeof CompiledQuery>,
): Promise<string> {
  let resolvedThreadId = threadId;

  if (!resolvedThreadId) {
    const { data } = await db()
      .from('threads')
      .insert({ user_id: userId, title: compiled.originalQuery.slice(0, 120) })
      .select('id')
      .single();
    resolvedThreadId = data?.id ?? null;
  }

  const { data: message } = await db()
    .from('messages')
    .insert({
      thread_id: resolvedThreadId,
      user_id: userId,
      role: 'user',
      content: compiled.originalQuery,
    })
    .select('id')
    .single();

  const messageId = message?.id as string;

  // Four placeholder rows up front, so a page reloaded mid-stream shows four
  // pending tabs rather than an empty screen.
  await db()
    .from('agent_responses')
    .insert(
      AGENT_ORDER.map((agent) => ({
        message_id: messageId,
        user_id: userId,
        agent,
        status: 'pending' as const,
      })),
    );

  return messageId;
}

interface FinaliseArgs {
  status: 'complete' | 'error';
  content: string;
  model?: string;
  usage?: unknown;
  latencyMs?: number;
  error?: string;
}

async function finaliseAgent(
  messageId: string,
  agent: string,
  args: FinaliseArgs,
): Promise<void> {
  const { error } = await db()
    .from('agent_responses')
    .update({
      status: args.status,
      content_md: args.content,
      model: args.model ?? null,
      usage: args.usage ?? null,
      latency_ms: args.latencyMs ?? null,
      error: args.error ?? null,
    })
    .eq('message_id', messageId)
    .eq('agent', agent);

  if (error) console.error(`[agents] failed to persist ${agent}:`, error.message);
}
