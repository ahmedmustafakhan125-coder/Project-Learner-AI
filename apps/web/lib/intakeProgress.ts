import type { ComplexityTier } from '@ai-edu/core';

/**
 * The progress card between the project questions and the Stack Brief
 * (PROJECT_LEARNER), worked out without React so it can be tested on its own.
 *
 * It replaces the profile and tier chips the learner used to stop at: one
 * sequence of steps, each done, running, waiting or failed. The tier decides
 * what research does, but is never named. The research and brief routes
 * return only when done (streaming progress is week 2), so the line under the
 * running step is honest about what happens in what order, not about how far
 * along it is.
 */

export type StepId = 'scope' | 'questions' | 'research' | 'brief';
export type StepStatus = 'done' | 'active' | 'todo' | 'failed';

export interface ProgressStep {
  id: StepId;
  label: string;
  status: StepStatus;
  /** What is happening now; on the running step only. */
  detail?: string;
}

export interface ProgressInput {
  /** The step running now, or the one that failed. */
  current: StepId;
  failed: boolean;
  /** Round 2 was asked: a bigger project. */
  askedMore: boolean;
  /** A very similar stored project is adapted instead of planned afresh. */
  adapted: boolean;
  tier: ComplexityTier | null;
  /** How many detail lines have come up while the current step runs. */
  tick: number;
}

/** What research does, in order: tech cards always, live documentation from T2. */
export function researchLines(tier: ComplexityTier | null, adapted: boolean): string[] {
  if (adapted) return ['Found a very similar project; reusing its research…'];
  const read = tier === 'T1' ? [] : ['Searching the official documentation…', 'Reading the pages that matter…'];
  return ['Reading the tech cards…', ...read];
}

export function briefLines(adapted: boolean): string[] {
  if (adapted) return ['Checking its Stack Brief against your request…'];
  return ['Writing your Stack Brief…', 'Checking every layer against its sources…'];
}

export function progressSteps(input: ProgressInput): ProgressStep[] {
  const { current, failed, askedMore, adapted, tier, tick } = input;
  const lines: Record<StepId, string[]> = {
    scope: ['Working out what it needs…'],
    questions: [],
    research: researchLines(tier, adapted),
    brief: briefLines(adapted),
  };
  const labels: Record<StepId, string> = {
    scope: 'Understanding your project',
    questions: 'A few more questions',
    research: adapted ? 'Reusing a similar project' : 'Reading the documentation',
    brief: 'Choosing your stack',
  };
  const order: StepId[] = ['scope', ...(askedMore ? (['questions'] as const) : []), 'research', 'brief'];
  const at = order.indexOf(current);

  return order.map((id, index) => {
    const status: StepStatus = index < at ? 'done' : index > at ? 'todo' : failed ? 'failed' : 'active';
    const detail = status === 'active' ? lines[id][Math.min(tick, lines[id].length - 1)] : undefined;
    return { id, label: labels[id], status, ...(detail ? { detail } : {}) };
  });
}
