import type { ProjectTier } from '@ai-edu/llm';

import { parseTimeBudget } from '../interview/complexity.js';
import { matchesGlob } from '../profiles/glob.js';
import type { Profile } from '../profiles/types.js';
import type { Slots } from '../schemas/interview.js';
import type { PlannedBlueprint } from '../schemas/project.js';
import type { ResearchDossier } from '../schemas/research.js';
import type { StackBrief } from '../schemas/stack.js';
import { techStackFromBrief } from '../stack/techStack.js';

/**
 * `verifyBlueprint` (docs/project-learner.md §9). Pure, and run on every plan
 * written against a Stack Brief.
 *
 * The profile's architecture rule is data checked here, not advice in a
 * prompt (invariant 27). `reconcileFilePlan` has already repaired the file
 * plan, so what is left is serious only when code cannot fix it: a step count
 * outside the tier's range or a broken architecture rule, each worth the one
 * regeneration. A plan over the learner's time is a warning, shown with it.
 */

/** Steps per plan, by tier (§5). T4 and T5 plan milestone 1 on its own. */
export const STEP_RANGE: Record<ProjectTier, readonly [number, number]> = {
  T1: [3, 6],
  T2: [5, 9],
  T3: [8, 12],
  T4: [3, 12],
  T5: [3, 12],
};

/** How far the step minutes may run past the learner's stated time (§9). */
export const TIME_SLACK = 0.25;

export type BlueprintRule = 'steps' | 'architecture' | 'time' | 'docRefs';

export interface BlueprintViolation {
  rule: BlueprintRule;
  /** Serious costs the regeneration; a warning ships with the plan; repaired was fixed in code. */
  severity: 'serious' | 'warning' | 'repaired';
  message: string;
  stepIndex?: number;
}

export interface VerifyBlueprintInput {
  brief: StackBrief;
  profile: Profile;
  tier: ProjectTier;
  slots: Slots;
  dossier: ResearchDossier | null;
}

export interface BlueprintCheck {
  /** The plan with its stack from the brief and its references cleaned. */
  blueprint: PlannedBlueprint;
  violations: BlueprintViolation[];
}

const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()} `;

/** The references of every brief layer a step names, for a step that cited none. */
function refsByLayer(step: PlannedBlueprint['steps'][number], brief: StackBrief): string[] {
  const text = words([step.title, step.objective, ...step.concepts].join(' '));
  const refs: string[] = [];
  for (const layer of brief.layers) {
    const name = words(layer.name).trim();
    if (name && text.includes(` ${name} `)) refs.push(...layer.docRefs);
  }
  return [...new Set(refs)];
}

export function hasSeriousBlueprintViolation(violations: BlueprintViolation[]): boolean {
  return violations.some((v) => v.severity === 'serious');
}

export function verifyBlueprint(plan: PlannedBlueprint, input: VerifyBlueprintInput): BlueprintCheck {
  const { brief, profile, tier, slots, dossier } = input;
  const violations: BlueprintViolation[] = [];
  const add = (rule: BlueprintRule, severity: BlueprintViolation['severity'], message: string, stepIndex?: number) =>
    violations.push({ rule, severity, message, ...(stepIndex === undefined ? {} : { stepIndex }) });

  /* ---------------- size ---------------- */

  const [least, most] = STEP_RANGE[tier];
  if (plan.steps.length < least || plan.steps.length > most) {
    add('steps', 'serious', `${plan.steps.length} steps; a ${tier} plan has ${least} to ${most}`);
  }

  const hours = parseTimeBudget(slots['time_budget']?.value ?? '');
  const minutes = plan.steps.reduce((sum, s) => sum + s.estMinutes, 0);
  if (hours !== null && minutes > hours * 60 * (1 + TIME_SLACK)) {
    add('time', 'warning', `the steps add up to about ${Math.round(minutes / 60)} hours; the learner has about ${hours}`);
  }

  /* ---------------- the profile's architecture rule ---------------- */

  const rule = profile.architectureRule;
  const tree = plan.finalFileTree.map((f) => f.path);
  for (const glob of rule.requiredPaths) {
    if (!tree.some((path) => matchesGlob(glob, path))) {
      add('architecture', 'serious', `no planned file matches ${glob} (${rule.description})`);
    }
  }
  const first = plan.steps[0];
  for (const glob of rule.firstStepCreates) {
    if (first && !first.creates.some((path) => matchesGlob(glob, path))) {
      add('architecture', 'serious', `step 1 must create a file matching ${glob}`, 0);
    }
  }
  for (const glob of rule.everyStepEdits ?? []) {
    plan.steps.forEach((step, index) => {
      if (index === 0) return;
      if (![...step.creates, ...step.edits].some((path) => matchesGlob(glob, path))) {
        add('architecture', 'serious', `step ${index + 1} must create or edit a file matching ${glob}`, index);
      }
    });
  }

  /* ---------------- references ---------------- */

  const known = new Set((dossier?.docRefs ?? []).map((r) => r.id));
  const steps = plan.steps.map((step, index) => {
    const cited = [...new Set(step.docRefs.map((r) => r.replace(/[[\]\s]/g, '')))];
    let docRefs = cited.filter((r) => known.has(r));
    if (docRefs.length < cited.length) add('docRefs', 'repaired', `dropped references not in the dossier`, index);
    if (docRefs.length === 0 && known.size > 0) {
      docRefs = refsByLayer(step, brief).filter((r) => known.has(r));
      if (docRefs.length) add('docRefs', 'repaired', `cited the references of the layers it names`, index);
    }
    return { ...step, docRefs };
  });

  // Invariant 17: the brief is the only source of stack truth.
  return { blueprint: { ...plan, techStack: techStackFromBrief(brief), steps }, violations };
}

/** The regeneration's trailing turn: what failed, so the planner can fix exactly that. */
export function renderBlueprintViolations(violations: BlueprintViolation[]): string {
  const serious = violations.filter((v) => v.severity === 'serious');
  return `<previous_attempt_problems>\nYour previous plan failed these checks. Fix every one, and keep everything else:\n${serious
    .map((v) => `- ${v.message}`)
    .join('\n')}\n</previous_attempt_problems>`;
}
