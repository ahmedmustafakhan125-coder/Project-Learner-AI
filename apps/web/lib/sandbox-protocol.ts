/* ------------------------------------------------------------------ */
/*  PostMessage protocol between parent page and sandbox iframe        */
/* ------------------------------------------------------------------ */

/*
 * One definition of "the sandbox cannot run this", shared with generation.
 *
 * `groundCheckpoint` uses this to strip tests from a step whose files are ES
 * modules; the sandbox uses it to say so out loud if one reaches it anyway. Two
 * copies of the rule would drift, and the failure mode of drift here is a step
 * that keeps its tests and then cannot pass them.
 */
import { ES_MODULE_SYNTAX } from '@ai-edu/core';

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

/**
 * The web execution sandbox.
 *
 * This document builds a REAL page out of the submission before it runs a
 * single test, because the thing being verified is usually a page. The previous
 * version did neither half of that:
 *
 *   - It ran learner code as `new Function(code)` and each test as its own
 *     `new Function(test.code)`. Those are separate scopes, so every `const`,
 *     `let`, `class`, `function` and `var` the learner wrote died when the call
 *     returned. No test could ever see a symbol from the code it was testing.
 *
 *   - It never built a DOM. `document` existed — it was this frame's own empty
 *     document — so `document.getElementById('todo-list')` returned null and
 *     the first `.addEventListener` on it threw, aborting the whole checkpoint
 *     before any test ran.
 *
 *   - It executed only files matching `/\.(js|mjs)$/`, so a project whose
 *     script lived inside `index.html` executed nothing at all and every test
 *     failed with its own failureMessage.
 *
 * So the submission is mounted the way a browser would mount it: stylesheets
 * inlined, markup parsed into the document, scripts run in document order as
 * genuine <script> elements, then `DOMContentLoaded` and `load` fired. Tests
 * run afterwards by indirect eval at global scope, which is the scope those
 * scripts declared into — so `addTodo` is simply in scope, exactly as the
 * generation prompt has always promised it would be.
 *
 * Real <script> elements rather than eval, for three reasons: inline scripts
 * from the HTML then behave as they do on a real page, top-level declarations
 * land in the global scope the tests read, and an uncaught error arrives at
 * `window.onerror` already attributed to the file that threw it.
 *
 * Nothing here loosens containment. The frame's opaque origin comes from
 * `sandbox="allow-scripts"` on the iframe, and its network reach from the
 * sandbox CSP; building a DOM inside it touches neither. The document is
 * discarded and rebuilt for every run — see SandboxFrame, which remounts the
 * web frame each time, because a global `const` from one run would otherwise
 * collide with the next and report "already declared" as if the learner had
 * written it twice.
 */
