import { describe, expect, it } from 'vitest';

import { normaliseBlueprint } from '../src/generation/blueprint.js';
import { normaliseStep, renderBlueprint } from '../src/generation/expand.js';
import {
  PREFETCH_DEPTH,
  canNavigateTo,
  expansionProgress,
  planExpansion,
} from '../src/generation/prefetch.js';
import { renderPacingDirective } from '../src/pacing/types.js';
import { MAX_STEPS, MIN_STEPS, ProjectBlueprint } from '../src/schemas/project.js';
import { ExpandedStep } from '../src/schemas/step.js';

const blueprint = (over: Partial<ProjectBlueprint> = {}): ProjectBlueprint =>
  ProjectBlueprint.parse({
    title: 'CLI Todo with persistence',
    summary: 'Build a todo list that survives restarts.',
    learningObjectives: ['Read and write JSON files', 'Parse CLI arguments'],
    techStack: [{ name: 'Node.js', role: 'runtime', why: 'no build step to get in the way' }],
    prerequisites: ['Comfortable writing functions'],
    estimatedHours: 4,
    steps: [
      { title: 'Print a hardcoded list', objective: 'See output', concepts: ['stdout'], estMinutes: 30 },
      { title: 'Add an item', objective: 'Mutate state', concepts: ['arrays'], estMinutes: 45 },
      { title: 'Persist to disk', objective: 'Survive restart', concepts: ['fs', 'JSON'], estMinutes: 60 },
    ],
    ...over,
  });

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

describe('ProjectBlueprint schema', () => {
  it('round-trips a valid blueprint', () => {
    const parsed = ProjectBlueprint.parse(blueprint());
    expect(ProjectBlueprint.parse(parsed)).toEqual(parsed);
  });

  it('rejects a project with too few steps to be a project', () => {
    expect(() =>
      ProjectBlueprint.parse({ ...blueprint(), steps: blueprint().steps.slice(0, MIN_STEPS - 1) }),
    ).toThrow();
  });

  it('rejects a step count that reads as a course rather than a project', () => {
    const tooMany = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({
      title: `Step ${i}`,
      objective: 'x',
      concepts: [],
      estMinutes: 20,
    }));
    expect(() => ProjectBlueprint.parse({ ...blueprint(), steps: tooMany })).toThrow();
  });

  it('requires at least one learning objective and one technology', () => {
    expect(() => ProjectBlueprint.parse({ ...blueprint(), learningObjectives: [] })).toThrow();
    expect(() => ProjectBlueprint.parse({ ...blueprint(), techStack: [] })).toThrow();
  });

  it('requires each technology to justify itself', () => {
    // "React — frontend" teaches nothing; the `why` is the teaching content.
    expect(() =>
      ProjectBlueprint.parse({
        ...blueprint(),
        techStack: [{ name: 'React', role: 'frontend' }],
      }),
    ).toThrow();
  });
});

