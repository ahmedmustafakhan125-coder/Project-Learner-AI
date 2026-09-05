import { stripComments } from '../checkpoint/preflight.js';
import type { StepStub } from '../schemas/project.js';
import type { ExpandedStep, SourceFile } from '../schemas/step.js';
import { normalisePath } from './blueprint.js';

/**
 * Holding one expanded step to the plan that commissioned it.
 *
 * `reconcileFilePlan` makes the BLUEPRINT obey its own rules: every file in the
 * tree, created exactly once, edited only after it exists. Nothing did the same
 * for the other end. A step could be told "create src/store.js, edit app.js"
 * and come back having done neither, and it was persisted exactly as returned.
 *
 * That is not a cosmetic failure, because expansion is sequential. `priorFiles`
 * for step 5 is assembled from steps 1-4's files, so a file missing from step
 * 3's `solutionFiles` is missing from the project from step 3 onward — every
 * later step builds around a hole, and the finished repository has one too.
 *
 * There is a worse case. A file the step EDITS already exists and may already
 * contain the learner's own passing code. The prompt says to carry its contents
 * forward and change only what the step needs; a prompt is advice, and models
 * paraphrase. When that happens the editor opens on the model's rewrite of
 * their work, and the work is gone with no record that it ever existed.
 *
 * So: verify, then repair, and let the caller re-ask once when the damage is
 * the kind a repair cannot honestly undo.
 *
 * Pure and LLM-free, like `assembleProject` — it runs on every expansion and
 * must give the same answer every time.
 */

export type ViolationCode =
  /** A file the step must create or edit is absent from `solutionFiles`. */
  | 'missing_from_solution'
  /** A file the step must create or edit is absent from `starterFiles`. */
  | 'missing_from_starter'
  /** Present but empty. A file with nothing in it is a file that does not exist. */
  | 'empty_solution_file'
  /** An edited file came back without the work that was already in it. */
  | 'clobbered_prior_work'
  /** A file outside this step's manifest. The plan says another step owns it. */
  | 'foreign_file';

export type Severity = 'serious' | 'cosmetic';

export interface Violation {
  code: ViolationCode;
  path: string;
  severity: Severity;
  /** Written to be pasted to the model on a retry, so it says what to fix. */
  message: string;
}

export interface ExpansionContext {
  /** The manifest this step was commissioned against. */
  stub: Pick<StepStub, 'creates' | 'edits'>;
  /** The project as this step finds it — the real files, not the model's copy. */
  priorFiles: readonly SourceFile[];
}

/**
 * Severity is about the project, not about tidiness.
 *
 * SERIOUS means the step cannot be repaired into something correct:
 *
 *   - missing_from_solution — every later step inherits the hole.
 *   - missing_from_starter — the editor has no tab for that file and there is
 *     no way to add one, so a checkpoint requiring it can never pass. The step
 *     is unpassable, not merely thin.
 *   - empty_solution_file — same as missing, one indirection away.
 *   - clobbered_prior_work — the repair (fall back to the real file) is safe
 *     but silently discards whatever the step meant to scaffold, so the step
 *     is worth asking for again.
 *
 * COSMETIC means a repair restores the contract with nothing lost:
 *
 *   - foreign_file — dropping it is exactly right. The plan already says which
 *     step owns that path, and letting this one write it would overwrite work.
 */
const SEVERITY: Record<ViolationCode, Severity> = {
  missing_from_solution: 'serious',
  missing_from_starter: 'serious',
  empty_solution_file: 'serious',
  clobbered_prior_work: 'serious',
  foreign_file: 'cosmetic',
};

/**
 * Files that are supposed to be empty.
 *
 * "A file with nothing in it is a file that does not exist" is true of source
 * files and false of these: an empty `__init__.py` is what makes a directory a
 * Python package, and a `.gitkeep` exists precisely to contain nothing.
 * Without this carve-out a correct Python project fails verification, and the
 * repair helpfully fills its package markers with TODO comments.
 */
const LEGITIMATELY_EMPTY = /^(__init__\.py|\.gitkeep|\.keep|py\.typed)$/i;

function mayBeEmpty(path: string): boolean {
  return LEGITIMATELY_EMPTY.test(path.split('/').pop() ?? path);
}

/** Blank, and not one of the files whose whole job is to be blank. */
function isMissingContent(file: SourceFile | undefined, path: string): boolean {
  if (!file) return true;
  return file.contents.trim().length === 0 && !mayBeEmpty(path);
}

/* ------------------------------------------------------------------ *
 * Did an edited file keep what was already in it?
 * ------------------------------------------------------------------ */

