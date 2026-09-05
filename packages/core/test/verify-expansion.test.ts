import { describe, expect, it } from 'vitest';

import type { ExpandedStep, SourceFile } from '../src/schemas/step.js';
import {
  hasSeriousViolation,
  PRIOR_WORK_RETENTION,
  renderViolations,
  repairExpansion,
  retainedFraction,
  significantLines,
  verifyExpansion,
  verifyProjectComplete,
  type ExpansionContext,
} from '../src/generation/verifyExpansion.js';

/**
 * Holding an expanded step to its file manifest.
 *
 * The blueprint's own plan is reconciled and enforced; the expansion end of the
 * same contract was not checked at all. These tests are organised by what each
 * failure costs the learner, because that is what decides whether a violation
 * is worth a second generation:
 *
 *   - a hole in the project from this step onward
 *   - a step that can never be passed
 *   - their own code, silently replaced by the model's paraphrase of it
 *
 * The last section is a mutation check. Every test above it asserts that a
 * flawed expansion is caught, so at least one has to assert that a GOOD one is
 * left alone — otherwise a verifier that flagged everything would pass the lot.
 */

/* ------------------------------------------------------------------ *
 * Fixtures — a todo list, mid-build.
 * ------------------------------------------------------------------ */

const PRIOR_APP_JS = `const todos = [];

function addTodo(text) {
  todos.push({ text: text, done: false });
  renderTodoList();
}

function renderTodoList() {
  const list = document.getElementById('todo-list');
  list.innerHTML = '';
  for (const todo of todos) {
    const item = document.createElement('li');
    item.textContent = todo.text;
    list.appendChild(item);
  }
}`;

const PRIOR_FILES: SourceFile[] = [
  { path: 'index.html', contents: '<!DOCTYPE html><html><body><ul id="todo-list"></ul></body></html>' },
  { path: 'app.js', contents: PRIOR_APP_JS },
];

/** Step 4: creates storage.js, edits app.js to call it. */
const STUB = { creates: ['storage.js'], edits: ['app.js'] };

const CONTEXT: ExpansionContext = { stub: STUB, priorFiles: PRIOR_FILES };

/** app.js as a well-behaved expansion returns it: carried forward, plus a TODO. */
const EDITED_APP_JS = `${PRIOR_APP_JS}

function persistTodos() {
  // TODO: save the todos array using the helper from storage.js
}`;

function step(overrides: Partial<ExpandedStep> = {}): ExpandedStep {
  return {
    instructionsMd: 'Add persistence.',
    explanationMd: 'localStorage is synchronous and origin-scoped.',
    alternatives: [],
    hints: [],
    checkpoint: { requiredFiles: [], requiredSymbols: [], tests: [], runtime: 'web' },
    starterFiles: [
      { path: 'storage.js', contents: '// TODO: export save() and load()\n' },
      { path: 'app.js', contents: EDITED_APP_JS },
    ],
    solutionFiles: [
      { path: 'storage.js', contents: 'export function save(t) { localStorage.setItem("t", JSON.stringify(t)); }' },
      { path: 'app.js', contents: `${EDITED_APP_JS}\n// done` },
    ],
    ...overrides,
  };
}

function codesOf(violations: ReturnType<typeof verifyExpansion>): string[] {
  return violations.map((violation) => violation.code);
}

/* ------------------------------------------------------------------ *
 * A hole in the project
 * ------------------------------------------------------------------ */

