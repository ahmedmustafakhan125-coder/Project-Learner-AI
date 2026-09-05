import { describe, expect, it } from 'vitest';

import type { ExpandedStep } from '../src/schemas/step.js';
import {
  hasSeriousInstructionIssue,
  looksLikeIdentifier,
  MIN_INSTRUCTION_CHARS,
  mentionsSymbol,
  prosePart,
  verifyInstructions,
  type InstructionContext,
} from '../src/generation/verifyInstructions.js';

/**
 * Whether a step actually tells the learner what to do.
 *
 * The two halves are tested separately because they fail differently. The
 * naming checks catch a step that grades on a symbol it never mentioned — the
 * learner cannot pass except by guessing the spelling. The shape checks catch a
 * step with nothing gradeable at all, which is the "set up your development
 * environment" filler that has no symbols for the first kind to bite on.
 *
 * The acceptance cases carry as much weight as the refusals. These issues cost
 * a whole generation to correct, so a check that fires on good instructions is
 * worse than one that misses bad ones — it doubles the price of every step and
 * teaches whoever reads the logs to ignore them.
 */

/* ------------------------------------------------------------------ */

const EXACT = `### What you're building

Todos that survive a reload, instead of vanishing when the page refreshes.

### Your tasks

1. **storage.js** — export \`save(todos)\`. It takes the todos array and returns
   nothing. Serialise with \`JSON.stringify\` and write to \`localStorage\` under
   the key \`todos\`.
2. **storage.js** — export \`load()\`. Return the parsed array, or \`[]\` when the
   key is absent. \`JSON.parse(null)\` returns null rather than throwing, which
   is the trap here.
3. **app.js** — call \`save(todos)\` as the last line of \`addTodo\`.

### Done when

You add a todo, reload the page, and it is still listed.`;

/** What the old prompt produced, and what this whole module exists to catch. */
const GENERIC = `## Set Up the Project

In this step you'll set up your development environment and create the basic
project structure. You'll install the necessary dependencies and make sure
everything is configured correctly.

Create the main application file and add the basic scaffolding. Make sure to
test that everything runs correctly before moving on to the next step.`;

function step(instructionsMd: string, requiredSymbols: string[] = []): ExpandedStep {
  return {
    instructionsMd,
    explanationMd: 'why',
    alternatives: [],
    hints: [],
    checkpoint: { requiredFiles: [], requiredSymbols, tests: [], runtime: 'web' },
    starterFiles: [],
    solutionFiles: [],
  };
}

function context(creates: string[] = [], edits: string[] = [], symbols: string[] = []): InstructionContext {
  return { stub: { creates, edits }, checkpoint: { requiredSymbols: symbols } };
}

function codesOf(issues: ReturnType<typeof verifyInstructions>): string[] {
  return issues.map((issue) => issue.code);
}

/* ------------------------------------------------------------------ *
 * Naming: the instructions and the grader must agree
 * ------------------------------------------------------------------ */

describe('a symbol the checkpoint grades on but never names', () => {
  it('is caught', () => {
    // The trap: requiredSymbols is matched literally against the learner's
    // code. Grading on a name never written down means they cannot pass except
    // by guessing which word the model had in mind.
    const issues = verifyInstructions(
      step(GENERIC, ['addTodo']),
      context([], [], ['addTodo']),
    );
    expect(codesOf(issues)).toContain('ungraded_symbol');
    expect(hasSeriousInstructionIssue(issues)).toBe(true);
  });

  it('names the symbol, so the retry can fix it specifically', () => {
    const issues = verifyInstructions(step(GENERIC, ['addTodo']), context([], [], ['addTodo']));
    const issue = issues.find((i) => i.code === 'ungraded_symbol');
    expect(issue!.detail).toBe('addTodo');
    expect(issue!.message).toContain('addTodo');
  });

  it('does not fire when the instructions name it', () => {
    const issues = verifyInstructions(
      step(EXACT, ['save', 'load']),
      context(['storage.js'], ['app.js'], ['save', 'load']),
    );
    expect(codesOf(issues)).not.toContain('ungraded_symbol');
  });
});

describe('symbol matching', () => {
  it('accepts a dotted symbol named by its root', () => {
    // The checkpoint grades on `todos.push`; the instructions say "push onto
    // `todos`". Requiring the literal string would flag correct instructions
    // constantly, and a check that cries wolf gets switched off.
    expect(mentionsSymbol('push the new item onto `todos`', 'todos.push')).toBe(true);
  });

  it('accepts a called symbol named without its parentheses', () => {
    expect(mentionsSymbol('call `initDb` once on startup', 'initDb(')).toBe(true);
  });

  it('rejects a root too short to mean anything', () => {
    // Two characters would match almost any prose by accident.
    expect(mentionsSymbol('the list is rendered here', 'x.y')).toBe(false);
  });

  it('does not count a symbol that appears only inside a code fence', () => {
    /*
     * A fenced block in the instructions is usually the solution the prompt
     * forbids, so counting it would reward exactly what should not be there.
     */
    const withFence = ['Write the function.', '```js', 'function addTodo() {}', '```'].join('\n');
    expect(mentionsSymbol(prosePart(withFence), 'addTodo')).toBe(false);
  });

  it('strips an unterminated fence rather than keeping the rest', () => {
    expect(prosePart('text\n```js\nfunction addTodo() {}')).not.toContain('addTodo');
  });
});

