import { assembleProject, type AssembledProject, type SourceFile, type StepFiles } from '@ai-edu/core';

import { db } from './db.js';

/**
 * Reading one project's codebase out of the database.
 *
 * The code lives in three places, and which one wins is the whole question:
 *
 *   step_attempts.submitted_files — what the learner submitted, per attempt.
 *   step_progress.files           — their current editor contents, mid-work.
 *   project_steps.solution_files  — the reference solution.
 *
 * A passing attempt wins, always. The project a learner shows someone has to be
 * the one they wrote; assembling it out of reference solutions would produce a
 * repository of somebody else's code with their name on it.
 *
 * The reference is the fallback, and only that. A step they skipped or never
 * passed would otherwise leave a hole in the middle of the tree, and every step
 * after it would be building on a file that does not exist.
 *
 * Drafts are deliberately NOT used. A draft is whatever is in the editor right
 * now — half a function, a syntax error, an experiment. It is the right thing
 * to restore into the editor and the wrong thing to hand to the next step.
 */

interface StepRow {
  id: string;
  step_index: number;
  solution_files: unknown;
}

/** Files as stored: `[{ path, contents }]`. Anything else is treated as absent. */
function asFiles(value: unknown): SourceFile[] | null {
  if (!Array.isArray(value)) return null;
  const files = value.filter(
    (item): item is SourceFile =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as SourceFile).path === 'string' &&
      typeof (item as SourceFile).contents === 'string',
  );
  return files.length > 0 ? files : null;
}

/**
 * Every step's best available files, in index order.
 *
 * Two queries regardless of step count: one for the steps, one for the passing
 * attempts across all of them. Expanding step 10 of a 12-step project should
 * not cost twenty round trips.
 */
export async function loadStepFiles(projectId: string, userId: string): Promise<StepFiles[]> {
  const { data: stepRows } = await db()
    .from('project_steps')
    .select('id, step_index, solution_files')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .order('step_index', { ascending: true });

  const steps = (stepRows ?? []) as StepRow[];
  if (steps.length === 0) return [];

  const { data: attemptRows } = await db()
    .from('step_attempts')
    .select('step_id, attempt_no, submitted_files, passed')
    .in(
      'step_id',
      steps.map((step) => step.id),
    )
    .eq('user_id', userId)
    .eq('passed', true)
    .order('attempt_no', { ascending: true });

  // The last passing attempt, not the first: a learner who passed, kept
  // refining, and passed again meant the newer one.
  const learnerByStep = new Map<string, SourceFile[]>();
  for (const row of (attemptRows ?? []) as Array<{ step_id: string; submitted_files: unknown }>) {
    const files = asFiles(row.submitted_files);
    if (files) learnerByStep.set(row.step_id, files);
  }

  return steps.map((step) => ({
    stepIndex: step.step_index,
    learnerFiles: learnerByStep.get(step.id) ?? null,
    referenceFiles: asFiles(step.solution_files),
  }));
}

/**
 * The project as step `stepIndex` finds it.
 *
 * This is what turns a lazily expanded step into a continuation rather than a
 * restart: the expansion is handed the real files, with the learner's own code
 * in them, and writes the next step on top.
 */
export async function priorFilesFor(
  projectId: string,
  userId: string,
  stepIndex: number,
): Promise<SourceFile[]> {
  if (stepIndex <= 0) return [];
  const steps = await loadStepFiles(projectId, userId);
  return assembleProject(steps, stepIndex).files;
}

/** The finished project: every step overlaid, in order. */
export async function assembleFinished(
  projectId: string,
  userId: string,
): Promise<AssembledProject> {
  return assembleProject(await loadStepFiles(projectId, userId));
}
