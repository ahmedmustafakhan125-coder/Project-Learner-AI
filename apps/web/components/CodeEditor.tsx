'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

// Lazy-load Monaco - keeps ~2MB out of initial bundle
// @monaco-editor/react fetches Monaco from jsDelivr by default. The app CSP
// lists no CDN in script-src, so that request is refused and the editor sits on
// "Loading editor…" forever. Point the loader at the copy vendored into public/
// by scripts/vendor-assets.mjs before the component can trigger a fetch.
/**
 * Monaco's stock `vs-dark` sits on #1e1e1e, which reads as a different panel
 * from the starter-file blocks on --code-bg (#0f172a) directly above it. This
 * matches them, and warms the syntax colours toward the sky palette.
 */
const CODE_THEME = 'project-learner-dark';

function defineTheme(monaco: { editor: { defineTheme: (n: string, t: unknown) => void } }) {
  monaco.editor.defineTheme(CODE_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7dd3fc' },
      { token: 'string', foreground: '86efac' },
      { token: 'number', foreground: 'fcd34d' },
      { token: 'type', foreground: '93c5fd' },
      { token: 'function', foreground: 'bae6fd' },
    ],
    colors: {
      'editor.background': '#0f172a',
      'editor.foreground': '#e2e8f0',
      'editorLineNumber.foreground': '#475569',
      'editorLineNumber.activeForeground': '#94a3b8',
      'editor.lineHighlightBackground': '#1e293b',
      'editor.selectionBackground': '#1d4ed855',
      'editorCursor.foreground': '#38bdf8',
      'editorIndentGuide.background1': '#1e293b',
    },
  });
}

const MonacoEditor = dynamic(
  () =>
    import('@monaco-editor/react').then((m) => {
      m.loader.config({ paths: { vs: '/monaco/vs' } });
      return { default: m.default };
    }),
  {
    ssr: false,
    loading: () => <div className="editor-loading">Loading editor…</div>,
  },
);

interface CodeEditorProps {
  files: Array<{ path: string; contents: string }>;
  onChange: (files: Array<{ path: string; contents: string }>) => void;
  readOnlyPaths?: string[];
  /**
   * The tab to open on.
   *
   * Without this the editor opened on `files[0]`, and once the whole project
   * reached the tab bar that was a read-only file from some earlier step - so
   * a learner opened step 3 looking at step 1's `index.html`, greyed out, with
   * their own file several tabs along.
   */
  initialPath?: string | null;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  html: 'html',
  css: 'css',
  md: 'markdown',
  json: 'json',
  sql: 'sql',
};

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

export function CodeEditor({
  files,
  onChange,
  readOnlyPaths = [],
  initialPath = null,
}: CodeEditorProps) {
  const [selectedPath, setSelectedPath] = useState(initialPath ?? files[0]?.path ?? '');

  const readOnlySet = new Set(readOnlyPaths);
  /*
   * Falls back to the file the caller nominated, then to the first tab.
   *
   * A stale path from a previous file set would otherwise render an empty
   * editor body with no tab looking active — and falling back to `files[0]`
   * alone puts the learner on a read-only file, which is the thing
   * `initialPath` exists to prevent.
   */
  const activeFile =
    files.find((f) => f.path === selectedPath) ??
    files.find((f) => f.path === initialPath) ??
    files[0];
  const activePath = activeFile?.path ?? '';
  const isReadOnly = readOnlySet.has(activePath);

  function handleChange(value: string | undefined) {
    if (value === undefined) return;
    const updated = files.map(f =>
      f.path === activePath ? { ...f, contents: value } : f,
    );
    onChange(updated);
  }

  return (
    <div className="code-editor">
      {/* Tab bar */}
      <div className="code-editor-tabs" role="tablist">
        {files.map(f => (
          <button
            key={f.path}
            role="tab"
            aria-selected={f.path === activePath}
            className="code-editor-tab"
            onClick={() => setSelectedPath(f.path)}
          >
            {f.path}
            {readOnlySet.has(f.path) && (
              <span className="code-editor-readonly" title="From an earlier step — read-only">
                read-only
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div className="code-editor-body">
        {activeFile && (
          <MonacoEditor
            height="400px"
            theme={CODE_THEME}
            language={detectLanguage(activeFile.path)}
            value={activeFile.contents}
            onChange={handleChange}
            beforeMount={defineTheme}
            options={{
              readOnly: isReadOnly,
              minimap: { enabled: false },
              fontSize: 14,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              scrollBeyondLastLine: false,
              tabSize: 2,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}
