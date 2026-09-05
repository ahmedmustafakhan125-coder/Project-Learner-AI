import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '@ai-edu/llm';

import { expandStep } from '../src/generation/expand.js';
import type { ProjectBlueprint } from '../src/schemas/project.js';
import type { ExpandedStep, SourceFile } from '../src/schemas/step.js';
import type { Violation } from '../src/generation/verifyExpansion.js';
import type { InstructionIssue } from '../src/generation/verifyInstructions.js';

/**
 * What `expandStep` does when a step comes back not matching its file plan.
 *
 * The policy is: repair always, re-ask once but only for damage a repair
 * cannot honestly undo. Both halves are worth pinning. Retrying on everything
 * doubles the cost of generating a project for no benefit — a stray file is
 * dropped correctly either way — and retrying on nothing means a hole in the
 * project is papered over with a stub the learner never wrote.
 *
 * The provider is scripted rather than mocked loosely, so each test states
 * exactly what the model returned on each call.
 */

const CAPS: LLMProvider['capabilities'] = {
  explicitCaching: true,
  structuredOutput: 'native-schema',
  midConversationSystem: true,
  reasoningControl: 'effort',
  maxContext: 1_000_000,
  maxOutputTokens: 128_000,
  supportsFileUpload: true,
  supportsImages: true,
};

const PRIOR_APP_JS = `const todos = [];

function addTodo(text) {
  todos.push({ text: text, done: false });
  renderTodoList();
}

function renderTodoList() {
  const list = document.getElementById('todo-list');
  list.innerHTML = '';
}`;

const PRIOR_FILES: SourceFile[] = [{ path: 'app.js', contents: PRIOR_APP_JS }];

const BLUEPRINT: ProjectBlueprint = {
  title: 'Todo list',
  summary: 'A todo list.',
  learningObjectives: ['persist state'],
  techStack: [{ name: 'JavaScript', role: 'everything', why: 'no build step' }],
  prerequisites: [],
  estimatedHours: 2,
  finalFileTree: [
    { path: 'app.js', purpose: 'the app' },
    { path: 'storage.js', purpose: 'persistence helpers' },
  ],
  deployment: { target: 'local', rationale: 'runs in a browser', artifacts: [], taught: false },
  steps: [
    {
      title: 'Render todos',
      objective: 'show a list',
      concepts: [],
      estMinutes: 45,
      creates: ['app.js'],
      edits: [],
    },
    {
      title: 'Persist todos',
      objective: 'survive a reload',
      concepts: [],
      estMinutes: 45,
      creates: ['storage.js'],
      edits: ['app.js'],
    },
  ],
};

/**
 * Instructions as the prompt now asks for them.
 *
 * Realistic on purpose: the fixture used to be the single line "Add
 * persistence.", which the instruction checks correctly refuse as too thin to
 * work from. A fixture that could not pass the bar it is testing against would
 * have made every case below look like a retry.
 */
const GOOD_INSTRUCTIONS = `### What you're building

Todos that survive a reload, instead of vanishing every time the page refreshes.

### Your tasks

1. **storage.js** - export \`save(todos)\`. It takes the todos array and returns
   nothing. Serialise with \`JSON.stringify\` and write it to \`localStorage\`
   under the key \`todos\`.
2. **app.js** - call \`save(todos)\` as the last line of \`addTodo\`, after the
   list has been re-rendered.

### Done when

You add a todo, reload the page, and it is still in the list.`;

function baseStep(overrides: Partial<ExpandedStep> = {}): ExpandedStep {
  return {
    instructionsMd: GOOD_INSTRUCTIONS,
    explanationMd: 'localStorage is synchronous.',
    alternatives: [],
    hints: [],
    checkpoint: { requiredFiles: [], requiredSymbols: [], tests: [], runtime: 'web' },
    starterFiles: [
      { path: 'storage.js', contents: '// TODO: export save()\n' },
      { path: 'app.js', contents: `${PRIOR_APP_JS}\n\nfunction persist() {\n  // TODO\n}` },
    ],
    solutionFiles: [
      { path: 'storage.js', contents: 'export function save(t) { localStorage.setItem("t", t); }' },
      { path: 'app.js', contents: `${PRIOR_APP_JS}\n\nfunction persist() { save(todos); }` },
    ],
    ...overrides,
  };
}

/**
 * A provider that returns each scripted answer in turn.
 *
 * Records the request it was given each time, so a test can assert that the
 * retry actually told the model what was wrong rather than just asking again.
 */
function scripted(answers: ExpandedStep[]) {
  const requests: Array<{ text: string }> = [];
  let call = 0;

  const provider = {
    id: 'anthropic',
    modelId: 'claude-opus-5',
    capabilities: CAPS,
    async structured(request: { messages: Array<{ content: Array<{ text: string }> }> }) {
      const text = request.messages
        .flatMap((message) => message.content.map((part) => part.text))
        .join('\n');
      requests.push({ text });

      const answer = answers[Math.min(call, answers.length - 1)]!;
      call += 1;
      return { data: answer };
    },
  } as unknown as LLMProvider;

  return { provider, requests, callCount: () => call };
}

