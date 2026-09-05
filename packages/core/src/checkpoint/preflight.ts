import type { SourceFile } from '../schemas/step.js';

/**
 * What has to be true before a submission is graded at all.
 *
 * The checkpoint's own layers answer "is this correct". These answer the
 * cheaper question underneath it — "is this an attempt" — and they exist
 * because the answer was previously always yes.
 *
 * Three things made an empty submission pass:
 *
 *   - Layer 2 was `allContents.includes(symbol)` over every file joined
 *     together, so a required symbol pasted into a COMMENT satisfied it.
 *   - `groundCheckpoint` downgrades a step the sandbox cannot run to
 *     `runtime: "none"` with no tests, and the runner then treats "no tests" as
 *     a pass. Layers 1 and 2 were the entire check for those steps.
 *   - Nothing compared the submission to the starter files, so pressing submit
 *     on the untouched scaffolding counted as an attempt like any other.
 *
 * Together that is: create the file, paste the required symbols into a comment,
 * submit. It passes, and — worse than passing — each press is recorded as a
 * failed attempt, which is exactly what the hint ladder unlocks on. The abuse
 * was not just skipping the work, it was farming the help.
 *
 * A rejection here is deliberately NOT an attempt. It is refused before the
 * attempt row is written, so it moves no gate, feeds the pacing model nothing,
 * and costs nothing. That is the whole point: making junk cheap to refuse and
 * worthless to repeat.
 *
 * Portable by construction — no Node, no DOM — because `apps/web` runs it for
 * instant feedback and `apps/api` runs it as the authority.
 */

export type PreflightCode =
  | 'empty_file'
  | 'unchanged'
  | 'todo_left'
  | 'symbols_in_comments';

export interface PreflightFailure {
  code: PreflightCode;
  /** Shown to the learner. Says what to do, not just that something is wrong. */
  message: string;
  /** The files or symbols at fault, for the UI to list. */
  details: string[];
}

export interface PreflightInput {
  /** This step's files, as the learner is submitting them. */
  submitted: readonly SourceFile[];
  /** The scaffolding the step handed them, for comparison. */
  starter: readonly SourceFile[];
  /** From the checkpoint. Only these files are held to these rules. */
  requiredFiles: readonly string[];
  requiredSymbols: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Comment stripping
 * ------------------------------------------------------------------ */

interface Syntax {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
  /** Quote characters that open a string. Contents are KEPT. */
  quotes: readonly string[];
  /** Python's triple quotes, which span lines and nest the single form. */
  tripleQuotes: readonly string[];
}

const JS_LIKE: Syntax = {
  line: ['//'],
  block: [['/*', '*/']],
  quotes: ['"', "'", '`'],
  tripleQuotes: [],
};

const SYNTAX_BY_EXT: Record<string, Syntax> = {
  js: JS_LIKE,
  mjs: JS_LIKE,
  cjs: JS_LIKE,
  jsx: JS_LIKE,
  ts: JS_LIKE,
  tsx: JS_LIKE,
  java: JS_LIKE,
  c: JS_LIKE,
  h: JS_LIKE,
  cpp: JS_LIKE,
  cs: JS_LIKE,
  go: JS_LIKE,
  rs: JS_LIKE,
  swift: JS_LIKE,
  kt: JS_LIKE,
  css: { line: [], block: [['/*', '*/']], quotes: ['"', "'"], tripleQuotes: [] },
  scss: JS_LIKE,
  py: {
    line: ['#'],
    block: [],
    quotes: ['"', "'"],
    tripleQuotes: ['"""', "'''"],
  },
  rb: { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: [] },
  sh: { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: [] },
  yml: { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: [] },
  yaml: { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: [] },
  html: { line: [], block: [['<!--', '-->']], quotes: [], tripleQuotes: [] },
  htm: { line: [], block: [['<!--', '-->']], quotes: [], tripleQuotes: [] },
  md: { line: [], block: [['<!--', '-->']], quotes: [], tripleQuotes: [] },
};

function syntaxFor(path: string): Syntax | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return SYNTAX_BY_EXT[ext] ?? null;
}

/**
 * The same source with its comments removed and everything else intact.
 *
 * String CONTENTS are kept on purpose, and this is the line that matters most
 * here. A required symbol legitimately lives inside a string all the time —
 * `getElementById('todo-list')`, a dict key, a class name, a route. Stripping
 * strings as well would reject correct work, which is a far worse failure than
 * letting someone hide a symbol in one: hiding it in a string still leaves them
 * facing tests that now actually run.
 *
 * HTML keeps its attribute values for the same reason, so only `<!-- -->` goes.
 *
 * Unknown extensions return the source untouched. Guessing at the comment
 * syntax of a file type we do not know would delete real code.
 */
export function stripComments(source: string, path: string): string {
  const syntax = syntaxFor(path);
  if (!syntax) return source;

  let out = '';
  let i = 0;

  outer: while (i < source.length) {
    // A string: copy it through verbatim, delimiters and all, so a comment
    // marker inside one is not mistaken for a comment.
    for (const triple of syntax.tripleQuotes) {
      if (source.startsWith(triple, i)) {
        const close = source.indexOf(triple, i + triple.length);
        const end = close === -1 ? source.length : close + triple.length;
        out += source.slice(i, end);
        i = end;
        continue outer;
      }
    }

    const quote = syntax.quotes.find((q) => source.startsWith(q, i));
    if (quote) {
      out += quote;
      i += quote.length;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) {
          out += quote;
          i += quote.length;
          continue outer;
        }
        // An unterminated string would otherwise swallow the rest of the file.
        if (source[i] === '\n' && quote !== '`') break;
        out += source[i];
        i += 1;
      }
      continue;
    }

    for (const [open, close] of syntax.block) {
      if (source.startsWith(open, i)) {
        const end = source.indexOf(close, i + open.length);
        const stop = end === -1 ? source.length : end + close.length;
        // Newlines are kept so line numbers and the "is this blank" check
        // still describe the same file.
        out += source.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
        continue outer;
      }
    }

    for (const marker of syntax.line) {
      if (source.startsWith(marker, i)) {
        const nl = source.indexOf('\n', i);
        i = nl === -1 ? source.length : nl;
        continue outer;
      }
    }

    out += source[i];
    i += 1;
  }

  return out;
}

