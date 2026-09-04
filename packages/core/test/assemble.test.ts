import { describe, expect, it } from 'vitest';

import {
  assembleProject,
  hasFilePlan,
  normalisePath,
  parseStoredBlueprint,
  reconcileFilePlan,
  renderBlueprint,
  renderProjectState,
  renderStepBrief,
  sourceKindOf,
  type ProjectBlueprint,
  type StepFiles,
} from '../src/index.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function step(
  stepIndex: number,
  learner: Array<[string, string]> | null,
  reference: Array<[string, string]> | null,
): StepFiles {
  const files = (pairs: Array<[string, string]> | null) =>
    pairs ? pairs.map(([path, contents]) => ({ path, contents })) : null;
  return { stepIndex, learnerFiles: files(learner), referenceFiles: files(reference) };
}

function blueprint(overrides: Partial<ProjectBlueprint>): ProjectBlueprint {
  return {
    title: 'T',
    summary: 'S',
    learningObjectives: ['o'],
    techStack: [{ name: 'Python', role: 'runtime', why: 'w' }],
    prerequisites: [],
    estimatedHours: 4,
    finalFileTree: [],
    deployment: { target: 'local', rationale: 'r', artifacts: [], taught: false },
    steps: [],
    ...overrides,
  } as ProjectBlueprint;
}

function stub(title: string, creates: string[], edits: string[]) {
  return { title, objective: 'o', concepts: [], estMinutes: 30, creates, edits };
}

/* ------------------------------------------------------------------ *
 * assembleProject
 * ------------------------------------------------------------------ */

describe('assembleProject', () => {
  it('overlays each step in order so a later edit wins over the file it edited', () => {
    const result = assembleProject([
      step(0, [['app.py', 'v1']], null),
      step(1, [['app.py', 'v2'], ['db.py', 'db']], null),
    ]);

    expect(result.files).toEqual([
      { path: 'app.py', contents: 'v2' },
      { path: 'db.py', contents: 'db' },
    ]);
    expect(result.fullyLearnerWritten).toBe(true);
  });

  it('is the project as of a given step when upTo is passed', () => {
    const steps = [
      step(0, [['app.py', 'v1']], null),
      step(1, [['app.py', 'v2']], null),
      step(2, [['app.py', 'v3']], null),
    ];

    // Exclusive: "what step 2 opens with" is everything steps 0 and 1 left.
    expect(assembleProject(steps, 2).files).toEqual([{ path: 'app.py', contents: 'v2' }]);
    expect(assembleProject(steps, 0).files).toEqual([]);
  });

  it('prefers the learner’s own code over the reference solution', () => {
    const result = assembleProject([step(0, [['app.py', 'mine']], [['app.py', 'theirs']])]);

    expect(result.files[0]?.contents).toBe('mine');
    expect(result.stepsFromReference).toEqual([]);
  });

  it('falls back to the reference for a step the learner never passed', () => {
    const result = assembleProject([
      step(0, [['app.py', 'mine']], [['app.py', 'ref0']]),
      step(1, null, [['db.py', 'ref1']]),
    ]);

    expect(result.files).toEqual([
      { path: 'app.py', contents: 'mine' },
      { path: 'db.py', contents: 'ref1' },
    ]);
    // Surfaced so the finished project can say honestly how much is theirs.
    expect(result.stepsFromReference).toEqual([1]);
    expect(result.fullyLearnerWritten).toBe(false);
  });

  it('records a step that has neither as missing rather than silently skipping it', () => {
    const result = assembleProject([step(0, [['a', 'x']], null), step(1, null, null)]);

    expect(result.stepsMissing).toEqual([1]);
    expect(result.stepsFromReference).toEqual([]);
  });

  it('treats an empty file list as no contribution, not as an empty project', () => {
    expect(sourceKindOf(step(0, [], [['a', 'ref']]))).toBe('reference');
    expect(sourceKindOf(step(0, [], []))).toBe('missing');
  });

  it('applies steps in index order however they arrive', () => {
    const result = assembleProject([
      step(2, [['app.py', 'third']], null),
      step(0, [['app.py', 'first']], null),
      step(1, [['app.py', 'second']], null),
    ]);

    expect(result.files[0]?.contents).toBe('third');
  });

  it('collapses paths that differ only in spelling onto one file', () => {
    const result = assembleProject([
      step(0, [['./src/app.py', 'v1']], null),
      step(1, [['src//app.py', 'v2']], null),
    ]);

    expect(result.files).toEqual([{ path: 'src/app.py', contents: 'v2' }]);
  });

  it('is empty, not broken, for a project nobody has started', () => {
    const result = assembleProject([]);
    expect(result.files).toEqual([]);
    expect(result.fullyLearnerWritten).toBe(false);
  });
});

