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