describe('normaliseBlueprint', () => {
  it('derives total hours from the steps rather than trusting the stated total', () => {
    // 30 + 45 + 60 = 135 min = 2.3h, not the 4h the model claimed.
    const result = normaliseBlueprint(blueprint({ estimatedHours: 4 }));
    expect(result.estimatedHours).toBeCloseTo(2.3, 1);
  });

  it('clamps absurd step durations at both ends', () => {
    const result = normaliseBlueprint(
      blueprint({
        steps: [
          { title: 'a', objective: 'o', concepts: [], estMinutes: 1 },
          { title: 'b', objective: 'o', concepts: [], estMinutes: 600 },
          { title: 'c', objective: 'o', concepts: [], estMinutes: 45 },
        ],
      }),
    );
    // A 1-minute step should have been merged; a 10-hour step gets abandoned.
    expect(result.steps[0]!.estMinutes).toBeGreaterThanOrEqual(10);
    expect(result.steps[1]!.estMinutes).toBeLessThanOrEqual(180);
  });

  it('deduplicates and trims concepts', () => {
    const result = normaliseBlueprint(
      blueprint({
        steps: [
          { title: 'a', objective: 'o', concepts: [' fs ', 'fs', 'JSON', ''], estMinutes: 30 },
          { title: 'b', objective: 'o', concepts: [], estMinutes: 30 },
          { title: 'c', objective: 'o', concepts: [], estMinutes: 30 },
        ],
      }),
    );
    expect(result.steps[0]!.concepts).toEqual(['fs', 'JSON']);
  });

  it('preserves step order exactly', () => {
    const result = normaliseBlueprint(blueprint());
    expect(result.steps.map((s) => s.title)).toEqual([
      'Print a hardcoded list',
      'Add an item',
      'Persist to disk',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Prompt rendering
 * ------------------------------------------------------------------ */

describe('renderBlueprint', () => {
  it('is byte-stable for the same blueprint', () => {
    // It is the cached prefix shared by every step expansion in the project.
    expect(renderBlueprint(blueprint())).toBe(renderBlueprint(blueprint()));
  });

  it('includes every step so a later step knows what came before', () => {
    const rendered = renderBlueprint(blueprint());
    for (const step of blueprint().steps) {
      expect(rendered).toContain(step.title);
    }
  });

  it('numbers steps from 1 for the model, not from 0', () => {
    expect(renderBlueprint(blueprint())).toContain('1. Print a hardcoded list');
  });
});

describe('renderPacingDirective', () => {
  it('renders nothing at all when the learner is on track', () => {
    // `hold` must add zero bytes, so the common case keeps hitting the cache.
    expect(renderPacingDirective({ adjustment: 'hold', reason: 'fine', notes: [] })).toBeNull();
  });

  it('tells the model to scaffold without reducing what is learned', () => {
    const text = renderPacingDirective({ adjustment: 'scaffold', reason: 'slow', notes: [] })!;
    expect(text).toMatch(/smaller/i);
    expect(text).toMatch(/Do not reduce what they learn/i);
  });

  it('marks stretch work as optional so skipping it breaks nothing', () => {
    const text = renderPacingDirective({ adjustment: 'stretch', reason: 'fast', notes: [] })!;
    expect(text).toMatch(/optional/i);
  });

  it('passes through caller notes', () => {
    const text = renderPacingDirective({
      adjustment: 'compress',
      reason: 'fast',
      notes: ['Already knows async/await'],
    })!;
    expect(text).toContain('Already knows async/await');
  });
});

/* ------------------------------------------------------------------ *
 * Step normalisation
 * ------------------------------------------------------------------ */

const step = (over: Partial<ExpandedStep> = {}): ExpandedStep =>
  ExpandedStep.parse({
    instructionsMd: '  Build the thing.  ',
    starterFiles: [{ path: 'index.js', contents: '// TODO' }],
    solutionFiles: [{ path: 'index.js', contents: 'done()' }],
    checkpoint: { requiredFiles: ['index.js'], requiredSymbols: [], tests: [], runtime: 'web' },
    explanationMd: 'Because.',
    alternatives: [],
    hints: [],
    ...over,
  });

describe('normaliseStep', () => {
  it('keeps one hint per tier, in order', () => {
    // Several hints at the same tier would let a learner unlock the whole
    // ladder in one click.
    const result = normaliseStep(
      step({
        hints: [
          { tier: 2, text: 'second' },
          { tier: 1, text: 'first' },
          { tier: 2, text: 'duplicate tier' },
          { tier: 3, text: 'third' },
        ],
      }),
    );
    expect(result.hints.map((h) => h.tier)).toEqual([1, 2, 3]);
    expect(result.hints[1]!.text).toBe('second');
  });

  it('drops an alternative with no downside', () => {
    // A tradeoff with only upsides teaches nothing about choosing, which is the
    // skill this section exists to teach.
    //
    // The schema already rejects an empty `cons`, so this deliberately bypasses
    // it: normaliseStep also runs over rows loaded straight from the database,
    // which were validated by whatever version of the schema was current when
    // they were written. The filter is the second line of defence.
    const unvalidated = {
      ...step(),
      alternatives: [
        { name: 'Good', insteadOf: 'x', pros: ['fast'], cons: ['complex'], whenToUse: 'scale' },
        { name: 'Bad', insteadOf: 'x', pros: ['fast'], cons: [], whenToUse: 'always' },
        { name: 'Worse', insteadOf: 'x', pros: [], cons: ['slow'], whenToUse: 'never' },
      ],
    } as ExpandedStep;

    expect(normaliseStep(unvalidated).alternatives.map((a) => a.name)).toEqual(['Good']);
  });

  it('trims surrounding whitespace from prose', () => {
    expect(normaliseStep(step()).instructionsMd).toBe('Build the thing.');
  });

  it('drops empty hints rather than rendering a blank tier', () => {
    const result = normaliseStep(step({ hints: [{ tier: 1, text: '   ' }] }));
    expect(result.hints).toHaveLength(0);
  });
});

describe('ExpandedStep schema', () => {
  it('requires both pros and cons on an alternative', () => {
    expect(() =>
      ExpandedStep.parse({
        ...step(),
        alternatives: [{ name: 'X', insteadOf: 'y', pros: [], cons: ['slow'], whenToUse: 'never' }],
      }),
    ).toThrow();
  });

  it('accepts a step with nothing executable', () => {
    // Design and planning steps are real steps.
    const parsed = ExpandedStep.parse({
      ...step(),
      checkpoint: { requiredFiles: [], requiredSymbols: [], tests: [], runtime: 'none' },
    });
    expect(parsed.checkpoint.runtime).toBe('none');
  });
});

/* ------------------------------------------------------------------ *
 * Prefetch
 * ------------------------------------------------------------------ */

const states = (flags: Array<'done' | 'busy' | 'todo'>) =>
  flags.map((flag, index) => ({
    index,
    expanded: flag === 'done',
    expanding: flag === 'busy',
  }));

describe('planExpansion', () => {
  it('blocks on the current step when it is not ready', () => {
    const plan = planExpansion(states(['todo', 'todo', 'todo']), 0);
    expect(plan.blocking).toBe(0);
  });

  it('does not block when the current step is already expanded', () => {
    const plan = planExpansion(states(['done', 'todo', 'todo']), 0);
    expect(plan.blocking).toBeNull();
    expect(plan.background).toEqual([1]);
  });

  it('prefetches the next step so finishing one does not mean waiting', () => {
    const plan = planExpansion(states(['done', 'todo', 'todo']), 0);
    expect(plan.background).toHaveLength(PREFETCH_DEPTH);
  });

  it('never re-requests a step already in flight', () => {
    // Without this a re-render mid-request would fire a duplicate expansion and
    // bill twice for the same step.
    const plan = planExpansion(states(['done', 'busy', 'todo']), 0);
    expect(plan.blocking).toBeNull();
    expect(plan.background).toEqual([]);
  });

  it('never re-requests the current step while it is being expanded', () => {
    expect(planExpansion(states(['busy', 'todo']), 0).blocking).toBeNull();
  });

  it('asks for nothing at the end of the project', () => {
    const plan = planExpansion(states(['done', 'done', 'done']), 2);
    expect(plan.blocking).toBeNull();
    expect(plan.background).toEqual([]);
  });

  it('does not skip ahead past an unexpanded step', () => {
    // Expanding step 3 before step 2 would write it without knowing what came
    // before it.
    const plan = planExpansion(states(['done', 'todo', 'todo', 'todo']), 0);
    expect(plan.background).toEqual([1]);
    expect(plan.background).not.toContain(2);
  });

  it('handles an index beyond the project without throwing', () => {
    const plan = planExpansion(states(['done', 'done']), 99);
    expect(plan.blocking).toBeNull();
    expect(plan.background).toEqual([]);
  });
});

describe('navigation and progress', () => {
  it('allows navigation only to expanded steps', () => {
    const s = states(['done', 'todo']);
    expect(canNavigateTo(s, 0)).toBe(true);
    expect(canNavigateTo(s, 1)).toBe(false);
    expect(canNavigateTo(s, 42)).toBe(false);
  });

  it('reports expansion progress as a fraction', () => {
    expect(expansionProgress(states(['done', 'done', 'todo', 'todo']))).toBe(0.5);
    expect(expansionProgress([])).toBe(0);
  });
});
