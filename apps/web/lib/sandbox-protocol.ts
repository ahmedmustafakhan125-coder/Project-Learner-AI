/* ------------------------------------------------------------------ */
/*  PostMessage protocol between parent page and sandbox iframe        */
/* ------------------------------------------------------------------ */

export interface SandboxFile {
  path: string;
  contents: string;
}

/**
 * Messages sent INTO the sandbox.
 *
 * The whole file set travels, not one concatenated blob. A project is files —
 * `requirements.txt` next to `main.py` — and joining them into a single string
 * fed to the interpreter makes the data files syntax errors in the source
 * language. The sandbox writes them out and runs only what is executable.
 */
export type SandboxInMessage =
  | {
      type: 'exec-web';
      files: SandboxFile[];
      tests: Array<{ name: string; code: string; failureMessage: string }>;
    }
  | {
      type: 'exec-python';
      files: SandboxFile[];
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

    var files = data.files || [];
    var tests = data.tests || [];

    /* ---- expose the whole project to the tests ----
       Markup, CSS and data files are not JavaScript and must not be evaluated
       as if they were. They are still part of the submission, so tests can read
       them here by path. */
    var byPath = {};
    for (var i = 0; i < files.length; i++) byPath[files[i].path] = files[i].contents;
    window.__files = byPath;

    var code = files
      .filter(function (f) { return /\\.(js|mjs)$/i.test(f.path); })
      .map(function (f) { return f.contents; })
      .join('\\n');

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

    for (var j = 0; j < tests.length; j++) {
      var t = tests[j];
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

/**
 * Loads the submission the way Python itself expects to find it.
 *
 * Each module is executed once, registered in `sys.modules`, and its names
 * copied into the run globals. That covers both shapes a checkpoint test can
 * take — `import main` and a bare call to a function the learner wrote — while
 * executing the file exactly once either way. Modules left over from a previous
 * attempt are evicted first, or a retry would silently re-test the old code.
 */
const PY_LOAD = `
import sys, types, importlib, os

os.chdir('/home/pyodide')
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')

importlib.invalidate_caches()
for _name, _mod in list(sys.modules.items()):
    _f = getattr(_mod, '__file__', None)
    if _f and _f.startswith('/home/pyodide'):
        del sys.modules[_name]

for _path in __checkpoint_sources:
    _name = _path.rsplit('/', 1)[-1][:-3]
    # An earlier module in this run may already have imported this one.
    if getattr(sys.modules.get(_name), '__file__', None) == _path:
        continue
    with open(_path, 'r') as _fh:
        _src = _fh.read()
    _mod = types.ModuleType(_name)
    _mod.__file__ = _path
    # Not '__main__': a module executed under its own name skips the
    # \`if __name__ == "__main__"\` block, which is a script entry point and not
    # something a checkpoint should trigger.
    exec(compile(_src, _path, 'exec'), _mod.__dict__)
    sys.modules[_name] = _mod
    globals().update({k: v for k, v in _mod.__dict__.items() if not k.startswith('__')})
`;

function pythonSandboxHTML(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script src="/pyodide/pyodide.js"><\/script>
<script>
(function () {
  "use strict";

  var PY_LOAD = ${JSON.stringify(PY_LOAD)};
  var ROOT = '/home/pyodide';
  var encoder = new TextEncoder();
  var written = [];

  function post(msg) {
    parent.postMessage(msg, '*');
  }

  function mkdirp(pyodide, dir) {
    var parts = dir.split('/').filter(Boolean);
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      try {
        pyodide.FS.mkdir(cur);
      } catch (e) {
        /* already there */
      }
    }
  }

  /* Writes the submission to the virtual filesystem, so a test can open a data
     file by name and import a module by name — exactly as it would on a real
     machine. Files from the previous attempt are removed first: a file the
     learner renamed must not linger and keep passing. */
  function materialise(pyodide, files) {
    for (var i = 0; i < written.length; i++) {
      try {
        pyodide.FS.unlink(written[i]);
      } catch (e) {
        /* already gone */
      }
    }
    written = [];

    var sources = [];
    for (var j = 0; j < files.length; j++) {
      var rel = String(files[j].path).replace(/^[./]+/, '');
      var full = ROOT + '/' + rel;
      var slash = full.lastIndexOf('/');
      if (slash > 0) mkdirp(pyodide, full.slice(0, slash));
      pyodide.FS.writeFile(full, encoder.encode(files[j].contents));
      written.push(full);
      if (/\\.py$/i.test(rel)) sources.push(full);
    }
    return sources;
  }

  post({ type: 'progress', message: 'Loading Python runtime\u2026' });

  loadPyodide({ indexURL: '/pyodide/' }).then(function (pyodide) {
    post({ type: 'progress', message: 'Python ready' });

    window.addEventListener('message', function (ev) {
      var data = ev.data;
      if (!data || data.type !== 'exec-python') return;

      var files = data.files || [];
      var tests = data.tests || [];

      /* ---- lay the project out on disk, then load its modules ---- */
      try {
        var sources = materialise(pyodide, files);
        pyodide.globals.set('__checkpoint_sources', sources);
        pyodide.runPython(PY_LOAD);
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
