import { normalisePath } from '../generation/blueprint.js';
import type { SourceFile } from '../schemas/step.js';

/**
 * Which files a step shows, which of them the learner may type in, and which
 * one the editor should open on.
 *
 * This used to be three expressions inlined in `StepView`, which is how it went
 * wrong: the tab bar was built as `[...inherited, ...own]`, so opening a step
 * landed the learner on a read-only file from some earlier step. On step 3 of a
 * todo list that is `index.html` — greyed out, uneditable, and the first thing
 * they see. Their own `app.js` was the last tab along.
 *
 * Pulled out here because it is domain logic with real cases in it, and because
 * the cases are not obvious from the component: a step that edits a file an
 * earlier step created, a step that creates everything, a step that owns
 * nothing, and the same file written two ways.
 */

export interface WorkspaceInput {
  /**
   * Files this step owns — the learner's saved draft if they have one, the
   * starter files if not. These are the ones they may edit and the ones the
   * step is graded on.
   */
  ownFiles: readonly SourceFile[];
  /** Everything the earlier steps produced, as the server assembled it. */
  priorFiles: readonly SourceFile[];
}

export interface Workspace {
  /** Every file, in the order the tab bar should show them. */
  files: SourceFile[];
  /** Paths the editor must refuse to change. */
  readOnlyPaths: string[];
  /** Paths this step owns, for filtering an edit back out. */
  ownPaths: string[];
  /**
   * The tab to open on: the learner's own work, never an inherited file.
   *
   * Null only when the step has no files at all, which is a step with nothing
   * to do — the caller renders a message rather than an editor.
   */
  initialPath: string | null;
}

/**
 * Assemble the workspace for one step.
 *
 * Three rules, and each exists because getting it wrong is invisible:
 *
 *  1. The step's own files come FIRST. The tab a learner lands on should be
 *     the one they are meant to work in.
 *  2. A path in both sets belongs to this step. `edits` means the step was
 *     handed that file to change, so the editable copy has to win — taking the
 *     inherited one would show them the version they started from and quietly
 *     discard whatever they had typed.
 *  3. Paths are compared normalised. `./app.js` and `app.js` are one file, and
 *     treating them as two produces a duplicate tab where edits to one are
 *     invisible in the other.
 */
export function composeWorkspace(input: WorkspaceInput): Workspace {
  const own: SourceFile[] = [];
  const ownPaths = new Set<string>();

  /*
   * Both lists are guarded rather than trusted.
   *
   * A step fetched before `priorFiles` was part of the payload has it as
   * undefined, and iterating that throws during render - which takes the whole
   * page down, because there is no error boundary around the step body. The
   * cost of being wrong here is far higher than the cost of the check.
   */
  for (const file of input.ownFiles ?? []) {
    const path = normalisePath(file.path);
    if (!path || ownPaths.has(path)) continue;
    ownPaths.add(path);
    own.push({ path, contents: file.contents });
  }

  const inherited: SourceFile[] = [];
  const seen = new Set(ownPaths);

  for (const file of input.priorFiles ?? []) {
    const path = normalisePath(file.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    inherited.push({ path, contents: file.contents });
  }

  const files = [...own, ...inherited];

  return {
    files,
    readOnlyPaths: inherited.map((file) => file.path),
    ownPaths: [...ownPaths],
    initialPath: files[0]?.path ?? null,
  };
}