describe('normalisePath', () => {
  it('folds the ways a model writes the same path', () => {
    expect(normalisePath('  ./src/a.py ')).toBe('src/a.py');
    expect(normalisePath('src\\\\a.py')).toBe('src/a.py');
    expect(normalisePath('/src//a.py')).toBe('src/a.py');
  });
});

/* ------------------------------------------------------------------ *
 * renderProjectState
 * ------------------------------------------------------------------ */

describe('renderProjectState', () => {
  it('says the project is empty on the first step rather than rendering nothing', () => {
    expect(renderProjectState({ files: [] })).toContain('The project is empty');
  });

  it('always sends the files this step will touch in full, however tight the budget', () => {
    const rendered = renderProjectState({
      files: [
        { path: 'big.py', contents: 'x'.repeat(500) },
        { path: 'target.py', contents: 'THE-CODE-TO-EDIT' },
      ],
      focusPaths: ['target.py'],
      budget: 10,
    });

    expect(rendered).toContain('THE-CODE-TO-EDIT');
    // The one it could not fit is named, so the step knows not to recreate it.
    expect(rendered).not.toContain('x'.repeat(500));
    expect(rendered).toContain('big.py');
    expect(rendered).toContain('Do not recreate them');
  });

  it('sends everything when it fits', () => {
    const rendered = renderProjectState({
      files: [
        { path: 'a.py', contents: 'AAA' },
        { path: 'b.py', contents: 'BBB' },
      ],
    });

    expect(rendered).toContain('AAA');
    expect(rendered).toContain('BBB');
    expect(rendered).not.toContain('Do not recreate them');
  });
});

/* ------------------------------------------------------------------ *
 * reconcileFilePlan — the contract the whole sequential build rests on
 * ------------------------------------------------------------------ */

