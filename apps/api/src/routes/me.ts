import type { FastifyInstance } from 'fastify';
import { recommendNext, topInterests, type NavProject, type NavSummary, type NavThread } from '@ai-edu/core';

import { requireAuth, userOf } from '../auth.js';
import { loadProjection } from '../brain.js';
import { db } from '../db.js';
import { messageCounts } from './threads.js';

/**
 * The signed-in top bar, in one request.
 *
 * Recent conversations, project counts, interests and the "For you" list come
 * back together so the bar costs one round trip rather than four — and so the
 * header never pulls the whole brain graph just to name six concepts.
 *
 * Each source loads on its own. One that fails comes back `null` and its panel
 * says so; the others still fill. Recommendations are rules in packages/core:
 * no model, no gateway, nothing to budget.
 *
 * Exists only with PROJECT_LEARNER on (registered in server.ts).
 *
 * Every query filters on `user_id` by hand. `db()` holds the service-role key
 * and bypasses RLS — the WHERE clause is what keeps one learner's history
 * their own.
 */

const RECENT_THREADS = 5;
/** Read a few extra: threads whose first message never persisted are dropped. */
const THREAD_READ = 8;
const RECENT_PROJECTS = 3;
/** "Built" counts what the learner started; "learned" what they finished. */
const BUILT = new Set(['active', 'completed']);

interface ThreadRow {
  id: string;
  title: string | null;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/nav-summary', { preHandler: requireAuth }, async (request) => {
    const user = userOf(request);
    const now = new Date().toISOString();

    const [threads, projects, brain] = await Promise.allSettled([
      recentThreads(user.id),
      projectSummary(user.id),
      loadProjection(user.id, { nodeKinds: ['concept'], edgeKinds: ['ACTIVATED', 'RELATED_TO'] }),
    ]);

    if (threads.status === 'rejected') request.log.warn({ err: threads.reason }, 'nav summary: threads failed');
    if (projects.status === 'rejected') request.log.warn({ err: projects.reason }, 'nav summary: projects failed');
    if (brain.status === 'rejected') request.log.warn({ err: brain.reason }, 'nav summary: brain failed');

    const threadList = threads.status === 'fulfilled' ? threads.value : null;
    const projectData = projects.status === 'fulfilled' ? projects.value : null;
    const projection = brain.status === 'fulfilled' ? brain.value : null;

    const summary: NavSummary = {
      workspace: threadList ? { recent: threadList.slice(0, RECENT_THREADS) } : null,
      projects: projectData
        ? { built: projectData.built, learned: projectData.learned, recent: projectData.recent }
        : null,
      brain: projection
        ? { interests: topInterests(projection.nodes, projection.edges, now), conceptCount: projection.nodes.length }
        : null,
      recommendations: recommendNext({
        nodes: projection?.nodes ?? [],
        edges: projection?.edges ?? [],
        projects: projectData?.all ?? null,
        threads: threadList,
        now,
      }),
      generatedAt: now,
    };
    return summary;
  });
}

async function recentThreads(userId: string): Promise<NavThread[]> {
  const { data, error } = await db()
    .from('threads')
    .select('id, title, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(THREAD_READ);
  if (error) throw new Error(`could not load threads: ${error.message}`);

  const rows = (data ?? []) as ThreadRow[];
  const counts = await messageCounts(rows.map((row) => row.id));
  return rows
    .filter((row) => (counts.get(row.id) ?? 0) > 0)
    .map((row) => ({
      id: row.id,
      title: row.title ?? 'Untitled conversation',
      updatedAt: row.updated_at,
      messageCount: counts.get(row.id) ?? 0,
    }));
}

async function projectSummary(
  userId: string,
): Promise<{ built: number; learned: number; recent: NavProject[]; all: NavProject[] }> {
  const { data, error } = await db()
    .from('projects')
    .select('id, title, status, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`could not load projects: ${error.message}`);

  const all: NavProject[] = ((data ?? []) as ProjectRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
    currentStep: null,
    stepCount: null,
  }));

  // Active first — that is the one worth a click — then newest.
  const recent = [...all]
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
    .slice(0, RECENT_PROJECTS);
  await addProgress(userId, recent);

  return {
    built: all.filter((project) => BUILT.has(project.status)).length,
    learned: all.filter((project) => project.status === 'completed').length,
    recent,
    all,
  };
}

/**
 * "Step N of M" for the few projects the panel shows. Best effort: without it
 * a row shows only its status, which is no reason to fail the section.
 */
async function addProgress(userId: string, projects: NavProject[]): Promise<void> {
  if (projects.length === 0) return;
  const ids = projects.map((project) => project.id);

  const [enrollments, steps] = await Promise.all([
    db().from('enrollments').select('project_id, current_step_index').eq('user_id', userId).in('project_id', ids),
    db().from('project_steps').select('project_id').eq('user_id', userId).in('project_id', ids),
  ]);

  const current = new Map<string, number>();
  if (!enrollments.error) {
    for (const row of (enrollments.data ?? []) as Array<{ project_id: string; current_step_index: number }>) {
      current.set(row.project_id, row.current_step_index);
    }
  }
  const counts = new Map<string, number>();
  if (!steps.error) {
    for (const row of (steps.data ?? []) as Array<{ project_id: string }>) {
      counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
    }
  }

  for (const project of projects) {
    project.currentStep = current.get(project.id) ?? null;
    project.stepCount = counts.get(project.id) ?? null;
  }
}