/**
 * How much of a prior file must survive an edit before it counts as an edit.
 *
 * A real edit changes a few lines and adds some; it does not delete most of the
 * file. The threshold is deliberately generous rather than exact because the
 * two failure modes are not symmetric: a false positive costs the learner the
 * scaffolding this step meant to add, and a false negative costs them the code
 * they wrote. When unsure, keep their file.
 */
export const PRIOR_WORK_RETENTION = 0.7;

/**
 * Lines substantial enough that losing one means something was lost.
 *
 * Comments go first — a rewrite that keeps the comments and drops the code has
 * kept nothing. Very short lines go too: a bare `}` or `)` survives every
 * rewrite ever made and would push any file over any threshold.
 */
export function significantLines(file: SourceFile): string[] {
  return stripComments(file.contents, file.path)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
}

/**
 * The share of `prior`'s substantial lines still present in `next`.
 *
 * 1 when the prior file had nothing substantial in it — an empty file cannot
 * be clobbered, and reporting 0 there would flag every genuinely new file.
 */
export function retainedFraction(prior: SourceFile, next: SourceFile): number {
  const lines = significantLines(prior);
  if (lines.length === 0) return 1;

  const haystack = stripComments(next.contents, next.path);
  const kept = lines.filter((line) => haystack.includes(line)).length;
  return kept / lines.length;
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

function index(files: readonly SourceFile[]): Map<string, SourceFile> {
  const byPath = new Map<string, SourceFile>();
  for (const file of files) {
    const path = normalisePath(file.path);
    if (path) byPath.set(path, { path, contents: file.contents });
  }
  return byPath;
}

/**
 * Everything wrong with this expansion, worst first.
 *
 * An empty result means the step honoured its manifest. A step commissioned
 * with no manifest at all — an older blueprint with no file plan — is not
 * judged: there is nothing to hold it to, and inventing a contract after the
 * fact would condemn every project planned before file plans existed.
 */
export function verifyExpansion(step: ExpandedStep, context: ExpansionContext): Violation[] {
  const creates = context.stub.creates.map(normalisePath).filter(Boolean);
  const edits = context.stub.edits.map(normalisePath).filter(Boolean);
  const expected = [...new Set([...creates, ...edits])];

  if (expected.length === 0) return [];

  const starter = index(step.starterFiles);
  const solution = index(step.solutionFiles);
  const prior = index(context.priorFiles);

  const violations: Violation[] = [];
  const add = (code: ViolationCode, path: string, message: string): void => {
    violations.push({ code, path, severity: SEVERITY[code], message });
  };

  for (const path of expected) {
    const verb = creates.includes(path) ? 'creates' : 'edits';

    if (!starter.has(path)) {
      add(
        'missing_from_starter',
        path,
        `This step ${verb} "${path}", but starterFiles has no entry for it. The learner ` +
          `cannot add a file the editor does not show, so the checkpoint can never pass.`,
      );
    }

    const solved = solution.get(path);
    if (!solved) {
      add(
        'missing_from_solution',
        path,
        `This step ${verb} "${path}", but solutionFiles has no entry for it. Every later ` +
          `step is written against these files, so the project loses this file from here on.`,
      );
    } else if (isMissingContent(solved, path)) {
      add(
        'empty_solution_file',
        path,
        `solutionFiles["${path}"] is empty. It must be the complete working version of the ` +
          `file as it stands when this step is done.`,
      );
    }

    // Only an edited file can lose prior work: a created file has none to lose.
    const before = prior.get(path);
    const after = starter.get(path);
    if (edits.includes(path) && before && after) {
      const retained = retainedFraction(before, after);
      if (retained < PRIOR_WORK_RETENTION) {
        add(
          'clobbered_prior_work',
          path,
          `starterFiles["${path}"] dropped most of what the file already contained ` +
            `(${Math.round(retained * 100)}% of its substantial lines survived). An edited file ` +
            `must carry its existing contents forward and change only what this step needs.`,
        );
      }
    }
  }

  const allowed = new Set(expected);
  for (const [label, files] of [
    ['starterFiles', starter],
    ['solutionFiles', solution],
  ] as const) {
    for (const path of files.keys()) {
      if (allowed.has(path)) continue;
      add(
        'foreign_file',
        path,
        `${label} contains "${path}", which is not in this step's creates or edits. Another ` +
          `step owns that file in the plan.`,
      );
    }
  }

  return [...violations].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'serious' ? -1 : 1,
  );
}

/** Whether anything here is bad enough to be worth generating the step again. */
export function hasSeriousViolation(violations: readonly Violation[]): boolean {
  return violations.some((violation) => violation.severity === 'serious');
}

/**
 * The violations, written for the model rather than for a log.
 *
 * Fed back as a trailing turn on the retry. Naming the specific files is what
 * makes a second call worth paying for — "try again" produces another guess,
 * while "solutionFiles omitted src/store.js" produces the file.
 */