async function expand(answers: ExpandedStep[]) {
  const { provider, requests, callCount } = scripted(answers);
  const seen: Array<{ violations: Violation[]; willRetry: boolean }> = [];
  const prose: Array<{ issues: InstructionIssue[]; willRetry: boolean }> = [];

  const step = await expandStep({
    provider,
    blueprint: BLUEPRINT,
    stepIndex: 1,
    priorFiles: PRIOR_FILES,
    onViolations: (violations, willRetry) => seen.push({ violations, willRetry }),
    onInstructionIssues: (issues, willRetry) => prose.push({ issues, willRetry }),
  });

  return { step, requests, calls: callCount(), seen, prose };
}

/* ------------------------------------------------------------------ */

describe('a step that honours its manifest', () => {
  it('costs exactly one generation', async () => {
    const { calls, seen } = await expand([baseStep()]);
    expect(calls).toBe(1);
    expect(seen).toEqual([]);
  });

  it('is returned unchanged', async () => {
    const original = baseStep();
    const { step } = await expand([original]);
    expect(step.starterFiles).toEqual(original.starterFiles);
    expect(step.solutionFiles).toEqual(original.solutionFiles);
  });
});

describe('a step that leaves a hole in the project', () => {
  it('is generated a second time', async () => {
    // storage.js missing from solutionFiles: every later step would inherit
    // a project without it.
    const broken = baseStep({
      solutionFiles: [{ path: 'app.js', contents: PRIOR_APP_JS }],
    });
    const { calls } = await expand([broken, baseStep()]);
    expect(calls).toBe(2);
  });

  it('tells the model exactly what was missing', async () => {
    // "Try again" produces another guess; naming the file produces the file.
    const broken = baseStep({
      solutionFiles: [{ path: 'app.js', contents: PRIOR_APP_JS }],
    });
    const { requests } = await expand([broken, baseStep()]);

    expect(requests).toHaveLength(2);
    expect(requests[1]!.text).toContain('storage.js');
    expect(requests[1]!.text).toContain('solutionFiles');
    expect(requests[0]!.text).not.toContain('expansion_rejected');
  });

  it('reports the retry, so a prompt regression is visible', async () => {
    const broken = baseStep({
      solutionFiles: [{ path: 'app.js', contents: PRIOR_APP_JS }],
    });
    const { seen } = await expand([broken, baseStep()]);

    expect(seen[0]!.willRetry).toBe(true);
    expect(seen[0]!.violations.map((v) => v.code)).toContain('missing_from_solution');
  });

  it('keeps the better answer when the retry fixes it', async () => {
    const broken = baseStep({
      solutionFiles: [{ path: 'app.js', contents: PRIOR_APP_JS }],
    });
    const { step } = await expand([broken, baseStep()]);

    const storage = step.solutionFiles.find((f) => f.path === 'storage.js');
    expect(storage!.contents).toContain('localStorage');
  });

  it('keeps the FIRST answer when the retry comes back worse', async () => {
    // A retry is not automatically an improvement, and adopting a worse one
    // would make the second call actively harmful.
    const slightlyBroken = baseStep({
      solutionFiles: [
        { path: 'storage.js', contents: '' },
        { path: 'app.js', contents: PRIOR_APP_JS },
      ],
    });
    const muchWorse = baseStep({ starterFiles: [], solutionFiles: [] });

    const { step } = await expand([slightlyBroken, muchWorse]);
    // The first answer's starter files survived; the retry's empty set did not.
    expect(step.starterFiles.map((f) => f.path).sort()).toEqual(['app.js', 'storage.js']);
  });
});

describe('a step whose instructions the learner cannot work from', () => {
  it('is generated a second time', async () => {
    // Instructions are the one part of a step the learner actually reads, and
    // unlike a missing file they cannot be repaired afterwards - prose can
    // only be re-asked for.
    const vague = baseStep({ instructionsMd: 'Add persistence to the app.' });
    const { calls } = await expand([vague, baseStep()]);
    expect(calls).toBe(2);
  });

  it('is generated again when it grades on a symbol it never named', () => {
    // The trap this closes: the learner reads "write a function that saves the
    // todos" while the grader greps for the literal string `persistTodos`.
    const mismatched = baseStep({
      checkpoint: {
        requiredFiles: [],
        requiredSymbols: ['persistTodos'],
        tests: [],
        runtime: 'web',
      },
    });
    return expand([mismatched, baseStep()]).then(({ calls, prose }) => {
      expect(calls).toBe(2);
      expect(prose[0]!.issues.map((i) => i.code)).toContain('ungraded_symbol');
      expect(prose[0]!.willRetry).toBe(true);
    });
  });

  it('tells the model which symbol was missing', async () => {
    const mismatched = baseStep({
      checkpoint: {
        requiredFiles: [],
        requiredSymbols: ['persistTodos'],
        tests: [],
        runtime: 'web',
      },
    });
    const { requests } = await expand([mismatched, baseStep()]);
    expect(requests[1]!.text).toContain('persistTodos');
  });

  it('ships the step anyway when the retry is no better', async () => {
    /*
     * Prose cannot be repaired, so there has to be an end to it. A step with
     * weak instructions is still a step; blocking the learner on a second bad
     * roll would be worse than the instructions are.
     */
    const vague = baseStep({ instructionsMd: 'Add persistence to the app.' });
    const { step, calls, prose } = await expand([vague, vague]);

    expect(calls).toBe(2);
    expect(step.instructionsMd).toBe('Add persistence to the app.');
    // Reported a second time, with willRetry false, so what is logged is what
    // the learner actually got.
    expect(prose.at(-1)!.willRetry).toBe(false);
  });

  it('costs nothing extra when the instructions are only shapeless', async () => {
    // Missing headings are cosmetic: prose can carry a task list and a finish
    // line without them, and re-asking over a heading is the waste the retry
    // policy exists to avoid.
    const shapeless = baseStep({
      // Long enough to clear the length floor and specific enough to name both
      // files - it simply has no headings and no numbered list.
      instructionsMd: (
        'Write save(todos) in storage.js so the array is written to localStorage, ' +
        'then call it from addTodo in app.js so the list survives a reload. '
      ).repeat(3),
    });
    const { calls } = await expand([shapeless]);
    expect(calls).toBe(1);
  });
});

