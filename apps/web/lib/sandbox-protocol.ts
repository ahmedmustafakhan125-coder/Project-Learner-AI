/* ------------------------------------------------------------------ */
/*  PostMessage protocol between parent page and sandbox iframe        */
/* ------------------------------------------------------------------ */

/** Messages sent INTO the sandbox */
export type SandboxInMessage =
  | {
      type: 'exec-web';
      code: string;
      tests: Array<{ name: string; code: string; failureMessage: string }>;
    }
  | {
      type: 'exec-python';
      code: string;
      tests: Array<{ name: string; code: string; failureMessage: string }>;
    };

/** Messages received FROM the sandbox */
export type SandboxOutMessage =
  | { type: 'ready' }
  | { type: 'progress'; message: string }
  | {
      type: 'result';
      passed: boolean;
      results: Array<{ name: string; passed: boolean; message: string }>;
    }
  | { type: 'error'; message: string };

/** Hard ceiling for any sandbox execution before we kill the frame. */
export const SANDBOX_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/*  Sandbox HTML generators                                           */
/* ------------------------------------------------------------------ */

/*
 * These documents are served by app/sandbox/route.ts, NOT inlined as a srcdoc
 * attribute. A srcdoc frame inherits the parent's CSP, and the app policy has
 * no 'unsafe-inline', so the bootstrap script below is refused and the frame
 * silently never reports ready. Serving over http gives the document its own
 * policy. Containment is unchanged: the opaque origin comes from the iframe's
 * `sandbox="allow-scripts"`, not from how the document was delivered.
 */

function webSandboxHTML(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script>
(function () {
  "use strict";

  function post(msg) {
    parent.postMessage(msg, '*');
  }

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || data.type !== 'exec-web') return;

    var code  = data.code;
    var tests = data.tests || [];

    /* ---- run learner code ---- */
    try {
      var fn = new Function(code);
      fn();
    } catch (e) {
      post({ type: 'error', message: 'Learner code error: ' + (e.message || e) });
      return;
    }

    /* ---- run each test ---- */
    var results = [];
    var allPassed = true;

    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      post({ type: 'progress', message: 'Running: ' + t.name });
      try {
        var testFn = new Function(t.code);
        testFn();
        results.push({ name: t.name, passed: true, message: 'OK' });
      } catch (e) {
        allPassed = false;
        results.push({
          name: t.name,
          passed: false,
          message: t.failureMessage || e.message || String(e)
        });
      }
    }

    post({ type: 'result', passed: allPassed, results: results });
  });

  post({ type: 'ready' });
})();
<\/script>
</body>
</html>`;
}

function pythonSandboxHTML(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script src="/pyodide/pyodide.js"><\/script>
<script>
(function () {
  "use strict";

  function post(msg) {
    parent.postMessage(msg, '*');
  }

  post({ type: 'progress', message: 'Loading Python runtime\\u2026' });

  loadPyodide({ indexURL: '/pyodide/' }).then(function (pyodide) {
    post({ type: 'progress', message: 'Python ready' });

    window.addEventListener('message', function (ev) {
      var data = ev.data;
      if (!data || data.type !== 'exec-python') return;

      var code  = data.code;
      var tests = data.tests || [];

      /* ---- run learner code ---- */
      try {
        pyodide.runPython(code);
      } catch (e) {
        post({ type: 'error', message: 'Learner code error: ' + (e.message || e) });
        return;
      }

      /* ---- run each test ---- */
      var results = [];
      var allPassed = true;

      for (var i = 0; i < tests.length; i++) {
        var t = tests[i];
        post({ type: 'progress', message: 'Running: ' + t.name });
        try {
          pyodide.runPython(t.code);
          results.push({ name: t.name, passed: true, message: 'OK' });
        } catch (e) {
          allPassed = false;
          results.push({
            name: t.name,
            passed: false,
            message: t.failureMessage || e.message || String(e)
          });
        }
      }

      post({ type: 'result', passed: allPassed, results: results });
    });

    post({ type: 'ready' });
  }).catch(function (err) {
    post({ type: 'error', message: 'Failed to load Pyodide: ' + (err.message || err) });
  });
})();
<\/script>
</body>
</html>`;
}

/**
 * Returns the full HTML string for a sandbox iframe.
 *
 * @param runtime  `'web'` for vanilla JS execution, `'python'` for Pyodide.
 */
export function createSandboxHTML(runtime: 'web' | 'python'): string {
  return runtime === 'python' ? pythonSandboxHTML() : webSandboxHTML();
}
