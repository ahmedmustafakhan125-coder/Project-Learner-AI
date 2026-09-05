import { describe, expect, it } from 'vitest';

import { composeWorkspace } from '../src/progress/workspace.js';

/**
 * The step workspace, across the configurations a real project produces.
 *
 * The bug this covers was silent and constant: the tab bar was assembled as
 * `[...inherited, ...own]`, so opening any step past the first landed the
 * learner on a read-only file from an earlier step. Their own file was the last
 * tab along, and the editor they were looking at refused to accept typing.
 *
 * Every case below is a real shape a generated project produces — a step that
 * only creates, a step that only edits, a step that does both, a step that owns
 * nothing, and the first step of all, which inherits nothing.
 */

const HTML = { path: 'index.html', contents: '<!DOCTYPE html><html></html>' };
const CSS = { path: 'styles.css', contents: '.todo { color: red; }' };
const APP = { path: 'app.js', contents: 'const todos = [];' };
const STORAGE = { path: 'storage.js', contents: '// TODO: save()' };

describe('the first step, which inherits nothing', () => {
  const workspace = composeWorkspace({ ownFiles: [HTML], priorFiles: [] });

  it('shows only its own file', () => {
    expect(workspace.files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('makes nothing read-only', () => {
    expect(workspace.readOnlyPaths).toEqual([]);
  });

  it('opens on it', () => {
    expect(workspace.initialPath).toBe('index.html');
  });
});

describe('a step that only creates a new file', () => {
  const workspace = composeWorkspace({
    ownFiles: [STORAGE],
    priorFiles: [HTML, CSS, APP],
  });

  it('opens on the file the learner is meant to write', () => {
    // The bug: this used to be `index.html`, a read-only file from step 1.
    expect(workspace.initialPath).toBe('storage.js');
  });

  it('puts the learner’s own file first in the tab bar', () => {
    expect(workspace.files[0]!.path).toBe('storage.js');
  });

  it('still shows the rest of the project, for reference', () => {
    expect(workspace.files.map((f) => f.path)).toEqual([
      'storage.js',
      'index.html',
      'styles.css',
      'app.js',
    ]);
  });

  it('marks everything it does not own read-only', () => {
    expect(workspace.readOnlyPaths).toEqual(['index.html', 'styles.css', 'app.js']);
  });
});

describe('a step that edits a file an earlier step created', () => {
  const edited = { path: 'app.js', contents: 'const todos = [];\nfunction persist() {}' };
  const workspace = composeWorkspace({
    ownFiles: [edited],
    priorFiles: [HTML, APP],
  });

  it('shows the file once, not twice', () => {
    // Two tabs for one path is worse than confusing: edits to one are
    // invisible in the other.
    expect(workspace.files.filter((f) => f.path === 'app.js')).toHaveLength(1);
  });

  it('shows the editable copy, not the version they started from', () => {
    // Taking the inherited one would silently discard what they had typed.
    expect(workspace.files.find((f) => f.path === 'app.js')!.contents).toBe(edited.contents);
  });

  it('does not mark it read-only', () => {
    expect(workspace.readOnlyPaths).toEqual(['index.html']);
    expect(workspace.ownPaths).toEqual(['app.js']);
  });

  it('opens on it', () => {
    expect(workspace.initialPath).toBe('app.js');
  });
});

describe('a step that both creates and edits', () => {
  const workspace = composeWorkspace({
    ownFiles: [STORAGE, { path: 'app.js', contents: 'edited' }],
    priorFiles: [HTML, CSS, APP],
  });

  it('keeps both of its own files editable and first', () => {
    expect(workspace.files.slice(0, 2).map((f) => f.path)).toEqual(['storage.js', 'app.js']);
    expect(workspace.readOnlyPaths).toEqual(['index.html', 'styles.css']);
  });

  it('opens on the first of them', () => {
    expect(workspace.initialPath).toBe('storage.js');
  });
});

describe('paths written more than one way', () => {
  it('treats ./app.js and app.js as one file, preferring the editable copy', () => {
    const workspace = composeWorkspace({
      ownFiles: [{ path: './app.js', contents: 'mine' }],
      priorFiles: [{ path: 'app.js', contents: 'theirs' }],
    });

    expect(workspace.files).toHaveLength(1);
    expect(workspace.files[0]!.path).toBe('app.js');
    expect(workspace.files[0]!.contents).toBe('mine');
    expect(workspace.readOnlyPaths).toEqual([]);
  });

  it('normalises a leading slash and doubled separators', () => {
    const workspace = composeWorkspace({
      ownFiles: [{ path: '/src//app.js', contents: 'x' }],
      priorFiles: [],
    });
    expect(workspace.files[0]!.path).toBe('src/app.js');
  });

  it('drops a file with no usable path rather than rendering a blank tab', () => {
    const workspace = composeWorkspace({
      ownFiles: [{ path: '   ', contents: 'x' }, APP],
      priorFiles: [],
    });
    expect(workspace.files.map((f) => f.path)).toEqual(['app.js']);
  });

  it('keeps the first of two identical own paths', () => {
    const workspace = composeWorkspace({
      ownFiles: [
        { path: 'app.js', contents: 'first' },
        { path: './app.js', contents: 'second' },
      ],
      priorFiles: [],
    });
    expect(workspace.files).toHaveLength(1);
    expect(workspace.files[0]!.contents).toBe('first');
  });
});

describe('degenerate steps', () => {
  it('handles a step that owns nothing but has a project around it', () => {
    // Possible on a step whose expansion produced no starter files. Everything
    // is reference; there is nothing to type in, and the caller needs to know.
    const workspace = composeWorkspace({ ownFiles: [], priorFiles: [HTML, APP] });

    expect(workspace.ownPaths).toEqual([]);
    expect(workspace.readOnlyPaths).toEqual(['index.html', 'app.js']);
    expect(workspace.initialPath).toBe('index.html');
  });

  it('handles a step with no files at all', () => {
    const workspace = composeWorkspace({ ownFiles: [], priorFiles: [] });

    expect(workspace.files).toEqual([]);
    expect(workspace.initialPath).toBeNull();
  });

  it('survives prior files being absent entirely', () => {
    // A step fetched before `priorFiles` was part of the payload. Reading
    // `.filter` off undefined in the component threw during render, which
    // takes the whole page with it - there is no boundary around the step body.
    const workspace = composeWorkspace({
      ownFiles: [APP],
      priorFiles: undefined as unknown as [],
    });
    expect(workspace.files.map((f) => f.path)).toEqual(['app.js']);
  });
});