describe('a file missing from solutionFiles', () => {
  it('is caught', () => {
    // The worst of the three. Every later step is written against these files,
    // so the project loses storage.js from step 4 onward and the finished
    // repository has a hole where it should be.
    const violations = verifyExpansion(
      step({ solutionFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('missing_from_solution');
  });

  it('is serious enough to regenerate the step', () => {
    const violations = verifyExpansion(
      step({ solutionFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    expect(hasSeriousViolation(violations)).toBe(true);
  });

  it('is caught when the file is present but empty', () => {
    // Same hole, one indirection away.
    const violations = verifyExpansion(
      step({
        solutionFiles: [
          { path: 'storage.js', contents: '   \n  ' },
          { path: 'app.js', contents: EDITED_APP_JS },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('empty_solution_file');
  });

  it('does not fire on a file whose whole job is to be empty', () => {
    /*
     * An empty `__init__.py` is what makes a directory a Python package. Without
     * this carve-out a correct Python project fails verification, and the repair
     * helpfully fills its package markers with TODO comments.
     */
    const pkg: ExpansionContext = {
      stub: { creates: ['src/__init__.py', 'src/main.py'], edits: [] },
      priorFiles: [],
    };
    const violations = verifyExpansion(
      step({
        starterFiles: [
          { path: 'src/__init__.py', contents: '' },
          { path: 'src/main.py', contents: '# TODO' },
        ],
        solutionFiles: [
          { path: 'src/__init__.py', contents: '' },
          { path: 'src/main.py', contents: 'def main(): pass' },
        ],
      }),
      pkg,
    );
    expect(violations).toEqual([]);
  });

  it('is repaired from the starter, so the next step inherits something', () => {
    const repaired = repairExpansion(
      step({ solutionFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    const storage = repaired.solutionFiles.find((f) => f.path === 'storage.js');
    expect(storage).toBeDefined();
    expect(storage!.contents.trim().length).toBeGreaterThan(0);
    expect(verifyExpansion(repaired, CONTEXT)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * A step that cannot be passed
 * ------------------------------------------------------------------ */

describe('a file missing from starterFiles', () => {
  it('is caught', () => {
    // The editor renders one tab per starter file and has no way to add a new
    // one, so a required file absent here can never be written and the
    // checkpoint's first layer fails forever.
    const violations = verifyExpansion(
      step({ starterFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('missing_from_starter');
    expect(hasSeriousViolation(violations)).toBe(true);
  });

  it('is repaired into a stub the learner can write into', () => {
    const repaired = repairExpansion(
      step({ starterFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    const storage = repaired.starterFiles.find((f) => f.path === 'storage.js');
    expect(storage).toBeDefined();
    expect(storage!.contents).toMatch(/TODO/);
  });

  it('restores an EDITED file from the real project, not from a stub', () => {
    // A created file has nothing to restore and gets a placeholder. An edited
    // one already exists, and handing back a stub would be the data loss this
    // module exists to prevent.
    const repaired = repairExpansion(
      step({ starterFiles: [{ path: 'storage.js', contents: '// TODO\n' }] }),
      CONTEXT,
    );
    const app = repaired.starterFiles.find((f) => f.path === 'app.js');
    expect(app!.contents).toBe(PRIOR_APP_JS);
  });
});

/* ------------------------------------------------------------------ *
 * The learner's own code, paraphrased away
 * ------------------------------------------------------------------ */

describe('an edited file that lost the work already in it', () => {
  it('is caught when the model rewrote instead of carrying forward', () => {
    // What this actually looks like in practice: the model returns a tidy
    // skeleton of the file rather than the learner's version of it.
    const rewritten = `const todos = [];

function addTodo(text) {
  // TODO: add a todo
}

function renderTodoList() {
  // TODO: render the list
}`;
    const violations = verifyExpansion(
      step({
        starterFiles: [
          { path: 'storage.js', contents: '// TODO\n' },
          { path: 'app.js', contents: rewritten },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('clobbered_prior_work');
    expect(hasSeriousViolation(violations)).toBe(true);
  });

  it('is caught when the file comes back empty', () => {
    const violations = verifyExpansion(
      step({
        starterFiles: [
          { path: 'storage.js', contents: '// TODO\n' },
          { path: 'app.js', contents: '' },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('clobbered_prior_work');
  });

  it('is repaired by preferring the learner’s real file', () => {
    const repaired = repairExpansion(
      step({
        starterFiles: [
          { path: 'storage.js', contents: '// TODO\n' },
          { path: 'app.js', contents: 'const todos = [];' },
        ],
      }),
      CONTEXT,
    );
    // Their code, exactly as they left it. The scaffolding this step wanted to
    // add is lost, which is the right way round: a lost TODO comment costs a
    // hint, lost code costs an evening.
    expect(repaired.starterFiles.find((f) => f.path === 'app.js')!.contents).toBe(PRIOR_APP_JS);
  });

  it('does NOT fire on a legitimate edit that adds to the file', () => {
    // The false positive that would matter: flagging real edits would mean the
    // scaffolding is discarded on every step that edits anything.
    const violations = verifyExpansion(step(), CONTEXT);
    expect(codesOf(violations)).not.toContain('clobbered_prior_work');
  });

  it('does NOT fire on an edit that changes a few lines', () => {
    const tweaked = PRIOR_APP_JS.replace(
      'todos.push({ text: text, done: false });',
      'todos.push({ text: text, done: false, id: crypto.randomUUID() });',
    );
    const violations = verifyExpansion(
      step({
        starterFiles: [
          { path: 'storage.js', contents: '// TODO\n' },
          { path: 'app.js', contents: tweaked },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).not.toContain('clobbered_prior_work');
  });

  it('cannot fire on a created file, which has no prior work to lose', () => {
    const violations = verifyExpansion(
      step({
        starterFiles: [
          { path: 'storage.js', contents: '' },
          { path: 'app.js', contents: EDITED_APP_JS },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).not.toContain('clobbered_prior_work');
  });
});

describe('retention measurement', () => {
  it('ignores comments, so keeping the comments and dropping the code counts as loss', () => {
    const prior = { path: 'a.js', contents: '// explains things\nconst answer = computeAnswer();' };
    const gutted = { path: 'a.js', contents: '// explains things\n' };
    expect(retainedFraction(prior, gutted)).toBe(0);
  });

  it('ignores trivial lines that survive every rewrite', () => {
    // A bare closing brace is present in every version of every file and would
    // push any rewrite over any threshold.
    expect(significantLines({ path: 'a.js', contents: '}\n)\n  }\n' })).toEqual([]);
  });

  it('treats an empty prior file as fully retained', () => {
    // Nothing to lose. Reporting 0 here would flag every genuinely new file.
    expect(retainedFraction({ path: 'a.js', contents: '' }, { path: 'a.js', contents: 'x' })).toBe(1);
  });

  it('reports full retention when the file is carried forward verbatim', () => {
    const file = { path: 'app.js', contents: PRIOR_APP_JS };
    expect(retainedFraction(file, { path: 'app.js', contents: EDITED_APP_JS })).toBe(1);
  });

  it('uses a threshold that tolerates edits but not rewrites', () => {
    expect(PRIOR_WORK_RETENTION).toBeGreaterThan(0.5);
    expect(PRIOR_WORK_RETENTION).toBeLessThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * Files belonging to another step
 * ------------------------------------------------------------------ */

describe('a file outside the manifest', () => {
  it('is caught but is not worth regenerating for', () => {
    // Dropping it is exactly the right answer, so paying for a second call to
    // be told the same thing is waste.
    const violations = verifyExpansion(
      step({
        starterFiles: [
          ...step().starterFiles,
          { path: 'index.html', contents: '<html>rewritten by step 4</html>' },
        ],
      }),
      CONTEXT,
    );
    expect(codesOf(violations)).toContain('foreign_file');
    expect(hasSeriousViolation(violations)).toBe(false);
  });

  it('is dropped, so it cannot overwrite the step that owns it', () => {
    // index.html belongs to step 1. Letting step 4 write it would replace what
    // the learner built there, and `assembleProject` is last-writer-wins.
    const repaired = repairExpansion(
      step({
        solutionFiles: [
          ...step().solutionFiles,
          { path: 'index.html', contents: '<html>clobbered</html>' },
        ],
      }),
      CONTEXT,
    );
    expect(repaired.solutionFiles.map((f) => f.path)).toEqual(['storage.js', 'app.js']);
  });
});

/* ------------------------------------------------------------------ *
 * Ordering, reporting, and paths
 * ------------------------------------------------------------------ */

describe('reporting', () => {
  it('puts serious violations first, so a log line leads with the real problem', () => {
    const violations = verifyExpansion(
      step({
        starterFiles: [{ path: 'wrong.js', contents: 'x' }],
        solutionFiles: [{ path: 'wrong.js', contents: 'x' }],
      }),
      CONTEXT,
    );
    expect(violations[0]!.severity).toBe('serious');
    expect(violations[violations.length - 1]!.severity).toBe('cosmetic');
  });

  it('names the specific files, because "try again" just produces another guess', () => {
    const violations = verifyExpansion(
      step({ solutionFiles: [{ path: 'app.js', contents: EDITED_APP_JS }] }),
      CONTEXT,
    );
    const rendered = renderViolations(violations);
    expect(rendered).toContain('storage.js');
    expect(rendered).toContain('solutionFiles');
  });

  it('treats ./a.js, /a.js and a.js as one file', () => {
    const violations = verifyExpansion(
      {
        ...step(),
        starterFiles: [
          { path: './storage.js', contents: '// TODO\n' },
          { path: '/app.js', contents: EDITED_APP_JS },
        ],
        solutionFiles: [
          { path: 'storage.js', contents: 'export function save() {}' },
          { path: 'app.js', contents: EDITED_APP_JS },
        ],
      },
      CONTEXT,
    );
    expect(violations).toEqual([]);
  });

  it('judges nothing when the blueprint carries no manifest', () => {
    // Projects planned before file plans existed have no creates/edits. There
    // is no contract to hold them to, and inventing one after the fact would
    // condemn every project a learner already has.
    const violations = verifyExpansion(step({ starterFiles: [], solutionFiles: [] }), {
      stub: { creates: [], edits: [] },
      priorFiles: PRIOR_FILES,
    });
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The finished project
 * ------------------------------------------------------------------ */

describe('verifyProjectComplete', () => {
  it('reports a planned file the finished project never got', () => {
    // The check nothing performed: a project could reach its last step still
    // missing a file the plan called for, and the first anyone knew was a
    // downloaded repository that does not start.
    const report = verifyProjectComplete(
      ['index.html', 'app.js', 'storage.js'],
      [
        { path: 'index.html', contents: 'x' },
        { path: 'app.js', contents: 'x' },
      ],
    );
    expect(report.complete).toBe(false);
    expect(report.missing).toEqual(['storage.js']);
  });

  it('is satisfied when every planned file is there', () => {
    const report = verifyProjectComplete(
      ['index.html', 'app.js'],
      [
        { path: 'app.js', contents: 'x' },
        { path: 'index.html', contents: 'x' },
      ],
    );
    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('does not treat a file the learner added as a failure', () => {
    // By the end the code is theirs, and adding a file is not a defect.
    const report = verifyProjectComplete(
      ['app.js'],
      [
        { path: 'app.js', contents: 'x' },
        { path: 'helpers.js', contents: 'x' },
      ],
    );
    expect(report.complete).toBe(true);
    expect(report.unplanned).toEqual(['helpers.js']);
  });

  it('compares paths after normalisation', () => {
    const report = verifyProjectComplete(['./src/app.js'], [{ path: 'src/app.js', contents: 'x' }]);
    expect(report.complete).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Mutation check
 *
 * Every test above asserts that something bad is caught. Without these, a
 * verifier that flagged everything would satisfy all of them.
 * ------------------------------------------------------------------ */

describe('a well-formed expansion', () => {
  it('produces no violations at all', () => {
    expect(verifyExpansion(step(), CONTEXT)).toEqual([]);
    expect(hasSeriousViolation(verifyExpansion(step(), CONTEXT))).toBe(false);
  });

  it('is returned by the repair unchanged', () => {
    const original = step();
    const repaired = repairExpansion(original, CONTEXT);

    expect(repaired.starterFiles).toEqual(original.starterFiles);
    expect(repaired.solutionFiles).toEqual(original.solutionFiles);
    // The repair touches files and nothing else - the prose, the hints and the
    // checkpoint are the step's own business.
    expect(repaired.instructionsMd).toBe(original.instructionsMd);
    expect(repaired.checkpoint).toEqual(original.checkpoint);
  });

  it('stays clean when repaired twice', () => {
    // Repair runs on every expansion including retried ones, so it has to be
    // idempotent or a second pass would degrade a step the first pass fixed.
    const once = repairExpansion(step({ solutionFiles: [] }), CONTEXT);
    const twice = repairExpansion(once, CONTEXT);
    expect(twice).toEqual(once);
    expect(verifyExpansion(twice, CONTEXT)).toEqual([]);
  });

  it('leaves a repaired step passing verification, whatever went wrong', () => {
    // The property that matters most: repair is the last point at which the
    // manifest can be made true, so it must always succeed.
    const broken: Array<Partial<ExpandedStep>> = [
      { starterFiles: [], solutionFiles: [] },
      { solutionFiles: [{ path: 'nope.js', contents: 'x' }] },
      { starterFiles: [{ path: 'app.js', contents: '' }] },
      { starterFiles: [{ path: 'storage.js', contents: '' }], solutionFiles: [] },
      { starterFiles: [{ path: 'index.html', contents: 'x' }] },
    ];

    for (const overrides of broken) {
      const repaired = repairExpansion(step(overrides), CONTEXT);
      expect(verifyExpansion(repaired, CONTEXT)).toEqual([]);
    }
  });
});
