'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

// Lazy-load Monaco - keeps ~2MB out of initial bundle
// @monaco-editor/react fetches Monaco from jsDelivr by default. The app CSP
// lists no CDN in script-src, so that request is refused and the editor sits on
// "Loading editor…" forever. Point the loader at the copy vendored into public/
// by scripts/vendor-assets.mjs before the component can trigger a fetch.
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

export function CodeEditor({ files, onChange, readOnlyPaths = [] }: CodeEditorProps) {
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? '');

  const readOnlySet = new Set(readOnlyPaths);
  // Falls back to the first file when the selection is no longer in `files` —
  // a stale path from a previous file set would otherwise render an empty
  // editor body with no tab looking active.
  const activeFile = files.find(f => f.path === selectedPath) ?? files[0];
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
            {readOnlySet.has(f.path) && <span className="code-editor-readonly">ro</span>}
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div className="code-editor-body">
        {activeFile && (
          <MonacoEditor
            height="400px"
            theme="vs-dark"
            language={detectLanguage(activeFile.path)}
            value={activeFile.contents}
            onChange={handleChange}
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
