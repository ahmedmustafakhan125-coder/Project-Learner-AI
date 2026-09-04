import { lockStates, mayExpand, unlockedThrough, type StepLockState } from '@ai-edu/core';

import { db } from './db.js';

/**
 * Reading a learner's progress through one project.
 *
 * The lock rule itself lives in `@ai-edu/core` so the server and the browser
 * cannot disagree about it. This is the part that has to happen here: loading
 * the rows it reasons over, and doing it in two queries rather than one per
 * step.
 *
 * Every route that gates on progress goes through this. The client renders
 * locks, but the client is not the gate — an expansion or an attempt posted
 * straight to the API would otherwise walk past it.
 */

export interface ProjectProgress {
  /** Step rows, ordered, with their id so callers can query attempts. */
  steps: Array<{ id: string; index: number; passed: boolean }>;
  /** Highest step index the learner may work on. */
  unlockedThrough: number;
  locks: StepLockState[];
  /** How far the enrollment says they got. Zero on projects predating advance. */
  furthestReached: number;
}

export async function loadProgress(projectId: string, userId: string): Promise<ProjectProgress> {
  const [{ data: stepRows }, { data: enrollment }] = await Promise.all([
    db()
      .from('project_steps')
      .select('id, step_index')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('step_index', { ascending: true }),
    db()
      .from('enrollments')
      .select('current_step_index')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const rows = (stepRows ?? []) as Array<{ id: string; step_index: number }>;
  const furthestReached = (enrollment?.current_step_index as number | undefined) ?? 0;

  if (rows.length === 0) {
    return { steps: [], unlockedThrough: 0, locks: [], furthestReached };
  }

  const { data: passedRows } = await db()
    .from('step_attempts')
    .select('step_id')
    .in('step_id', rows.map((row) => row.id))
    .eq('user_id', userId)
    .eq('passed', true);

  const passedIds = new Set((passedRows ?? []).map((row) => row.step_id as string));
  const steps = rows.map((row) => ({
    id: row.id,
    index: row.step_index,
    passed: passedIds.has(row.id),
  }));

  return {
    steps,
    unlockedThrough: unlockedThrough(steps, furthestReached),
    locks: lockStates(steps, furthestReached),
    furthestReached,
  };
}

/** Whether generation may run for this step. One past the frontier, no further. */
export function canExpand(progress: ProjectProgress, index: number): boolean {
  return mayExpand(progress.steps, index, progress.furthestReached);
}

/** Whether the learner may submit work here. Strictly the unlocked frontier. */
export function canAttempt(progress: ProjectProgress, index: number): boolean {
  return index <= progress.unlockedThrough;
}