function webSandboxHTML(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>
(function () {
  "use strict";

  var MODULE_SYNTAX = ${ES_MODULE_SYNTAX.toString()};

  function post(msg) {
    parent.postMessage(msg, '*');
  }

  /* A classic script that throws does NOT throw at the append site — execution
     is synchronous but the error surfaces on window.onerror. Recording it there
     is the only way to say which file failed. */
  var lastError = null;
  window.addEventListener('error', function (ev) {
    lastError = ev.message || String((ev.error && ev.error.message) || ev.error || 'error');
  });

  /** Path as the submission stores it: "./app.js" and "/app.js" are "app.js". */
  function normalise(path) {
    return String(path || '').replace(/^[.\\/]+/, '').split('?')[0].split('#')[0];
  }

  /* Runs one script the way the page would, and returns an error string or
     null. Appended to <head> so it cannot disturb the body the learner's own
     markup owns. */
  function runScript(source, label) {
    if (MODULE_SYNTAX.test(source)) {
      return label + ': this file uses ES module syntax (import/export), which the ' +
        'checkpoint sandbox cannot load. Use a classic script.';
    }
    lastError = null;
    var el = document.createElement('script');
    el.textContent = source;
    document.head.appendChild(el);
    if (el.parentNode) el.parentNode.removeChild(el);
    return lastError ? label + ': ' + lastError : null;
  }

  /**
   * Lays the submission out as a page.
   *
   * Returns the scripts to run, in the order the document asks for them, with
   * markup and styles already in place. Scripts are NOT run here: everything
   * the DOM needs must exist before the first one executes, exactly as it does
   * when a browser parses the file top to bottom.
   */
  function mount(byPath) {
    var htmlPath = null;
    for (var path in byPath) {
      if (!/\\.html?$/i.test(path)) continue;
      // index.html is the entry point wherever it sorts.
      if (htmlPath === null || /(^|\\/)index\\.html?$/i.test(path)) htmlPath = path;
    }

    document.body.innerHTML = '';
    var scripts = [];
    var used = {};

    if (htmlPath !== null) {
      var doc = new DOMParser().parseFromString(byPath[htmlPath], 'text/html');

      /* Stylesheets are inlined so a test can assert on layout, or on a class
         actually taking effect. A <link> cannot resolve — there is no server
         behind these paths. */
      var links = doc.querySelectorAll('link[rel="stylesheet"][href]');
      for (var l = 0; l < links.length; l++) {
        var href = normalise(links[l].getAttribute('href'));
        if (byPath[href] === undefined) continue;
        var linked = document.createElement('style');
        linked.textContent = byPath[href];
        document.head.appendChild(linked);
        used[href] = true;
      }
      var inlineStyles = doc.querySelectorAll('style');
      for (var s = 0; s < inlineStyles.length; s++) {
        var own = document.createElement('style');
        own.textContent = inlineStyles[s].textContent;
        document.head.appendChild(own);
      }

      /* Collected before the markup is transplanted: a <script> moved in via
         innerHTML is inert, so these have to be re-created as real elements. */
      var found = doc.querySelectorAll('script');
      for (var i = 0; i < found.length; i++) {
        var node = found[i];
        var src = node.getAttribute('src');
        if (src) {
          var resolved = normalise(src);
          if (byPath[resolved] !== undefined) {
            scripts.push({ source: byPath[resolved], label: resolved });
            used[resolved] = true;
          } else {
            // A CDN, or a path with nothing behind it. Named rather than
            // skipped: silently missing code is what produced tests failing
            // for a reason the learner could not see.
            scripts.push({ source: null, label: src });
          }
        } else if (node.textContent && node.textContent.trim()) {
          scripts.push({ source: node.textContent, label: htmlPath + ' (inline script)' });
        }
        if (node.parentNode) node.parentNode.removeChild(node);
      }

      document.body.innerHTML = doc.body ? doc.body.innerHTML : '';
    }

    /* Anything executable the HTML did not ask for. A project with no page at
       all is just this list, which is what a pure-logic step submits. */
    var rest = Object.keys(byPath).sort();
    for (var r = 0; r < rest.length; r++) {
      var p = rest[r];
      if (used[p] || !/\\.(js|mjs)$/i.test(p)) continue;
      scripts.push({ source: byPath[p], label: p });
    }

    return scripts;
  }

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || data.type !== 'exec-web') return;

    var files = data.files || [];
    var tests = data.tests || [];

    var byPath = {};
    for (var i = 0; i < files.length; i++) byPath[normalise(files[i].path)] = files[i].contents;
    window.__files = byPath;

    /* ---- build the page, then run its scripts in order ---- */
    var scripts;
    try {
      scripts = mount(byPath);
    } catch (e) {
      post({ type: 'error', message: 'Could not load the page: ' + (e.message || e) });
      return;
    }

    for (var j = 0; j < scripts.length; j++) {
      if (scripts[j].source === null) {
        post({
          type: 'error',
          message: 'index.html loads "' + scripts[j].label + '", which is not one of your files ' +
            'and cannot be fetched here. Reference a file that is part of the project.'
        });
        return;
      }
      var failure = runScript(scripts[j].source, scripts[j].label);
      if (failure) {
        post({ type: 'error', message: 'Error in ' + failure });
        return;
      }
    }

    /* Scripts were injected long after the real DOMContentLoaded fired, so a
       listener the learner registered for it would never run — and wiring up on
       DOMContentLoaded is the single most common shape this code takes. Firing
       both events puts that back. */
    try {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
      window.dispatchEvent(new Event('load'));
    } catch (e) {
      /* Neither event is essential to a test that does its own setup. */
    }

    /* ---- tests ----
       Indirect eval, not new Function: it evaluates at global scope, which is
       where the scripts above declared. A test can name what the learner wrote
       AND reach the DOM their markup built. */
    var results = [];
    var allPassed = true;
    var geval = eval;

    for (var k = 0; k < tests.length; k++) {
      var t = tests[k];
      post({ type: 'progress', message: 'Running: ' + t.name });
      try {
        // Braced so a test declaring a const cannot collide with the next
        // test doing the same — a redeclaration here would read as the
        // learner's bug rather than as two tests sharing a name.
        geval('{\\n' + t.code + '\\n}');
        results.push({ name: t.name, passed: true, message: 'OK' });
      } catch (e) {
        allPassed = false;
        results.push({
          name: t.name,
          passed: false,
          message: t.failureMessage || (e && e.message) || String(e)
        });
      }
    }

    post({ type: 'result', passed: allPassed, results: results });
  });

  post({ type: 'ready' });
})();
<\/script>
</head>
<body></body>
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
