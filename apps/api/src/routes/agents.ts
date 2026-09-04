import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ORDER, CompiledQuery, fanOut } from '@ai-edu/core';
import { createProviderForTask } from '@ai-edu/llm';

import { requireAuth, userOf } from '../auth.js';
import { checkBudget, db, recordUsage } from '../db.js';
import { gatewayErrorReply, screenOrThrow } from '../gateway.js';
import { knowledgeBundle } from '../knowledge.js';

/**
 * The four-agent fan-out, streamed to the browser.
 *
 * All four agents share ONE SSE connection rather than opening four. Browsers
 * cap concurrent HTTP/1.1 connections per origin at six, so four streams per
 * question would starve every other request on the page — and a single
 * multiplexed stream is also the shape that ports to a WebSocket on mobile.
 */

/** Shown to the learner when a specialist fails. Provider errors stay server-side. */
const AGENT_UNAVAILABLE_MESSAGE = 'This specialist is temporarily unavailable. Try again shortly.';

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

    /*
     * Screening happens HERE, not only during the interview.
     *
     * This route accepts a client-supplied CompiledQuery: the browser posts the
     * finished prompt object. Anything that screened the raw query upstream is
     * therefore bypassable by posting straight to this endpoint, which makes
     * this the only placement that actually enforces anything.
     *
     * It runs before the budget check and before a provider exists, so a
     * blocked prompt costs nothing. Attachment text is screened too — an
     * uploaded file is the more likely injection carrier of the two.
     */
    let screened;
    try {
      screened = {
        ...compiled,
        text: await screenOrThrow(compiled.text, `ask:${user.id}:${threadId ?? 'new'}`),
        attachments: await Promise.all(
          compiled.attachments.map(async (file) =>
            file.extractedText
              ? {
                  ...file,
                  extractedText: await screenOrThrow(
                    file.extractedText,
                    `ask-attachment:${user.id}:${file.id}`,
                  ),
                }
              : file,
          ),
        ),
      };
    } catch (err) {
      const refusal = gatewayErrorReply(err);
      if (refusal) {
        request.log.warn(
          { userId: user.id, ...refusal.body },
          'prompt refused by security gateway',
        );
        return reply.code(refusal.status).send(refusal.body);
      }
      throw err;
    }

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

    const persisted = await persistQuestion(user.id, threadId, screened);
    const messageId = persisted.messageId;

    /* ---- open the SSE stream ---- */

    // Plugin-set headers — CORS above all — live on the Fastify reply object and
    // are only flushed by `reply.send()`. This route writes to the raw socket
    // instead, so they have to be carried across by hand: without them the
    // browser blocks the cross-origin stream and `fetch` rejects with
    // "Failed to fetch" before a single token arrives.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }

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

    // The thread id goes back to the browser so a follow-up question lands in
    // the same conversation instead of spawning a new row in the history rail
    // for every single question.
    send('meta', {
      messageId,
      threadId: persisted.threadId,
      model: provider.modelId,
      agents: AGENT_ORDER,
    });

    // Aborting on disconnect is what actually stops tokens being spent. The
    // fan-out detaches its in-flight work when the consumer walks away, so
    // without this the requests would run to completion unread.
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    const buffers = new Map<string, string>();

    try {
      for await (const event of fanOut({
        provider,
        compiled: screened,
        // Curated OKF concepts, selected deterministically inside the fan-out so
        // all four agents get identical bytes and share one cache entry.
        knowledge: knowledgeBundle(),
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
            //
            // The provider's own message is a diagnostic: it can name models,
            // quotas, or internal failures a learner should not be reading. It
            // is logged and persisted, but what goes over the wire is fixed copy.
            request.log.warn(
              { agent: event.agent, err: event.message, retryable: event.retryable },
              'fan-out agent failed',
            );
            send('agent', {
              agent: event.agent,
              type: 'error',
              message: AGENT_UNAVAILABLE_MESSAGE,
              retryable: event.retryable,
            });
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

interface PersistedQuestion {
  messageId: string;
  /** Null only when the thread insert itself failed. */
  threadId: string | null;
}

async function persistQuestion(
  userId: string,
  threadId: string | null,
  compiled: z.infer<typeof CompiledQuery>,
): Promise<PersistedQuestion> {
  /*
   * A supplied thread id is client input and has to be proved to belong to the
   * caller before anything is written under it. `db()` uses the service-role
   * key and bypasses RLS, so without this check any learner could post another
   * learner's thread id and append messages to their conversation. An id that
   * does not check out is not an error — it is simply treated as a new
   * conversation, which is also what happens when a thread has since been
   * deleted from another tab.
   */
  let resolvedThreadId: string | null = null;

  if (threadId) {
    const { data } = await db()
      .from('threads')
      .select('id')
      .eq('id', threadId)
      .eq('user_id', userId)
      .maybeSingle();
    resolvedThreadId = data?.id ?? null;
  }

  const startedNewThread = !resolvedThreadId;

  if (!resolvedThreadId) {
    const { data } = await db()
      .from('threads')
      .insert({ user_id: userId, title: compiled.originalQuery.slice(0, 120) })
      .select('id')
      .single();
    resolvedThreadId = data?.id ?? null;
  }

  const { data: message, error: messageErr } = await db()
    .from('messages')
    .insert({
      thread_id: resolvedThreadId,
      user_id: userId,
      role: 'user',
      content: compiled.originalQuery,
    })
    .select('id')
    .single();

  if (messageErr) {
    console.error('[agents] failed to persist user message:', messageErr.message);
  }

  const messageId = message?.id ?? crypto.randomUUID();

  if (message?.id) {
    // Four placeholder rows up front, so a page reloaded mid-stream shows four
    // pending tabs rather than an empty screen.
    const { error: placeholderErr } = await db()
      .from('agent_responses')
      .insert(
        AGENT_ORDER.map((agent) => ({
          message_id: messageId,
          user_id: userId,
          agent,
          status: 'pending' as const,
        })),
      );
    if (placeholderErr) {
      console.error('[agents] failed to persist placeholder agent responses:', placeholderErr.message);
    }
  }

  // A thread's position in the history rail is its `updated_at`, and the
  // column only defaults on insert — without this touch every follow-up sinks
  // the conversation the learner is actively working in.
  if (!startedNewThread && resolvedThreadId) {
    const { error: touchErr } = await db()
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', resolvedThreadId)
      .eq('user_id', userId);
    if (touchErr) console.error('[agents] failed to touch thread:', touchErr.message);
  }

  return { messageId, threadId: resolvedThreadId };
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
  messageId: string | undefined,
  agent: string,
  args: FinaliseArgs,
): Promise<void> {
  if (!messageId || messageId === 'undefined') return;

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
