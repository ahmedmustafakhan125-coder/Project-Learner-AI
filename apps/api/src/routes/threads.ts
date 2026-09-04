import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ORDER, type AgentKind } from '@ai-edu/core';

import { requireAuth, userOf } from '../auth.js';
import { db } from '../db.js';

/**
 * Conversation history.
 *
 * The fan-out route has always written `threads`, `messages` and
 * `agent_responses`; nothing ever read them back, so every answer a learner
 * produced was lost the moment they navigated away. These are the read paths
 * that turn that storage into the history rail on the workspace.
 *
 * Every query filters on `user_id` by hand. `db()` holds the service-role key
 * and therefore bypasses RLS — the WHERE clause is the only thing standing
 * between one learner and another's transcript.
 */

/** Kept small: the rail is a rail, not an archive browser. */
const LIST_LIMIT = 60;

/** Enough for a long conversation without letting one thread page forever. */
const MESSAGE_LIMIT = 100;

const ThreadIdParam = z.object({ id: z.string().uuid() });

const RenameBody = z.object({ title: z.string().trim().min(1).max(200) });

interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface AgentResponseRow {
  message_id: string;
  agent: AgentKind;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  content_md: string | null;
  error: string | null;
  model: string | null;
}

export async function threadRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- list ---------------- */

  app.get('/api/threads', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const { data, error } = await db()
      .from('threads')
      .select('id, title, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT);

    if (error) {
      request.log.error({ err: error.message }, 'failed to list threads');
      return reply.code(500).send({ error: 'list_failed', message: 'Could not load your history.' });
    }

    const threads = (data ?? []) as ThreadRow[];

    /*
     * A thread whose first message never persisted would render as an empty row
     * the learner can click but not open. Counting messages in one grouped
     * query keeps those out of the rail without N+1 round trips.
     */
    const counts = await messageCounts(threads.map((thread) => thread.id));

    return reply.send({
      threads: threads
        .filter((thread) => (counts.get(thread.id) ?? 0) > 0)
        .map((thread) => ({
          id: thread.id,
          title: thread.title ?? 'Untitled conversation',
          createdAt: thread.created_at,
          updatedAt: thread.updated_at,
          messageCount: counts.get(thread.id) ?? 0,
        })),
    });
  });

  /* ---------------- one transcript ---------------- */

  app.get('/api/threads/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const params = ThreadIdParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid thread id.' });
    }

    const { data: thread, error: threadErr } = await db()
      .from('threads')
      .select('id, title, created_at, updated_at')
      .eq('id', params.data.id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (threadErr) {
      request.log.error({ err: threadErr.message }, 'failed to load thread');
      return reply
        .code(500)
        .send({ error: 'load_failed', message: 'Could not load that conversation.' });
    }
    if (!thread) {
      return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
    }

    const { data: messageData, error: messageErr } = await db()
      .from('messages')
      .select('id, role, content, created_at')
      .eq('thread_id', params.data.id)
      .eq('user_id', user.id)
      .eq('role', 'user')
      .order('created_at', { ascending: true })
      .limit(MESSAGE_LIMIT);

    if (messageErr) {
      request.log.error({ err: messageErr.message }, 'failed to load thread messages');
      return reply
        .code(500)
        .send({ error: 'load_failed', message: 'Could not load that conversation.' });
    }

    const messages = (messageData ?? []) as MessageRow[];
    const responses = await agentResponses(
      messages.map((message) => message.id),
      user.id,
    );
    const row = thread as ThreadRow;

    return reply.send({
      thread: {
        id: row.id,
        title: row.title ?? 'Untitled conversation',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      turns: messages.map((message) => ({
        messageId: message.id,
        question: message.content,
        askedAt: message.created_at,
        // Always all four agents, in the canonical order, even when a row is
        // missing: the UI renders four panes and a hole in the middle of them
        // reads as a bug rather than as a specialist that never answered.
        panes: Object.fromEntries(
          AGENT_ORDER.map((agent) => {
            const found = responses.get(`${message.id}:${agent}`);
            const text = found?.content_md ?? '';
            return [
              agent,
              {
                status: text ? ('complete' as const) : ('error' as const),
                text,
                error: text ? null : 'This specialist did not finish.',
              },
            ];
          }),
        ),
      })),
    });
  });

  /* ---------------- rename ---------------- */

  app.patch('/api/threads/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const params = ThreadIdParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid thread id.' });
    }
    const body = RenameBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'A title is required.' });
    }

    const { data, error } = await db()
      .from('threads')
      .update({ title: body.data.title, updated_at: new Date().toISOString() })
      .eq('id', params.data.id)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle();

    if (error) {
      request.log.error({ err: error.message }, 'failed to rename thread');
      return reply
        .code(500)
        .send({ error: 'rename_failed', message: 'Could not rename that conversation.' });
    }
    if (!data) return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });

    return reply.send({ ok: true });
  });

  /* ---------------- delete ---------------- */

  app.delete('/api/threads/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = userOf(request);

    const params = ThreadIdParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid thread id.' });
    }

    // Messages, agent responses and exercises all cascade from the thread row.
    const { data, error } = await db()
      .from('threads')
      .delete()
      .eq('id', params.data.id)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle();

    if (error) {
      request.log.error({ err: error.message }, 'failed to delete thread');
      return reply
        .code(500)
        .send({ error: 'delete_failed', message: 'Could not delete that conversation.' });
    }
    if (!data) return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });

    return reply.send({ ok: true });
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function messageCounts(threadIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (threadIds.length === 0) return counts;

  const { data } = await db()
    .from('messages')
    .select('thread_id')
    .in('thread_id', threadIds)
    .eq('role', 'user');

  for (const row of (data ?? []) as Array<{ thread_id: string }>) {
    counts.set(row.thread_id, (counts.get(row.thread_id) ?? 0) + 1);
  }
  return counts;
}

async function agentResponses(
  messageIds: string[],
  userId: string,
): Promise<Map<string, AgentResponseRow>> {
  const byKey = new Map<string, AgentResponseRow>();
  if (messageIds.length === 0) return byKey;

  const { data } = await db()
    .from('agent_responses')
    .select('message_id, agent, status, content_md, error, model')
    .in('message_id', messageIds)
    .eq('user_id', userId);

  for (const row of (data ?? []) as AgentResponseRow[]) {
    byKey.set(`${row.message_id}:${row.agent}`, row);
  }
  return byKey;
}