/** Comments gone, whitespace collapsed — what is left is the actual work. */
export function codeOnly(file: SourceFile): string {
  return stripComments(file.contents, file.path).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/** Lines of the starter that mark where the learner's work goes. */
function todoLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\bTODO\b/.test(line));
}

/**
 * Whether this submission is worth grading, or null when it is.
 *
 * Checked in order of how much it tells the learner: an empty file first, then
 * untouched scaffolding, then a surviving TODO, then symbols that exist only in
 * a comment. Each message names what to do next.
 *
 * Only `requiredFiles` are held to these rules. A step may legitimately ship a
 * data file or a stylesheet it never asks the learner to touch, and rejecting a
 * submission because `styles.css` matches the starter would be nonsense.
 */
export function preflightSubmission(input: PreflightInput): PreflightFailure | null {
  const { submitted, starter, requiredFiles, requiredSymbols } = input;

  const byPath = new Map(submitted.map((file) => [file.path, file]));
  const starterByPath = new Map(starter.map((file) => [file.path, file]));

  /*
   * Which files this gate applies to.
   *
   * `requiredFiles` when the checkpoint names any — that is the step saying
   * what it grades. When it names none, fall back to the files the step handed
   * over, because a step with no required files still has scaffolding and
   * pressing submit on it untouched is still not an attempt.
   */
  const starterPaths = [...starterByPath.keys()].filter((path) => byPath.has(path));

  let graded = requiredFiles.filter((path) => byPath.has(path));
  /*
   * A step can require a file an EARLIER step created - "index.html must still
   * exist" - and require nothing new of its own. Those paths are not in this
   * submission, so keying the gate on them alone would leave the step ungated
   * entirely. Falling back to the scaffolding covers it: whatever the step
   * handed over is what it expects to get back changed.
   */
  if (graded.length === 0) graded = starterPaths;

  if (graded.length === 0) return null;

  /* ---- 1. a file with nothing in it ---- */

  const empty = graded.filter((path) => codeOnly(byPath.get(path)!).length === 0);
  if (empty.length > 0) {
    return {
      code: 'empty_file',
      message:
        empty.length === 1
          ? `${empty[0]} is empty. Write the code for this step before submitting.`
          : `These files are empty: ${empty.join(', ')}. Write the code for this step first.`,
      details: empty,
    };
  }

  /* ---- 2. the scaffolding, handed back unchanged ----
     Compared after comments and whitespace go, so adding a blank line or a
     comment does not read as work. */

  const fromStarter = graded.filter((path) => starterByPath.has(path));
  const learnerCreated = graded.filter((path) => !starterByPath.has(path));

  const untouched = fromStarter.filter(
    (path) => codeOnly(byPath.get(path)!) === codeOnly(starterByPath.get(path)!),
  );

  /*
   * Only when the whole graded set is scaffolding and none of it moved.
   *
   * A file the learner created themselves is work by definition, so a step that
   * says "create utils.js, edit app.js" must not be told its code is unchanged
   * on the strength of app.js alone - the message would be simply false.
   */
  if (fromStarter.length > 0 && learnerCreated.length === 0 && untouched.length === fromStarter.length) {
    return {
      code: 'unchanged',
      message:
        'This is the starting code, unchanged. Fill in the part marked TODO, then submit.',
      details: untouched,
    };
  }

  /* ---- 3. the TODO that marks the work is still sitting there ---- */

  const leftTodo: string[] = [];
  for (const path of graded) {
    const original = starterByPath.get(path);
    if (!original) continue;
    const remaining = todoLines(original.contents).filter((line) =>
      byPath.get(path)!.contents.includes(line),
    );
    if (remaining.length > 0) leftTodo.push(path);
  }
  if (leftTodo.length > 0) {
    return {
      code: 'todo_left',
      message:
        leftTodo.length === 1
          ? `${leftTodo[0]} still has its TODO in it. Replace it with your code, then submit.`
          : `These files still have their TODOs: ${leftTodo.join(', ')}. Replace them, then submit.`,
      details: leftTodo,
    };
  }

  /* ---- 4. required symbols that appear only in comments ----
     The abuse this whole module exists for. Layer 2 searched the raw text, so
     `// addTodo, renderList` satisfied it completely. */

  if (requiredSymbols.length > 0) {
    const raw = submitted.map((file) => file.contents).join('\n');
    const code = submitted.map((file) => stripComments(file.contents, file.path)).join('\n');

    const hidden = requiredSymbols.filter(
      (symbol) => raw.includes(symbol) && !code.includes(symbol),
    );

    if (hidden.length > 0) {
      return {
        code: 'symbols_in_comments',
        message:
          hidden.length === 1
            ? `"${hidden[0]}" only appears in a comment. It has to be in the code itself.`
            : `These only appear in comments: ${hidden.join(', ')}. They have to be in the code.`,
        details: hidden,
      };
    }
  }

  return null;
}
