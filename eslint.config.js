import tseslint from 'typescript-eslint';

/**
 * The important rule in this file is the portability guard on `packages/core`
 * and `packages/api-client`.
 *
 * Those two packages must run unchanged inside React Native when the mobile app
 * arrives. Nothing enforces that at runtime today — the web app would work fine
 * either way — so the constraint would rot silently without a lint rule. Node
 * builtins, DOM-coupled framework imports, and vendor SDKs are all banned there;
 * `packages/core` reaches models only through `@ai-edu/llm`.
 *
 * DOM *globals* (`document`, `window`) are blocked separately and more
 * reliably: those packages compile without the DOM lib, so touching them is a
 * type error rather than a lint warning.
 */
const PORTABILITY_BAN = {
  patterns: [
    {
      group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'crypto', 'child_process', 'http', 'https', 'stream', 'worker_threads'],
      message:
        'packages/core and packages/api-client must run on React Native. Node builtins are not available there — move this to apps/api.',
    },
    {
      group: ['next', 'next/*', 'react-dom', 'react-dom/*', '@monaco-editor/*'],
      message:
        'No web-framework or browser-widget imports in portable packages. Keep rendering concerns in apps/web.',
    },
    {
      group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*', 'openai', 'openai/*'],
      message:
        'Do not import a vendor SDK directly. Go through @ai-edu/llm so the code stays provider-agnostic.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Vendored third-party runtimes, copied out of node_modules at build time
      // by apps/web/scripts/vendor-assets.mjs. Not our source, and minified.
      'apps/web/public/monaco/**',
      'apps/web/public/pyodide/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Adapters are the one place vendor SDKs are allowed.
    files: ['packages/llm/src/adapters/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['packages/core/**/*.ts', 'packages/api-client/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', PORTABILITY_BAN],
      // api-client compiles WITH the DOM lib so the web-standard networking
      // types (fetch, Response, ReadableStream, TextDecoder) are available —
      // all of which React Native also implements. Actual DOM access is not
      // portable, so it is banned here instead of by omitting the lib.
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Not available in React Native. Keep DOM access in apps/web.' },
        { name: 'window', message: 'Not available in React Native. Keep browser globals in apps/web.' },
        { name: 'localStorage', message: 'Not available in React Native. Inject storage instead.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.conformance.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
