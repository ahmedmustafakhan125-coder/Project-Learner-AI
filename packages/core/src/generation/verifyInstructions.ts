import { stripComments } from '../checkpoint/preflight.js';
import type { StepStub } from '../schemas/project.js';
import type { Checkpoint, ExpandedStep } from '../schemas/step.js';
import { normalisePath } from './blueprint.js';

/**
 * Is this step actually telling the learner what to do?
 *
 * Instructions are the one part of a step the learner reads and works from, and
 * they were the least specified thing the expansion prompt asked for — three
 * short paragraphs, in a prompt that spent ten on starter files. What came back
 * was true of almost any step of almost any project: "set up the project
 * structure and install the dependencies you need."
 *
 * The sharper failure is that nothing tied the instructions to the checkpoint.
 * Both are produced by one call and neither was reconciled against the other,
 * so the prose could say "write a function that adds a todo" while
 * `requiredSymbols` graded on the literal string `addTodo`. The learner then
 * cannot pass except by guessing which word the grader had in mind, and the
 * failure message tells them a symbol is missing from code they believe they
 * wrote correctly.
 *
 * That is what these checks are for. Two of them are about naming — every
 * graded symbol and every graded file has to appear in the text — and the rest
 * are about shape, which is the only lever available on a step that has no
 * symbols to grade at all. A "set up your environment" step is exactly the kind
 * that reads as filler, and exactly the kind these catch.
 *
 * Deliberately NOT repairable, unlike the file manifest. A missing file can be
 * synthesised; prose cannot. The only remedy is to ask again, so these feed the
 * retry decision and nothing else — if a second attempt is no better, the step
 * ships as written rather than being blocked on a matter of style.
 */

export type InstructionIssueCode =
  /** A symbol the checkpoint grades on is never named in the instructions. */
  | 'ungraded_symbol'
  /** A file this step creates or edits is never named in the instructions. */
  | 'unmentioned_file'
  /** No numbered task list, so there is nothing concrete to work through. */
  | 'no_task_list'
  /** No observable finish line, so the learner cannot tell when they are done. */
  | 'no_done_criteria'
  /** Too short to be instructions for work measured in tens of minutes. */
  | 'too_thin';

export type InstructionSeverity = 'serious' | 'cosmetic';

export interface InstructionIssue {
  code: InstructionIssueCode;
  /** The symbol or file at fault, or the section that is missing. */
  detail: string;
  severity: InstructionSeverity;
  /** Written to be handed back to the model, so it says what to fix. */
  message: string;
}

export interface InstructionContext {
  stub: Pick<StepStub, 'creates' | 'edits'>;
  checkpoint: Pick<Checkpoint, 'requiredSymbols'>;
}

/**
 * Instructions shorter than this are not instructions.
 *
 * A step is twenty to ninety minutes of work. Under roughly a short paragraph
 * there is no room to have named a file, a symbol and a finish line, which is
 * the floor these checks exist to enforce.
 */
export const MIN_INSTRUCTION_CHARS = 220;

/**
 * Severity is about whether the learner can finish the step.
 *
 * SERIOUS — the step is not completable as written:
 *   - ungraded_symbol: graded on a name they were never given.
 *   - unmentioned_file: told to produce a file nothing asked them for.
 *   - too_thin: there is nothing there to work from.
 *
 * COSMETIC — the step is worse but still workable:
 *   - no_task_list / no_done_criteria: prose can carry both without the
 *     headings, and re-asking purely over a missing heading is the waste the
 *     retry policy exists to avoid. Reported so a drift back to shapeless
 *     prose is visible before it becomes the norm again.
 */
const SEVERITY: Record<InstructionIssueCode, InstructionSeverity> = {
  ungraded_symbol: 'serious',
  unmentioned_file: 'serious',
  too_thin: 'serious',
  no_task_list: 'cosmetic',
  no_done_criteria: 'cosmetic',
};

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

/** A numbered item — "1." or "1)" — at the start of a line. */
const ORDERED_ITEM = /^\s{0,3}\d+[.)]\s+\S/m;

/**
 * A finish line the learner can check.
 *
 * Matched on the heading the prompt asks for, and on the couple of phrasings a
 * model reaches for instead. Loose on purpose: a false positive here would cost
 * a whole generation to correct a heading.
 */
