/**
 * The web checkpoint sandbox, proven by execution.
 *
 * `sandbox-escape.test.ts` checks that this document is *spelled* right. This
 * file checks that a browser actually runs a submission in it, which is a
 * different claim and the one that was silently false.
 *
 * What was broken, and why nothing reported it:
 *
 *   - Learner code ran as `new Function(code)` and each test as its own
 *     `new Function(t.code)`. Separate scopes: every `const`, `let`, `class`,
 *     `function` and `var` died with the call, so no test could name the symbol
 *     it existed to check. Every `runtime: "web"` test failed on correct work.
 *   - No DOM was ever built, so `document.getElementById('todo-list')` was null
 *     and the first `.addEventListener` threw, aborting the run before a single
 *     test executed.
 *   - Only `/\.(js|mjs)$/` files were executed, so a page whose script sat
 *     inside `index.html` ran nothing at all.
 *
 * Each test below fails against that version and passes against this one.
 *
 * Unlike the containment suite this needs no production build: the sandbox
 * document is a pure function of the protocol module, so it is served here
 * directly — with its real CSP, because 'unsafe-inline' is what permits the
 * injected <script> elements and a policy change would otherwise break
 * execution silently.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';

import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSandboxHTML } from '../lib/sandbox-protocol';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs shared with next.config.mjs, which cannot import TS.
import { sandboxCsp } from '../lib/csp.mjs';

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser(): string {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chrome or Edge found. Looked in:\n' + BROWSER_CANDIDATES.join('\n'));
  }
  return found;
}

/**
 * The parent page: an iframe with the same attributes the real SandboxFrame
 * uses, plus a promise the test awaits for the verdict.
 */
const HOST_PAGE = `<!DOCTYPE html><html><body><script>
  window.__run = function (payload) {
    return new Promise(function (resolve) {
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = '/sandbox';
      var messages = [];
      window.addEventListener('message', function onMsg(ev) {
        if (ev.source !== frame.contentWindow) return;
        messages.push(ev.data);
        if (ev.data && ev.data.type === 'ready') {
          frame.contentWindow.postMessage(payload, '*');
          return;
        }
        if (ev.data && (ev.data.type === 'result' || ev.data.type === 'error')) {
          window.removeEventListener('message', onMsg);
          resolve({ final: ev.data, messages: messages });
        }
      });
      document.body.appendChild(frame);
    });
  };

  /* Two runs down ONE frame, which is what the component used to do. Exists to
     demonstrate the collision that forces a remount between web runs. */
  window.__runTwice = function (payload) {
    return new Promise(function (resolve) {
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = '/sandbox';
      var seen = 0;
      var finals = [];
      window.addEventListener('message', function onMsg(ev) {
        if (ev.source !== frame.contentWindow) return;
        if (ev.data && ev.data.type === 'ready') {
          frame.contentWindow.postMessage(payload, '*');
          return;
        }
        if (ev.data && (ev.data.type === 'result' || ev.data.type === 'error')) {
          finals.push(ev.data);
          seen++;
          if (seen === 1) {
            frame.contentWindow.postMessage(payload, '*');
          } else {
            window.removeEventListener('message', onMsg);
            resolve(finals);
          }
        }
      });
      document.body.appendChild(frame);
    });
  };
</script></body></html>`;

interface SandboxVerdict {
  final:
    | { type: 'result'; passed: boolean; results: Array<{ name: string; passed: boolean; message: string }> }
    | { type: 'error'; message: string };
  messages: Array<{ type: string }>;
}

