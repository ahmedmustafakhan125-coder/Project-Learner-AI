import type { Profile } from './types.js';

/**
 * Compilers and interpreters (docs/project-learner.md §6).
 *
 * Verified by a golden corpus of programs and their expected output, which
 * starts at step 1 and grows with every step. An interpreter in stdlib Python
 * or plain JavaScript runs entirely in the browser sandbox.
 */

export const languageTooling: Profile = {
  id: 'language-tooling',
  label: 'Compiler or interpreter',
  deep: true,
  signalWords: [
    'interpreter',
    'compiler',
    'programming language',
    'language',
    'lox',
    'lisp',
    'scheme',
    'parser',
    'lexer',
    'tokenizer',
    'bytecode',
    'virtual machine',
    'vm',
    'repl',
    'language server',
    'crafting interpreters',
    'transpiler',
    'llvm',
    'codegen',
  ],
  layers: [
    {
      id: 'host-language',
      label: 'Implementation language',
      section: 'Foundation',
      description: 'The language the interpreter or compiler itself is written in.',
      research: 'python',
    },
    { id: 'lexer', label: 'Lexer', section: 'Front end', description: 'Turns source text into tokens.', research: 'lox' },
    {
      id: 'parser',
      label: 'Parser',
      section: 'Front end',
      description: 'Turns tokens into a tree: recursive descent, Pratt or a generator such as ANTLR.',
      research: 'lox',
    },
    { id: 'ast', label: 'AST', section: 'Front end', description: 'The tree the parser builds and later stages walk.', research: 'lox' },
    {
      id: 'semantic-analysis',
      label: 'Semantic analysis',
      section: 'Middle',
      description: 'Scopes, name resolution and type checking.',
      research: 'lox',
    },
    { id: 'ir', label: 'IR', section: 'Middle', description: 'An intermediate representation between the tree and the target.', research: 'lox' },
    { id: 'optimiser', label: 'Optimiser', section: 'Middle', description: 'Passes that make the IR smaller or faster.', research: 'lox' },
    {
      id: 'backend',
      label: 'Backend',
      section: 'Back end',
      description: 'What runs the program: a tree-walking evaluator, a bytecode VM, or code generation for a target.',
      research: 'lox',
    },
    { id: 'runtime-gc', label: 'Runtime and GC', section: 'Back end', description: 'Values, memory and garbage collection at run time.', research: 'lox' },
    { id: 'driver', label: 'Driver', section: 'Tools', description: 'The command that reads a file and runs or compiles it.', research: 'lox' },
    { id: 'repl', label: 'REPL', section: 'Tools', description: 'An interactive prompt that runs one line at a time.', research: 'lox' },
    {
      id: 'error-reporting',
      label: 'Error reporting',
      section: 'Tools',
      description: 'Messages that point at the line and say what went wrong.',
      research: 'lox',
    },
    {
      id: 'test-corpus',
      label: 'Test corpus',
      section: 'Tools',
      description: 'Programs with expected output and exit codes, run by every step.',
      research: 'lox',
    },
  ],
  requiredLayersByTier: {
    T1: ['host-language', 'parser'],
    // §5: T2 is 2 to 4 layers. The lexer is covered with the parser until T3.
    T2: ['host-language', 'parser', 'backend', 'test-corpus'],
    T3: ['host-language', 'lexer', 'parser', 'ast', 'backend', 'error-reporting', 'repl', 'test-corpus'],
    T4: [
      'host-language', 'lexer', 'parser', 'ast', 'semantic-analysis', 'ir', 'backend', 'runtime-gc',
      'error-reporting', 'test-corpus',
    ],
    T5: [
      'host-language', 'lexer', 'parser', 'ast', 'semantic-analysis', 'ir', 'optimiser', 'backend',
      'runtime-gc', 'driver', 'error-reporting', 'test-corpus',
    ],
  },
  slots: [
    {
      key: 'source_language',
      label: 'Source language',
      description: 'The language being implemented: Lox, a Lisp, a C subset or their own design.',
      weight: 2,
      required: true,
      suggestedOptions: ['Lox', 'A Lisp', 'A C subset', 'My own language'],
    },
    {
      key: 'impl_language',
      label: 'Written in',
      description: 'The language the interpreter or compiler is written in.',
      weight: 2,
      required: true,
      suggestedOptions: ['Python', 'JavaScript', 'Rust', 'C', 'Go'],
    },
    {
      key: 'lang_target',
      label: 'Target',
      description: 'What it produces: a tree-walking interpreter, a bytecode VM, WebAssembly, C, assembly or LLVM IR.',
      weight: 1,
      required: false,
      suggestedOptions: ['Tree-walking interpreter', 'Bytecode VM', 'WebAssembly', 'Native code'],
    },
    {
      key: 'lang_features',
      label: 'Features',
      description: 'Language features to support: functions, closures, classes, GC, static types.',
      weight: 1,
      required: false,
      minTier: 'T3',
    },
  ],
  tierFloors: [
    { goal: 'A tree-walking interpreter', tier: 'T2', keywords: [] },
    {
      goal: 'A bytecode VM or a compiler',
      tier: 'T4',
      keywords: ['bytecode', 'vm', 'virtual machine', 'garbage collector', 'gc', 'compiler', 'type checker'],
    },
    {
      goal: 'Native code generation',
      tier: 'T5',
      keywords: ['native code', 'x86', 'x86-64', 'assembly', 'llvm', 'codegen', 'code generation', 'register allocation', 'cranelift', 'qbe'],
    },
  ],
  architectureRule: {
    description:
      'tests/programs/ holds source files with expected stdout and exit codes from step 1. Each step adds ' +
      'programs, including ones that must fail with a specific error message.',
    requiredPaths: ['tests/programs/**'],
    firstStepCreates: ['tests/programs/**'],
    everyStepEdits: ['tests/programs/**'],
    forbiddenImports: [],
  },
  harnesses: ['exec-golden', 'unit'],
  browserRunnable: (brief) => {
    const host = brief.layers.find((l) => l.layer === 'host-language');
    const name = (host?.name ?? '').toLowerCase();
    return /\bpython\b|\bjavascript\b|\bjs\b/.test(name);
  },
  toolchain: [
    {
      tool: 'python3',
      minVersion: null,
      installHint: { linux: 'sudo apt install python3', macos: 'brew install python', windows: 'winget install Python.Python.3.12' },
    },
  ],
  docSources: [{ key: 'base' }, { key: 'profile:language-tooling' }],
  prerequisites: [
    'Recursion',
    'Classes or structs and enums in the implementation language',
    'Reading and writing files',
    'Writing small tests',
  ],
  promptAddendum: `<profile_rules profile="language-tooling">
This is a compiler or interpreter. Rules that hold for every stage:
- tests/programs/ exists from step 1: source files with their expected stdout and exit code.
- Every step adds programs to that corpus, including at least one that must fail with a specific error message.
- An interpreter written in stdlib Python or plain JavaScript runs in the browser; native targets need the command line.
- Books such as Crafting Interpreters are linked and paraphrased, never copied.
</profile_rules>`,
};