export function renderViolations(violations: readonly Violation[]): string {
  const lines = [
    '<expansion_rejected>',
    'Your previous answer did not follow this step’s file manifest. Fix exactly these ' +
      'problems and return the whole step again:',
    ...violations.map((violation) => `- ${violation.message}`),
    'Keep everything else about the step as it was. Do not shrink the instructions, the ' +
      'explanation, the alternatives or the hints to make room.',
    '</expansion_rejected>',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Repair
 * ------------------------------------------------------------------ */

/** A file the learner has to write, when the step failed to scaffold one. */
function placeholderFor(path: string): SourceFile {
  return {
    path,
    contents: `// TODO: write ${path} for this step.\n`,
  };
}

/**
 * Force the expansion to match its manifest.
 *
 * Applied whether or not a retry happened, because the retry can come back
 * wrong too and a step is persisted exactly once. Every branch prefers keeping
 * the learner's real code over the model's account of it.
 *
 *   - Files outside the manifest are dropped. Another step owns them, and
 *     writing them here would overwrite that step's work.
 *   - An edited file missing from starterFiles is restored from `priorFiles`,
 *     which is the real project, so the learner opens on their own code.
 *   - An edited file that dropped its prior contents is replaced by the real
 *     file for the same reason. The scaffolding this step wanted to add is
 *     lost; their work is not, and that is the right way round.
 *   - A created file missing from starterFiles becomes an empty TODO stub, so
 *     the editor at least has a tab for it and the step can be passed.
 *   - A file missing from solutionFiles falls back to the starter, so the next
 *     step inherits something rather than a hole.
 */
export function repairExpansion(step: ExpandedStep, context: ExpansionContext): ExpandedStep {
  const creates = context.stub.creates.map(normalisePath).filter(Boolean);
  const edits = context.stub.edits.map(normalisePath).filter(Boolean);
  const expected = [...new Set([...creates, ...edits])];

  if (expected.length === 0) return step;

  const starter = index(step.starterFiles);
  const solution = index(step.solutionFiles);
  const prior = index(context.priorFiles);

  const repairedStarter: SourceFile[] = [];
  const repairedSolution: SourceFile[] = [];

  for (const path of expected) {
    const before = prior.get(path);
    const provided = starter.get(path);

    /*
     * Which copy of this file to open the editor on, in order of preference.
     *
     * Normally the step's own version leads: it is the one carrying whatever
     * scaffolding this step means to add. It is demoted below the real file
     * only when it cannot be trusted - an edited file whose prior contents it
     * dropped - because then the alternative is handing the learner the
     * model's paraphrase of code they wrote themselves.
     */
    const untrustedEdit =
      edits.includes(path) &&
      before !== undefined &&
      (provided === undefined || retainedFraction(before, provided) < PRIOR_WORK_RETENTION);

    /*
     * A blank file counts as no file at all, so the search falls through it.
     * Without that the emptiness propagates: the solution falls back to the
     * starter below, and the step is repaired into one that still verifies as
     * broken. Which is how this was found - repair is the last chance to make
     * the manifest true, so it has to always succeed.
     */
    const start =
      [untrustedEdit ? before : provided, untrustedEdit ? provided : before].find(
        (candidate) => !isMissingContent(candidate, path),
      ) ?? placeholderFor(path);

    repairedStarter.push(start);

    const solved = solution.get(path);
    repairedSolution.push(
      isMissingContent(solved, path) ? { path, contents: start.contents } : solved!,
    );
  }

  return { ...step, starterFiles: repairedStarter, solutionFiles: repairedSolution };
}

/* ------------------------------------------------------------------ *
 * The finished project
 * ------------------------------------------------------------------ */

export interface CompletenessReport {
  complete: boolean;
  /** Planned files the finished project does not contain. */
  missing: string[];
  /** Files the project contains that the plan never mentioned. */
  unplanned: string[];
}

/**
 * Whether the finished project is actually the project that was planned.
 *
 * The last step is supposed to leave something the learner can run and show
 * someone. Nothing checked that, so a project could reach its final step still
 * missing a file the plan called for — and the first anyone knew was the
 * learner downloading a repository that does not start.
 *
 * `unplanned` is reported but is not a failure: a learner is free to add files,
 * and by the end the code is theirs.
 */
export function verifyProjectComplete(
  plannedPaths: readonly string[],
  actualFiles: readonly SourceFile[],
): CompletenessReport {
  const planned = new Set(plannedPaths.map(normalisePath).filter(Boolean));
  const actual = new Set(actualFiles.map((file) => normalisePath(file.path)).filter(Boolean));

  const missing = [...planned].filter((path) => !actual.has(path)).sort();
  const unplanned = [...actual].filter((path) => !planned.has(path)).sort();

  return { complete: missing.length === 0, missing, unplanned };
}
