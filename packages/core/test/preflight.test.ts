import { describe, expect, it } from 'vitest';

import { codeOnly, preflightSubmission, stripComments } from '../src/checkpoint/preflight.js';

/**
 * The submit gate.
 *
 * Each rejection test here corresponds to a way the checkpoint could previously
 * be passed, or farmed, without writing code. The acceptance tests matter just
 * as much: a gate that rejects honest work is worse than the abuse it prevents,
 * because the learner cannot tell it is wrong.
 */

const STARTER = [
  {
    path: 'app.js',
    contents: [
      'const todos = [];',
      '',
      'function addTodo(text) {',
      '  // TODO: push a new todo onto the array and re-render',
      '}',
    ].join('\n'),
  },
];

const CHECKPOINT = { requiredFiles: ['app.js'], requiredSymbols: ['addTodo', 'todos.push'] };

function check(contents: string) {
  return preflightSubmission({
    submitted: [{ path: 'app.js', contents }],
    starter: STARTER,
    ...CHECKPOINT,
  });
}

const SOLVED = [
  'const todos = [];',
  '',
  'function addTodo(text) {',
  '  todos.push({ text: text, done: false });',
  '  render();',
  '}',
].join('\n');

/* ------------------------------------------------------------------ */

describe('stripComments', () => {
  it('removes line and block comments from JS', () => {
    const out = stripComments('const a = 1; // addTodo\n/* todos.push */\nconst b = 2;', 'a.js');
    expect(out).not.toContain('addTodo');
    expect(out).not.toContain('todos.push');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('keeps string contents, because required symbols live in them', () => {
    // getElementById('todo-list') is the overwhelmingly common shape. Stripping
    // strings here would reject correct work.
    const out = stripComments(`document.getElementById('todo-list');`, 'a.js');
    expect(out).toContain('todo-list');
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    const out = stripComments(`const url = "https://example.com/x"; const y = 1;`, 'a.js');
    expect(out).toContain('https://example.com/x');
    expect(out).toContain('const y = 1;');
  });

  it('handles Python comments and triple-quoted strings', () => {
    const src = ['# add_todo', 'def add_todo(text):', '    """docstring add_todo"""', '    pass'].join('\n');
    const out = stripComments(src, 'main.py');
    expect(out).toContain('def add_todo(text):');
    expect(out).toContain('docstring add_todo');
    expect(out.split('\n')[0]).not.toContain('# add_todo');
  });

  it('does not mistake a Python # inside a string for a comment', () => {
    const out = stripComments(`colour = "#ff0000"\nx = 1`, 'main.py');
    expect(out).toContain('#ff0000');
    expect(out).toContain('x = 1');
  });

  it('strips HTML comments but keeps attribute values', () => {
    const out = stripComments('<!-- todo-list --><ul id="todo-list"></ul>', 'index.html');
    expect(out).toContain('id="todo-list"');
    expect(out.indexOf('todo-list')).toBe(out.lastIndexOf('todo-list'));
  });

  it('leaves an unknown file type untouched rather than guessing', () => {
    const src = '# not necessarily a comment';
    expect(stripComments(src, 'data.weird')).toBe(src);
  });

  it('does not let an unterminated string swallow the file', () => {
    const out = stripComments(`const a = "oops\nconst b = 2;`, 'a.js');
    expect(out).toContain('const b = 2;');
  });
});

describe('codeOnly', () => {
  it('ignores comments and whitespace when comparing work', () => {
    const a = { path: 'a.js', contents: 'const x = 1;' };
    const b = { path: 'a.js', contents: '\n\n// a comment\nconst   x = 1;\n' };
    expect(codeOnly(a)).toBe(codeOnly(b));
  });
});

/* ------------------------------------------------------------------ */

describe('preflightSubmission — refusals', () => {
  it('refuses an empty file', () => {
    expect(check('')?.code).toBe('empty_file');
    expect(check('\n\n   \n')?.code).toBe('empty_file');
  });

  it('refuses a file that is only comments', () => {
    // Comment-only is empty as far as the step is concerned.
    expect(check('// addTodo\n// todos.push')?.code).toBe('empty_file');
  });

  it('refuses the starter files handed back untouched', () => {
    expect(check(STARTER[0]!.contents)?.code).toBe('unchanged');
  });

  it('refuses the starter with only whitespace or comments added', () => {
    const padded = STARTER[0]!.contents + '\n\n// working on it\n';
    expect(check(padded)?.code).toBe('unchanged');
  });

  it('refuses work that still has the starter TODO in it', () => {
    const half = STARTER[0]!.contents.replace('}', '  const x = 1;\n}');
    expect(check(half)?.code).toBe('todo_left');
  });

  it('refuses required symbols that appear only in a comment', () => {
    // The documented abuse: create the file, paste the symbols into a comment,
    // submit. Layer 2 was a substring search over the raw text and passed it.
    const faked = 'const todos = [];\nfunction f() {}\n// addTodo todos.push';
    const failure = preflightSubmission({
      submitted: [{ path: 'app.js', contents: faked }],
      starter: STARTER,
      ...CHECKPOINT,
    });
    expect(failure?.code).toBe('symbols_in_comments');
    expect(failure?.details).toEqual(['addTodo', 'todos.push']);
  });

  it('still gates a step whose required files all came from earlier steps', () => {
    /*
     * A step can require only files an earlier step created. Those paths are
     * not in this submission, so without a fallback the gate found nothing to
     * judge and waved the step through untouched.
     */
    const failure = preflightSubmission({
      submitted: [{ path: 'app.js', contents: STARTER[0]!.contents }],
      starter: STARTER,
      requiredFiles: ['index.html'], // owned by step 1, not submitted here
      requiredSymbols: [],
    });
    expect(failure?.code).toBe('unchanged');
  });

  it('names what is wrong, not just that something is', () => {
    expect(check('')?.message).toContain('app.js');
    expect(check(STARTER[0]!.contents)?.message).toMatch(/TODO/);
  });
});

describe('preflightSubmission — acceptances', () => {
  it('accepts real work', () => {
    expect(check(SOLVED)).toBeNull();
  });

  it('accepts work that keeps its own unrelated TODO', () => {
    // Only a TODO carried over verbatim from the STARTER counts. A learner
    // leaving a note for themselves is not an unfinished step.
    const withNote = SOLVED + '\n// TODO: add filtering later\n';
    expect(check(withNote)).toBeNull();
  });

  it('accepts a symbol that only ever appears inside a string', () => {
    const failure = preflightSubmission({
      submitted: [
        { path: 'app.js', contents: `const list = document.getElementById('todo-list');` },
      ],
      starter: [],
      requiredFiles: ['app.js'],
      requiredSymbols: ['todo-list'],
    });
    expect(failure).toBeNull();
  });

  it('accepts a file the learner created themselves, with no starter to match', () => {
    const failure = preflightSubmission({
      submitted: [{ path: 'new.js', contents: 'export const a = 1;' }],
      starter: [],
      requiredFiles: ['new.js'],
      requiredSymbols: [],
    });
    expect(failure).toBeNull();
  });

  it('ignores files the checkpoint does not require', () => {
    // styles.css matching the starter is not a reason to refuse the submission.
    const failure = preflightSubmission({
      submitted: [
        { path: 'app.js', contents: SOLVED },
        { path: 'styles.css', contents: '.todo { color: red; }' },
      ],
      starter: [...STARTER, { path: 'styles.css', contents: '.todo { color: red; }' }],
      ...CHECKPOINT,
    });
    expect(failure).toBeNull();
  });

  it('does not call new work "unchanged" because a sibling file was not touched', () => {
    // "create utils.js, edit app.js": utils.js is real work, so refusing with
    // "this is the starting code, unchanged" would be false.
    const failure = preflightSubmission({
      submitted: [
        { path: 'app.js', contents: STARTER[0]!.contents },
        { path: 'utils.js', contents: 'export function slug(s) { return s.trim(); }' },
      ],
      starter: STARTER,
      requiredFiles: ['app.js', 'utils.js'],
      requiredSymbols: [],
    });
    expect(failure?.code).not.toBe('unchanged');
  });

  it('says nothing when there is nothing to judge', () => {
    expect(
      preflightSubmission({ submitted: [], starter: [], requiredFiles: [], requiredSymbols: [] }),
    ).toBeNull();
  });
});