describe('a file the step is graded on but never mentions', () => {
  it('is caught', () => {
    const issues = verifyInstructions(step(GENERIC), context(['storage.js'], []));
    expect(codesOf(issues)).toContain('unmentioned_file');
    expect(hasSeriousInstructionIssue(issues)).toBe(true);
  });

  it('accepts the bare filename in place of the full path', () => {
    // "**app.js**" names src/app.js clearly enough; demanding the full path
    // would flag good instructions.
    const issues = verifyInstructions(step(EXACT), context(['src/storage.js'], ['src/app.js']));
    expect(codesOf(issues)).not.toContain('unmentioned_file');
  });
});

/* ------------------------------------------------------------------ *
 * Shape: the only lever on a step with nothing to grade
 * ------------------------------------------------------------------ */

describe('instructions with no concrete work in them', () => {
  it('catches generic prose with no task list', () => {
    // A setup step has no symbols and no files to check against, so shape is
    // all there is - and setup steps are exactly the ones that read as filler.
    expect(codesOf(verifyInstructions(step(GENERIC), context()))).toContain('no_task_list');
  });

  it('catches instructions that never say when the learner is done', () => {
    expect(codesOf(verifyInstructions(step(GENERIC), context()))).toContain('no_done_criteria');
  });

  it('catches instructions too short to contain anything', () => {
    const issues = verifyInstructions(step('Add persistence.'), context());
    expect(codesOf(issues)).toContain('too_thin');
    expect(hasSeriousInstructionIssue(issues)).toBe(true);
  });

  it('does not count a code fence towards the length', () => {
    // Padding the instructions with the solution is not writing instructions.
    const padded = `Do it.\n\`\`\`js\n${'const x = 1;\n'.repeat(40)}\`\`\``;
    expect(codesOf(verifyInstructions(step(padded), context()))).toContain('too_thin');
  });

  it('treats shape problems as not worth a second generation on their own', () => {
    /*
     * Prose can carry both a task list and a finish line without the exact
     * headings. Re-asking purely over a heading is the waste the retry policy
     * exists to avoid - so these are reported, not retried.
     */
    const shapeOnly = `${'Write the parser so that it handles nested arrays correctly. '.repeat(6)}`;
    const issues = verifyInstructions(step(shapeOnly), context());
    expect(codesOf(issues)).toEqual(
      expect.arrayContaining(['no_task_list', 'no_done_criteria']),
    );
    expect(hasSeriousInstructionIssue(issues)).toBe(false);
  });

  it('accepts a finish line phrased without the heading', () => {
    const phrased = `${'Write the parser and wire it into the reader. '.repeat(6)}
1. **parser.js** — export \`parse\`.

You'll know it works when running the file prints the parsed tree.`;
    expect(codesOf(verifyInstructions(step(phrased), context()))).not.toContain('no_done_criteria');
  });

  it('accepts a task list numbered with parentheses', () => {
    const parens = `${'Set up the database and open a connection to it. '.repeat(6)}
1) **db.js** — export \`initDb()\`.

### Done when
The app starts without an error.`;
    expect(codesOf(verifyInstructions(step(parens), context()))).not.toContain('no_task_list');
  });
});

/* ------------------------------------------------------------------ *
 * Mutation check
 * ------------------------------------------------------------------ */

describe('instructions written the way the prompt asks', () => {
  it('produce no issues at all', () => {
    const issues = verifyInstructions(
      step(EXACT, ['save', 'load']),
      context(['storage.js'], ['app.js'], ['save', 'load']),
    );
    expect(issues).toEqual([]);
  });

  it('are well clear of the length floor', () => {
    // If the fixture only just cleared it, the floor would be untested.
    expect(prosePart(EXACT).trim().length).toBeGreaterThan(MIN_INSTRUCTION_CHARS * 1.5);
  });

  it('put serious issues before cosmetic ones', () => {
    const issues = verifyInstructions(step(GENERIC, ['addTodo']), context(['x.js'], [], ['addTodo']));
    expect(issues[0]!.severity).toBe('serious');
    expect(issues[issues.length - 1]!.severity).toBe('cosmetic');
  });

  it('judge nothing when there is no manifest and nothing graded', () => {
    // An older blueprint with no file plan and a step with no symbols still
    // gets the shape checks, but nothing that would call it uncompletable.
    const issues = verifyInstructions(step(EXACT), context());
    expect(hasSeriousInstructionIssue(issues)).toBe(false);
  });
});

describe('looksLikeIdentifier', () => {
  it('accepts things a learner would actually type', () => {
    for (const symbol of ['addTodo', 'initDb(', 'todos.push', '#todo-list', 'CREATE TABLE']) {
      expect(looksLikeIdentifier(symbol)).toBe(true);
    }
  });

  it('rejects a description dressed up as a symbol', () => {
    // requiredSymbols is grepped literally, so a sentence there fails layer 2
    // for everyone regardless of what they wrote.
    expect(looksLikeIdentifier('  a function that adds  a todo to the list  ')).toBe(false);
    expect(looksLikeIdentifier('')).toBe(false);
    expect(looksLikeIdentifier('x'.repeat(80))).toBe(false);
  });
});