const DONE_SECTION = /^#{1,6}\s.*\b(done|finished|success|working)\b/im;
const DONE_PHRASE = /\b(you(?:'| a)?re done when|done when|you'll know it works when|verify that)\b/i;

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/**
 * Whether the instructions name this symbol.
 *
 * Compared against the prose with its code fences stripped. A symbol that
 * appears ONLY inside a fenced block in the instructions has not been named to
 * the learner in a way they can act on — and more to the point, a fenced block
 * in instructions is usually the solution the prompt forbids, so counting it
 * would reward exactly what should not be there.
 */
export function mentionsSymbol(prose: string, symbol: string): boolean {
  const needle = symbol.trim();
  if (!needle) return true;
  if (prose.includes(needle)) return true;

  /*
   * A dotted or called form counts as naming its root. The checkpoint often
   * grades on `todos.push` or `initDb(`, while the instructions quite
   * reasonably say "push onto `todos`" and "call `initDb`". Requiring the
   * literal string there would flag correct instructions constantly, and a
   * check that cries wolf gets switched off.
   */
  const root = needle.split(/[.(\s[]/)[0] ?? '';
  return root.length >= 3 && prose.includes(root);
}

/** The instructions with fenced code blocks removed. */
export function prosePart(instructionsMd: string): string {
  return instructionsMd.replace(/```[\s\S]*?(?:```|$)/g, ' ');
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

/** Everything wrong with this step's instructions, worst first. */
export function verifyInstructions(
  step: ExpandedStep,
  context: InstructionContext,
): InstructionIssue[] {
  const issues: InstructionIssue[] = [];
  const add = (code: InstructionIssueCode, detail: string, message: string): void => {
    issues.push({ code, detail, severity: SEVERITY[code], message });
  };

  const instructions = step.instructionsMd ?? '';
  const prose = prosePart(instructions);

  if (prose.trim().length < MIN_INSTRUCTION_CHARS) {
    add(
      'too_thin',
      `${prose.trim().length} characters`,
      `The instructions are ${prose.trim().length} characters long, which is not enough to have ` +
        `named a file, a symbol and a finish line. Write the three sections in full.`,
    );
  }

  if (!ORDERED_ITEM.test(instructions)) {
    add(
      'no_task_list',
      'Your tasks',
      'The instructions have no numbered task list. Write a "### Your tasks" section as a ' +
        'numbered list, one item per piece of work, each naming the file it happens in.',
    );
  }

  if (!DONE_SECTION.test(instructions) && !DONE_PHRASE.test(prose)) {
    add(
      'no_done_criteria',
      'Done when',
      'The instructions never say how the learner can tell they have finished. Add a ' +
        '"### Done when" section describing what they will observe when they run it.',
    );
  }

  /* ---- naming: the checkpoint and the instructions must agree ---- */

  for (const symbol of context.checkpoint.requiredSymbols) {
    if (mentionsSymbol(prose, symbol)) continue;
    add(
      'ungraded_symbol',
      symbol,
      `The checkpoint requires the symbol "${symbol}" but the instructions never name it. It is ` +
        `matched literally against the learner's code, so they cannot pass this step except by ` +
        `guessing that exact spelling. Name it in the task that introduces it, or stop grading on it.`,
    );
  }

  const files = [...new Set([...context.stub.creates, ...context.stub.edits])]
    .map(normalisePath)
    .filter(Boolean);

  for (const path of files) {
    // The bare filename counts: "**app.js**" is naming src/app.js clearly
    // enough, and demanding the full path would flag good instructions.
    const base = path.split('/').pop() ?? path;
    if (prose.includes(path) || prose.includes(base)) continue;
    add(
      'unmentioned_file',
      path,
      `This step is graded on "${path}" but the instructions never mention it. Every file the ` +
        `step creates or edits must appear in the task list.`,
    );
  }

  return [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'serious' ? -1 : 1,
  );
}

/** Whether anything here is worth generating the step again for. */
export function hasSeriousInstructionIssue(issues: readonly InstructionIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'serious');
}

/**
 * Whether a symbol is one the learner could ever type.
 *
 * Not part of verification — exported because it is the same question the
 * checkpoint's own layer 2 asks, and a step whose `requiredSymbols` are
 * sentences rather than identifiers fails that layer for everyone. Kept here so
 * the two definitions of "a symbol" cannot drift.
 */
export function looksLikeIdentifier(symbol: string): boolean {
  const trimmed = symbol.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  // A space is the giveaway: "a function that adds a todo" is a description.
  if (/\s{2,}/.test(trimmed)) return false;
  return /[A-Za-z_$][\w$]*/.test(stripComments(trimmed, 'x.txt'));
}
