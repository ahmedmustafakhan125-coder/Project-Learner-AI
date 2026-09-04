import type { SourceFile } from '../schemas/step.js';
import { normalisePath } from './blueprint.js';

/**
 * Assembling one project out of many steps.
 *
 * A step's files are not a snapshot of the whole project — they are the project
 * as it stood when that step ended. Laying them over one another in order gives
 * the codebase at any point in time, which is what makes the sequence a build
 * rather than a set of exercises. Step 5 opens on the result of step 4; the
 * finished project is the result of the last one.
 *
 * Deliberately pure and LLM-free. This runs on every step expansion and on
 * every export, and it must give the same answer every time.
 */

/**
 * Where a step's contribution came from.
 *
 * The learner's own passing submission is preferred everywhere — a portfolio
 * project made of someone else's code is not a portfolio project. The reference
 * solution is the fallback for a step they skipped or never passed, because the
 * alternative is a hole in the middle of the tree that breaks every step after
 * it.
 */
export type StepSourceKind = 'learner' | 'reference' | 'missing';

export interface StepFiles {
  stepIndex: number;
  /** The learner's passing submission, if they have one. */
  learnerFiles: SourceFile[] | null;
  /** The step's reference solution. Null before the step is expanded. */
  referenceFiles: SourceFile[] | null;
}

export interface AssembledProject {
  files: SourceFile[];
  /** Steps that contributed the reference solution rather than the learner's code. */
  stepsFromReference: number[];
  /** Steps that contributed nothing at all — not expanded, never attempted. */
  stepsMissing: number[];
  /** True when every step that contributed anything contributed the learner's own work. */
  fullyLearnerWritten: boolean;
}

/**
 * Overlay each step's files in index order, last writer wins per path.
 *
 * `upTo` is exclusive, so `assembleProject(steps, 4)` is "the project as step 4
 * finds it" and omitting it is "the finished project".
 */
export function assembleProject(steps: StepFiles[], upTo?: number): AssembledProject {
  const limit = upTo ?? Number.POSITIVE_INFINITY;
  const byPath = new Map<string, string>();
  const stepsFromReference: number[] = [];
  const stepsMissing: number[] = [];
  let contributed = 0;

  for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (step.stepIndex >= limit) break;

    const kind = sourceKindOf(step);
    if (kind === 'missing') {
      stepsMissing.push(step.stepIndex);
      continue;
    }
    if (kind === 'reference') stepsFromReference.push(step.stepIndex);
    contributed += 1;

    const files = kind === 'learner' ? step.learnerFiles! : step.referenceFiles!;
    for (const file of files) {
      const path = normalisePath(file.path);
      // An empty path would collide with every other empty path and land in the
      // export as a file nobody can open.
      if (path) byPath.set(path, file.contents);
    }
  }

  return {
    files: [...byPath.entries()]
      .map(([path, contents]) => ({ path, contents }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    stepsFromReference,
    stepsMissing,
    fullyLearnerWritten: contributed > 0 && stepsFromReference.length === 0,
  };
}

/** Which of a step's two possible contributions is actually usable. */
export function sourceKindOf(step: StepFiles): StepSourceKind {
  if (step.learnerFiles && step.learnerFiles.length > 0) return 'learner';
  if (step.referenceFiles && step.referenceFiles.length > 0) return 'reference';
  return 'missing';
}

/* ------------------------------------------------------------------ *
 * Rendering for the prompt
 * ------------------------------------------------------------------ */

/**
 * How much of the accumulated codebase to put in front of the model.
 *
 * The tree grows with every step, and by step ten a naive dump would be most of
 * the context window — on a call that also has to fit the blueprint, the step
 * brief and a full expansion. Files this step will actually touch are sent in
 * full; the rest are listed by path so the model still knows they exist and
 * does not recreate them.
 */
const FULL_CONTENTS_BUDGET = 24_000;

export interface RenderProjectStateOptions {
  files: SourceFile[];
  /** Paths this step creates or edits. These are sent in full, first. */
  focusPaths?: string[];
  budget?: number;
}

export function renderProjectState(options: RenderProjectStateOptions): string {
  const { files, focusPaths = [], budget = FULL_CONTENTS_BUDGET } = options;

  if (files.length === 0) {
    return '<project_state>\nThe project is empty. This is the first step, and nothing exists yet.\n</project_state>';
  }

  const focus = new Set(focusPaths.map(normalisePath));
  // Files the step is about to change come first and are never truncated away:
  // editing a file you were only shown the name of is guesswork.
  const ordered = [...files].sort((a, b) => {
    const aFocus = focus.has(a.path) ? 0 : 1;
    const bFocus = focus.has(b.path) ? 0 : 1;
    return aFocus - bFocus || a.path.localeCompare(b.path);
  });

  const lines = [
    '<project_state>',
    'The project as the learner has it right now. Your step continues from exactly this.',
    '',
  ];
  const omitted: string[] = [];
  let spent = 0;

  for (const file of ordered) {
    const required = focus.has(file.path);
    if (!required && spent + file.contents.length > budget) {
      omitted.push(file.path);
      continue;
    }
    spent += file.contents.length;
    lines.push(`<file path="${file.path}">`, file.contents, '</file>', '');
  }

  if (omitted.length > 0) {
    lines.push(
      'These files also exist and are unchanged by this step. Do not recreate them:',
      ...omitted.sort().map((path) => `  - ${path}`),
      '',
    );
  }

  lines.push('</project_state>');
  return lines.join('\n');
}