let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/sandbox')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': sandboxCsp(origin),
        'Cache-Control': 'no-store',
      });
      res.end(createSandboxHTML('web'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HOST_PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await chromium.launch({ executablePath: findBrowser() });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** Runs one submission through a real sandbox frame and returns its verdict. */
async function run(
  files: Array<{ path: string; contents: string }>,
  tests: Array<{ name: string; code: string; failureMessage: string }>,
): Promise<SandboxVerdict> {
  const page = await browser.newPage();
  try {
    await page.goto(origin, { waitUntil: 'load' });
    return (await page.evaluate(
      (payload) => (window as unknown as { __run: (p: unknown) => Promise<SandboxVerdict> }).__run(payload),
      { type: 'exec-web', files, tests },
    )) as SandboxVerdict;
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ *
 * A todo list, which is the shape that exposed all of this.
 * ------------------------------------------------------------------ */

const TODO_HTML = `<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="styles.css"></head>
<body>
  <form id="todo-form"><input id="todo-input"><button type="submit">Add</button></form>
  <ul id="todo-list"></ul>
  <script src="app.js"></script>
</body>
</html>`;

const TODO_JS = `const todos = [];

function addTodo(text) {
  todos.push({ text: text, done: false });
  render();
  return todos;
}

function render() {
  const list = document.getElementById('todo-list');
  list.innerHTML = '';
  for (const todo of todos) {
    const li = document.createElement('li');
    li.className = 'todo';
    li.textContent = todo.text;
    list.appendChild(li);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('todo-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    const input = document.getElementById('todo-input');
    if (input.value.trim()) addTodo(input.value.trim());
    input.value = '';
  });
});`;

const TODO_FILES = [
  { path: 'index.html', contents: TODO_HTML },
  { path: 'styles.css', contents: '.todo { color: rgb(255, 0, 0); }' },
  { path: 'app.js', contents: TODO_JS },
];

describe('web sandbox execution', () => {
  it('gives tests the symbols the learner declared', async () => {
    // The exact failure of the old harness: `addTodo` was declared in a
    // `new Function` scope that had already returned.
    const verdict = await run(TODO_FILES, [
      {
        name: 'addTodo exists',
        code: `if (typeof addTodo !== 'function') throw new Error('addTodo is not defined');`,
        failureMessage: 'addTodo was not found',
      },
      {
        name: 'addTodo appends to todos',
        code: `addTodo('buy milk'); if (todos.length !== 1) throw new Error('todos not updated');`,
        failureMessage: 'todos was not updated',
      },
    ]);

    expect(verdict.final).toMatchObject({ type: 'result', passed: true });
  });

  it('gives tests a real DOM built from the submission', async () => {
    const verdict = await run(TODO_FILES, [
      {
        name: 'the list element exists',
        code: `if (!document.getElementById('todo-list')) throw new Error('no #todo-list');`,
        failureMessage: 'index.html has no #todo-list',
      },
      {
        name: 'rendering adds list items',
        code: `addTodo('write tests');
               const items = document.querySelectorAll('#todo-list .todo');
               if (items.length !== 1) throw new Error('expected 1 item, got ' + items.length);
               if (items[0].textContent !== 'write tests') throw new Error('wrong text');`,
        failureMessage: 'the todo was not rendered into the list',
      },
    ]);

    expect(verdict.final).toMatchObject({ type: 'result', passed: true });
  });

  it('fires DOMContentLoaded so listeners registered on it are wired up', async () => {
    // Scripts are injected long after the document's own DOMContentLoaded, so
    // without a synthetic one the submit handler above is never attached and
    // the form silently does nothing.
    const verdict = await run(TODO_FILES, [
      {
        name: 'submitting the form adds a todo',
        code: `const input = document.getElementById('todo-input');
               input.value = 'from the form';
               document.getElementById('todo-form')
                 .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
               if (todos.length !== 1) throw new Error('submit handler never ran');`,
        failureMessage: 'the form submit handler was not wired up',
      },
    ]);

    expect(verdict.final).toMatchObject({ type: 'result', passed: true });
  });

  it('inlines linked stylesheets so styling can be asserted', async () => {
    const verdict = await run(TODO_FILES, [
      {
        name: 'the todo class is styled',
        code: `addTodo('x');
               const li = document.querySelector('#todo-list .todo');
               const colour = getComputedStyle(li).color;
               if (colour !== 'rgb(255, 0, 0)') throw new Error('got ' + colour);`,
        failureMessage: 'styles.css was not applied',
      },
    ]);

    expect(verdict.final).toMatchObject({ type: 'result', passed: true });
  });

  it('executes a script written inline in the page', async () => {
    // The old filter was on the file path, so a project with its JS inside the
    // HTML executed nothing and every test failed with its failureMessage.
    const verdict = await run(
      [
        {
          path: 'index.html',
          contents: `<!DOCTYPE html><html><body><div id="out"></div>
            <script>
              const greeting = 'hello';
              function greet() { document.getElementById('out').textContent = greeting; }
              greet();
            </script></body></html>`,
        },
      ],
      [
        {
          name: 'the inline script ran',
          code: `if (document.getElementById('out').textContent !== 'hello') {
                   throw new Error('inline script did not run');
                 }
                 if (typeof greet !== 'function') throw new Error('greet not in scope');`,
          failureMessage: 'the inline script did not run',
        },
      ],
    );

    expect(verdict.final).toMatchObject({ type: 'result', passed: true });
  });

  /* ---------------- the checks must also be able to fail ---------------- */

  it('fails a submission that does not do the work', async () => {
    // Without this the tests above prove nothing: a sandbox that passed
    // everything unconditionally would satisfy all of them.
    const verdict = await run(
      [
        { path: 'index.html', contents: TODO_HTML },
        { path: 'styles.css', contents: '' },
        { path: 'app.js', contents: 'const todos = [];\nfunction addTodo(text) { /* TODO */ }' },
      ],
      [
        {
          name: 'addTodo appends to todos',
          code: `addTodo('buy milk'); if (todos.length !== 1) throw new Error('todos not updated');`,
          failureMessage: 'addTodo did not add anything to todos',
        },
      ],
    );

    expect(verdict.final).toMatchObject({ type: 'result', passed: false });
    if (verdict.final.type === 'result') {
      expect(verdict.final.results[0]?.message).toBe('addTodo did not add anything to todos');
    }
  });

  it('attributes a runtime error to the file that threw it', async () => {
    const verdict = await run(
      [
        { path: 'index.html', contents: '<!DOCTYPE html><html><body></body></html>' },
        { path: 'app.js', contents: 'document.getElementById("missing").addEventListener("x", null);' },
      ],
      [{ name: 'never reached', code: '', failureMessage: '' }],
    );

    expect(verdict.final.type).toBe('error');
    if (verdict.final.type === 'error') {
      expect(verdict.final.message).toContain('app.js');
    }
  });

  it('reports module syntax as unsupported rather than as the learner’s bug', async () => {
    const verdict = await run(
      [{ path: 'app.js', contents: `import { helper } from './helper.js';\nhelper();` }],
      [{ name: 'never reached', code: '', failureMessage: '' }],
    );

    expect(verdict.final.type).toBe('error');
    if (verdict.final.type === 'error') {
      expect(verdict.final.message).toContain('ES module syntax');
    }
  });

  it('names a script the page asks for but the submission does not contain', async () => {
    const verdict = await run(
      [
        {
          path: 'index.html',
          contents: '<!DOCTYPE html><html><body><script src="https://cdn.example.com/x.js"></script></body></html>',
        },
      ],
      [{ name: 'never reached', code: '', failureMessage: '' }],
    );

    expect(verdict.final.type).toBe('error');
    if (verdict.final.type === 'error') {
      expect(verdict.final.message).toContain('cdn.example.com');
    }
  });

  /**
   * Why SandboxFrame replaces the web frame between runs.
   *
   * Learner scripts are real <script> elements, so their top-level `const`
   * lands in the frame's global lexical scope and stays there. A second run in
   * the same document redeclares it, and the learner is told their own file is
   * broken on the attempt after the one that passed.
   *
   * This asserts the collision is real. The fix is in SandboxFrame, which
   * bumps its `generation` key on every web run; if someone removes that, this
   * test still passes but `repeated runs` below starts failing.
   */
  it('collides on a second run down the same frame', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin, { waitUntil: 'load' });
      const finals = (await page.evaluate(
        (payload) =>
          (window as unknown as { __runTwice: (p: unknown) => Promise<Array<{ type: string; message?: string }>> })
            .__runTwice(payload),
        {
          type: 'exec-web',
          files: TODO_FILES,
          tests: [{ name: 'ok', code: 'if (typeof addTodo !== "function") throw new Error("x");', failureMessage: 'no' }],
        },
      )) as Array<{ type: string; message?: string }>;

      expect(finals[0]).toMatchObject({ type: 'result' });
      expect(finals[1]?.type).toBe('error');
      expect(finals[1]?.message).toMatch(/already been declared/i);
    } finally {
      await page.close();
    }
  });

  it('repeated runs each get a clean document', async () => {
    // The behaviour the remount buys: the same submission, run twice, passes
    // twice. This is what a learner does every time they fix one thing and
    // press the button again.
    const tests = [
      {
        name: 'addTodo appends to todos',
        code: `addTodo('buy milk'); if (todos.length !== 1) throw new Error('todos not updated');`,
        failureMessage: 'todos was not updated',
      },
    ];
    const first = await run(TODO_FILES, tests);
    const second = await run(TODO_FILES, tests);

    expect(first.final).toMatchObject({ type: 'result', passed: true });
    expect(second.final).toMatchObject({ type: 'result', passed: true });
  });
});