describe('a step with only cosmetic problems', () => {
  it('is repaired without paying for a second generation', async () => {
    // A file outside the manifest is dropped, which is exactly right. Asking
    // again to be told the same thing is waste.
    const strayFile = baseStep({
      starterFiles: [
        ...baseStep().starterFiles,
        { path: 'index.html', contents: '<html>not this step</html>' },
      ],
    });

    const { step, calls, seen } = await expand([strayFile]);
    expect(calls).toBe(1);
    expect(seen[0]!.willRetry).toBe(false);
    expect(step.starterFiles.map((f) => f.path)).not.toContain('index.html');
  });
});

describe('the learner’s own code', () => {
  it('survives a step that rewrote the file it was told to edit', async () => {
    // The failure this matters most for. app.js already holds their passing
    // code; the model returns a tidy skeleton of it instead of carrying it
    // forward, and without the repair the editor opens on the skeleton.
    const rewritten = baseStep({
      starterFiles: [
        { path: 'storage.js', contents: '// TODO\n' },
        { path: 'app.js', contents: 'const todos = [];\n\nfunction addTodo(text) {\n  // TODO\n}' },
      ],
    });

    const { step } = await expand([rewritten, rewritten]);
    expect(step.starterFiles.find((f) => f.path === 'app.js')!.contents).toBe(PRIOR_APP_JS);
  });

  it('is preserved even when the retry also rewrites it', async () => {
    // Repair runs after the retry precisely because the retry can fail too.
    const rewritten = baseStep({
      starterFiles: [
        { path: 'storage.js', contents: '// TODO\n' },
        { path: 'app.js', contents: 'const todos = [];' },
      ],
    });

    const { step, calls } = await expand([rewritten, rewritten]);
    expect(calls).toBe(2);
    expect(step.starterFiles.find((f) => f.path === 'app.js')!.contents).toBe(PRIOR_APP_JS);
  });
});

describe('a retry that cannot be made', () => {
  it('falls back to repairing the first answer rather than failing the step', async () => {
    // A failed second call is not a reason to lose a repairable first one.
    let call = 0;
    const provider = {
      id: 'anthropic',
      modelId: 'claude-opus-5',
      capabilities: CAPS,
      async structured() {
        call += 1;
        if (call === 2) throw new Error('provider exploded');
        return { data: baseStep({ solutionFiles: [{ path: 'app.js', contents: PRIOR_APP_JS }] }) };
      },
    } as unknown as LLMProvider;

    const step = await expandStep({
      provider,
      blueprint: BLUEPRINT,
      stepIndex: 1,
      priorFiles: PRIOR_FILES,
    });

    expect(call).toBe(2);
    // Repaired: storage.js came back from the starter rather than being lost.
    const storage = step.solutionFiles.find((f) => f.path === 'storage.js');
    expect(storage).toBeDefined();
    expect(storage!.contents).toContain('TODO');
  });
});

describe('the manifest is always true by the time a step is stored', () => {
  it('holds however badly the model answered', async () => {
    // The property that actually matters. A step is persisted exactly once, so
    // whatever comes back, what gets stored must match the plan.
    const disasters: Array<Partial<ExpandedStep>> = [
      { starterFiles: [], solutionFiles: [] },
      { starterFiles: [{ path: 'wrong.js', contents: 'x' }], solutionFiles: [] },
      { solutionFiles: [{ path: 'storage.js', contents: '' }] },
      { starterFiles: [{ path: 'app.js', contents: '' }] },
    ];

    for (const overrides of disasters) {
      const { step } = await expand([baseStep(overrides), baseStep(overrides)]);
      const paths = step.starterFiles.map((f) => f.path).sort();

      expect(paths).toEqual(['app.js', 'storage.js']);
      expect(step.solutionFiles.map((f) => f.path).sort()).toEqual(['app.js', 'storage.js']);
      for (const file of step.solutionFiles) {
        expect(file.contents.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
