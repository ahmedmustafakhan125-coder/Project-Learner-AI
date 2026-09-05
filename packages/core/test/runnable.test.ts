import { describe, expect, it } from 'vitest';

import {
  groundCheckpoint,
  jsBareSpecifiers,
  pythonImportRoots,
  unrunnableImports,
} from '../src/generation/runnable.js';
import type { Checkpoint, SourceFile } from '../src/schemas/step.js';

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  requiredFiles: ['main.py'],
  requiredSymbols: ['check_environment'],
  tests: [{ name: 't', code: 'assert True', failureMessage: 'nope' }],
  runtime: 'python',
  ...over,
});

const file = (path: string, contents: string): SourceFile => ({ path, contents });

describe('pythonImportRoots', () => {
  it('reads both import forms and takes the root package', () => {
    const src = [
      'import os',
      'import numpy as np',
      'from collections.abc import Iterable',
      'from fastapi import FastAPI',
      'import a.b.c, d',
    ].join('\n');

    expect(pythonImportRoots(src).sort()).toEqual(['a', 'collections', 'd', 'fastapi', 'numpy', 'os']);
  });

  it('ignores comments and relative imports', () => {
    const src = ['# import fastapi', 'from . import helpers', 'from .models import User'].join('\n');
    expect(pythonImportRoots(src)).toEqual([]);
  });
});

describe('jsBareSpecifiers', () => {
  it('separates packages from files in the submission', () => {
    const src = [
      "import React from 'react';",
      "import './styles.css';",
      "import { helper } from '../lib/helper.js';",
      "const lodash = require('lodash');",
      "const local = require('./local');",
    ].join('\n');

    expect(jsBareSpecifiers(src).sort()).toEqual(['lodash', 'react']);
  });
});

describe('unrunnableImports', () => {
  it('passes a step that only uses the standard library', () => {
    const files = [file('main.py', 'import json\nimport os\nfrom pathlib import Path')];
    expect(unrunnableImports(files, 'python')).toEqual([]);
  });

  it('names the packages Pyodide cannot provide', () => {
    const files = [
      file('requirements.txt', 'fastapi>=0.100.0'),
      file('main.py', 'import fastapi\nimport uvicorn\nimport json'),
    ];
    expect(unrunnableImports(files, 'python')).toEqual(['fastapi', 'uvicorn']);
  });

  it('only reads files of the runtime being checked', () => {
    // The dependency list is not Python, whatever it happens to contain.
    const files = [file('requirements.txt', 'import fastapi')];
    expect(unrunnableImports(files, 'python')).toEqual([]);
  });
});

describe('groundCheckpoint', () => {
  it('leaves a runnable checkpoint alone', () => {
    const files = [file('main.py', 'import json')];
    const result = groundCheckpoint(checkpoint(), files);
    expect(result.runtime).toBe('python');
    expect(result.tests).toHaveLength(1);
  });

  it('turns off auto-checking when the sandbox could not load the code', () => {
    const files = [file('main.py', 'import fastapi')];
    const result = groundCheckpoint(checkpoint(), files);

    expect(result.runtime).toBe('none');
    expect(result.tests).toEqual([]);
    // The cheap layers still hold the step to account.
    expect(result.requiredFiles).toEqual(['main.py']);
    expect(result.requiredSymbols).toEqual(['check_environment']);
  });

  it('does the same for an npm package in a web step', () => {
    const files = [file('app.js', "import React from 'react';")];
    const result = groundCheckpoint(checkpoint({ runtime: 'web' }), files);
    expect(result.runtime).toBe('none');
  });

  it('leaves a step that already opted out untouched', () => {
    const already = checkpoint({ runtime: 'none', tests: [] });
    expect(groundCheckpoint(already, [file('main.py', 'import fastapi')])).toBe(already);
  });
});

/**
 * Languages the sandbox cannot execute at all.
 *
 * The import scan asks whether the sandbox can resolve what a file pulls in.
 * It could never catch a project written in a language the sandbox does not
 * run, because there were no imports it recognised to scan: a Java project
 * kept `runtime: "web"`, the sandbox was handed a project with no scripts in
 * it, executed nothing, and every test failed with its own failureMessage on
 * correct work.
 */
describe('a project the runtime cannot execute', () => {
  const web = (tests: number) => ({
    requiredFiles: [],
    requiredSymbols: [],
    runtime: 'web' as const,
    tests: Array.from({ length: tests }, (_, i) => ({
      name: `t${i}`,
      code: 'true',
      failureMessage: 'no',
    })),
  });

  it('drops the tests for a Java project', () => {
    const grounded = groundCheckpoint(web(2), [
      { path: 'Main.java', contents: 'public class Main {}' },
      { path: 'Todo.java', contents: 'public class Todo {}' },
    ]);
    expect(grounded.runtime).toBe('none');
    expect(grounded.tests).toEqual([]);
  });

  it('drops the tests for C++, Go, Rust and C#', () => {
    for (const path of ['main.cpp', 'main.go', 'main.rs', 'Program.cs']) {
      const grounded = groundCheckpoint(web(1), [{ path, contents: 'int main() {}' }]);
      expect(grounded.runtime, path).toBe('none');
    }
  });

  it('drops the tests when python is claimed but nothing is python', () => {
    const grounded = groundCheckpoint(
      { ...web(1), runtime: 'python' },
      [{ path: 'Main.java', contents: 'public class Main {}' }],
    );
    expect(grounded.runtime).toBe('none');
  });

  /* ---- and must not fire on projects that DO run ---- */

  it('keeps the tests for a web project', () => {
    const grounded = groundCheckpoint(web(2), [
      { path: 'index.html', contents: '<html></html>' },
      { path: 'app.js', contents: 'const a = 1;' },
    ]);
    expect(grounded.runtime).toBe('web');
    expect(grounded.tests).toHaveLength(2);
  });

  it('keeps the tests for a page with no separate script file', () => {
    // The executable part is inside the HTML, which the sandbox runs.
    const grounded = groundCheckpoint(web(1), [
      { path: 'index.html', contents: '<html><script>const a = 1;</script></html>' },
    ]);
    expect(grounded.runtime).toBe('web');
  });

  it('keeps the tests for a python project', () => {
    const grounded = groundCheckpoint({ ...web(1), runtime: 'python' }, [
      { path: 'main.py', contents: 'def main(): pass' },
    ]);
    expect(grounded.runtime).toBe('python');
  });

  it('keeps the tests for a step that only touches a stylesheet', () => {
    /*
     * The reason grounding is done against the whole project rather than the
     * step's own files. This step owns nothing executable; the project it sits
     * in is an ordinary web app and its tests run fine.
     */
    const grounded = groundCheckpoint(web(1), [
      { path: 'index.html', contents: '<html></html>' },
      { path: 'app.js', contents: 'const a = 1;' },
      { path: 'styles.css', contents: '.a {}' },
    ]);
    expect(grounded.runtime).toBe('web');
  });

  it('leaves a checkpoint that never had tests alone', () => {
    const grounded = groundCheckpoint(web(0), [{ path: 'Main.java', contents: 'x' }]);
    expect(grounded.runtime).toBe('web');
  });
});