describe('reconcileFilePlan', () => {
  it('leaves a well-formed plan alone', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [
          { path: 'app.py', purpose: 'entry' },
          { path: 'db.py', purpose: 'storage' },
        ],
        steps: [stub('one', ['app.py'], []), stub('two', ['db.py'], ['app.py'])],
      }),
    );

    expect(result.steps[0]).toMatchObject({ creates: ['app.py'], edits: [] });
    expect(result.steps[1]).toMatchObject({ creates: ['db.py'], edits: ['app.py'] });
  });

  it('demotes a second creator to an editor so the first step’s work is not discarded', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [{ path: 'app.py', purpose: 'entry' }],
        steps: [stub('one', ['app.py'], []), stub('two', ['app.py'], [])],
      }),
    );

    expect(result.steps[0]).toMatchObject({ creates: ['app.py'], edits: [] });
    expect(result.steps[1]).toMatchObject({ creates: [], edits: ['app.py'] });
  });

  it('promotes an edit of a file nothing has created yet into a create', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [{ path: 'db.py', purpose: 'storage' }],
        steps: [stub('one', [], ['db.py']), stub('two', [], ['db.py'])],
      }),
    );

    expect(result.steps[0]).toMatchObject({ creates: ['db.py'], edits: [] });
    expect(result.steps[1]).toMatchObject({ creates: [], edits: ['db.py'] });
  });

  it('gives a planned file nobody writes to the first step that touches it', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [
          { path: 'app.py', purpose: 'entry' },
          { path: 'orphan.py', purpose: 'never written' },
        ],
        steps: [stub('one', ['app.py'], []), stub('two', [], [])],
      }),
    );

    // A file no step creates would simply never exist in the finished project.
    const creators = result.steps.flatMap((s) => s.creates);
    expect(creators).toContain('orphan.py');
  });

  it('adopts a path a step writes but the tree forgot', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [{ path: 'app.py', purpose: 'entry' }],
        steps: [stub('one', ['app.py', 'helper.py'], [])],
      }),
    );

    expect(result.finalFileTree.map((f) => f.path)).toContain('helper.py');
    expect(result.steps[0]?.creates).toContain('helper.py');
  });

  it('strips files that Phase C writes, wherever a step claims them', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [
          { path: 'app.py', purpose: 'entry' },
          { path: 'README.md', purpose: 'docs' },
        ],
        steps: [stub('one', ['app.py', 'README.md', 'Dockerfile'], [])],
      }),
    );

    const paths = result.finalFileTree.map((f) => f.path);
    expect(paths).toEqual(['app.py']);
    expect(result.steps[0]?.creates).toEqual(['app.py']);
  });

  it('folds path spellings so one file is not planned twice', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [
          { path: './src/app.py', purpose: 'entry' },
          { path: 'src/app.py', purpose: 'duplicate' },
        ],
        steps: [stub('one', ['src/app.py'], []), stub('two', [], ['./src/app.py'])],
      }),
    );

    expect(result.finalFileTree.map((f) => f.path)).toEqual(['src/app.py']);
    expect(result.steps[1]?.edits).toEqual(['src/app.py']);
  });

  it('does not leave a step both creating and editing the same file', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [{ path: 'app.py', purpose: 'entry' }],
        steps: [stub('one', ['app.py'], ['app.py'])],
      }),
    );

    expect(result.steps[0]).toMatchObject({ creates: ['app.py'], edits: [] });
  });

  it('produces a plan where every file has exactly one creator', () => {
    const result = reconcileFilePlan(
      blueprint({
        finalFileTree: [
          { path: 'a.py', purpose: '' },
          { path: 'b.py', purpose: '' },
          { path: 'c.py', purpose: '' },
        ],
        steps: [
          stub('one', ['a.py', 'b.py'], ['c.py']),
          stub('two', ['b.py', 'c.py'], ['a.py']),
          stub('three', [], ['a.py', 'b.py', 'zzz.py']),
        ],
      }),
    );

    const created = result.steps.flatMap((s) => s.creates);
    expect(new Set(created).size).toBe(created.length);
    for (const file of result.finalFileTree) expect(created).toContain(file.path);

    // And nothing is edited before the step that creates it.
    const createdAt = new Map(
      result.steps.flatMap((s, i) => s.creates.map((p) => [p, i] as const)),
    );
    result.steps.forEach((s, i) => {
      for (const path of s.edits) expect(createdAt.get(path)!).toBeLessThan(i);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Backward compatibility
 * ------------------------------------------------------------------ */

describe('parseStoredBlueprint', () => {
  /** A blueprint exactly as it was stored before file plans existed. */
  const legacy = {
    title: 'Old project',
    summary: 'Planned before any of this existed.',
    learningObjectives: ['something'],
    techStack: [{ name: 'Python', role: 'runtime', why: 'w' }],
    prerequisites: [],
    estimatedHours: 3,
    steps: [
      { title: 'One', objective: 'o', concepts: [], estMinutes: 30 },
      { title: 'Two', objective: 'o', concepts: [], estMinutes: 30 },
      { title: 'Three', objective: 'o', concepts: [], estMinutes: 30 },
    ],
  };

  it('reads a pre-file-plan blueprint instead of rejecting it', () => {
    // Every project a learner already had would 500 on expansion otherwise.
    const parsed = parseStoredBlueprint(legacy);

    expect(parsed).not.toBeNull();
    expect(parsed!.finalFileTree).toEqual([]);
    expect(parsed!.deployment.target).toBe('local');
    expect(parsed!.steps[0]).toMatchObject({ creates: [], edits: [] });
  });

  it('reports that an upgraded blueprint carries no contract', () => {
    expect(hasFilePlan(parseStoredBlueprint(legacy)!)).toBe(false);
  });

  it('reads a current blueprint unchanged', () => {
    const current = blueprint({
      finalFileTree: [{ path: 'app.py', purpose: 'entry' }],
      steps: [stub('a', ['app.py'], []), stub('b', [], ['app.py']), stub('c', [], ['app.py'])],
    });
    const parsed = parseStoredBlueprint(current);

    expect(parsed!.finalFileTree).toEqual([{ path: 'app.py', purpose: 'entry' }]);
    expect(hasFilePlan(parsed!)).toBe(true);
  });

  it('still rejects something that is not a blueprint at all', () => {
    expect(parseStoredBlueprint({ title: 'only a title' })).toBeNull();
    expect(parseStoredBlueprint(null)).toBeNull();
  });
});

describe('renderBlueprint / renderTarget on a legacy blueprint', () => {
  const legacy = parseStoredBlueprint({
    title: 'Old project',
    summary: 's',
    learningObjectives: ['x'],
    techStack: [{ name: 'Python', role: 'runtime', why: 'w' }],
    prerequisites: [],
    estimatedHours: 3,
    steps: [
      { title: 'One', objective: 'o', concepts: [], estMinutes: 30 },
      { title: 'Two', objective: 'o', concepts: [], estMinutes: 30 },
      { title: 'Three', objective: 'o', concepts: [], estMinutes: 30 },
    ],
  })!;

  it('omits the file section rather than claiming the project has no files', () => {
    expect(renderBlueprint(legacy)).not.toContain('Files in the finished project');
  });

  it('does not forbid the step from writing anything', () => {
    // "This step creates no new files" would be a lie the model obeys.
    const rendered = renderStepBrief(legacy, 1);
    expect(rendered).not.toContain('creates no new files');
    expect(rendered).toContain('Continue the project shown above');
  });

  it('states the manifest when the blueprint has one', () => {
    const current = blueprint({
      finalFileTree: [
        { path: 'app.py', purpose: 'entry' },
        { path: 'db.py', purpose: 'storage' },
      ],
      steps: [stub('a', ['app.py'], []), stub('b', ['db.py'], ['app.py']), stub('c', [], ['db.py'])],
    });

    const rendered = renderStepBrief(current, 1);
    expect(rendered).toContain('This step CREATES');
    expect(rendered).toContain('db.py');
    expect(rendered).toContain('This step EDITS');
    expect(rendered).toContain('app.py');
  });
});
