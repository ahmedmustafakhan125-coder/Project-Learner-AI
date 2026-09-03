/**
 * Sandbox configuration guards.
 *
 * These are cheap static checks that the sandbox is still *spelled* correctly —
 * they run with no browser and no build, so they catch an accidental edit fast.
 *
 * They are NOT the P3 exit criterion, and they cannot be. Reading the source and
 * matching a regex proves nothing about what a browser does: this file would
 * still pass if the attribute were widened at runtime via `setAttribute`. The
 * criterion — reaching `window.parent`, calling `fetch`, an infinite loop — is
 * proven by executing real escapes in a real browser in
 * `sandbox-containment.browser.test.ts`, which includes a mutation check
 * demonstrating those tests can actually fail.
 *
 * A note on what contains what, because it is easy to get backwards:
 *
 *   - `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an
 *     OPAQUE ORIGIN. That is what blocks reaching the parent's DOM, cookies and
 *     storage.
 *   - An opaque origin does NOT block `fetch`. Such a frame can still issue
 *     requests; they simply carry `Origin: null`, and anything answering
 *     `Access-Control-Allow-Origin: *` is readable. Network containment comes
 *     from the sandbox document's `connect-src`, not from the sandbox attribute.
 *   - The sandbox is served from a route rather than `srcdoc` because a srcdoc
 *     frame inherits the parent CSP, which has no 'unsafe-inline' and therefore
 *     refuses the sandbox's own bootstrap script.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createSandboxHTML, SANDBOX_TIMEOUT_MS } from '../lib/sandbox-protocol';
import { appCsp, sandboxCsp } from '../lib/csp.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(resolve(webRoot, relativePath), 'utf-8');
}

/**
 * Strip comments before asserting a call is absent — otherwise a comment
 * explaining why the call was removed reads as the call still being there.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const frameSource = read('components/SandboxFrame.tsx');

describe('sandbox attribute', () => {
  it('uses allow-scripts and never allow-same-origin', () => {
    const attrs = [...frameSource.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
    expect(attrs.length).toBeGreaterThan(0);
    for (const attr of attrs) {
      expect(attr).toContain('allow-scripts');
      // The two together are equivalent to no sandbox at all: a frame with both
      // can reach in and remove its own sandbox attribute.
      expect(attr).not.toContain('allow-same-origin');
      expect(attr).not.toContain('allow-top-navigation');
      expect(attr).not.toContain('allow-popups');
    }
  });

  it('never widens the sandbox attribute at runtime', () => {
    expect(frameSource).not.toMatch(/setAttribute\(\s*['"]sandbox['"]/);
  });
});

describe('sandbox delivery', () => {
  it('is served from a route, not srcdoc, so it does not inherit the app CSP', () => {
    expect(frameSource).toMatch(/src=\{`\/sandbox\?runtime=/);
    expect(frameSource).not.toContain('srcDoc');
  });

  it('remounts the frame via key rather than removing a React-owned node', () => {
    // Calling frame.remove() detaches a node React still believes it owns; the
    // ref is then never reattached and every later run silently does nothing.
    expect(codeOnly(frameSource)).not.toContain('frame.remove()');
    expect(frameSource).toMatch(/key=\{`\$\{runtime\}-\$\{generation\}`\}/);
  });
});

describe('content security policy', () => {
  it('the app policy allows no CDN in script-src', () => {
    const csp = appCsp('testnonce');
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('the app policy carries a nonce and never falls back to unsafe-inline', () => {
    // Without a nonce Next's inline hydration scripts are refused and the page
    // renders but never becomes interactive. 'unsafe-inline' would "fix" that
    // by reopening the XSS path the no-markdown-renderer rule exists to close.
    const csp = appCsp('abc123');
    expect(csp).toContain("'nonce-abc123'");
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('refuses to build an app policy without a nonce', () => {
    expect(() => appCsp('')).toThrow(/nonce/i);
  });

  it('the sandbox policy names the origin explicitly, because self is opaque there', () => {
    const csp = sandboxCsp('https://app.example');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('connect-src https://app.example');
    // 'self' would resolve against the frame's opaque origin and match nothing.
    expect(csp).not.toMatch(/connect-src[^;]*'self'/);
  });

  it('the sandbox cannot reach an arbitrary external origin', () => {
    const csp = sandboxCsp('https://app.example');
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connect).toBe('connect-src https://app.example');
  });
});

describe('sandbox runtime assets', () => {
  it('loads Pyodide from our own origin, not a CDN', () => {
    const html = createSandboxHTML('python');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('/pyodide/pyodide.js');
    // Without indexURL, Pyodide resolves its wasm and stdlib back to the CDN.
    expect(html).toContain("indexURL: '/pyodide/'");
  });

  it('loads Monaco from our own origin, not a CDN', () => {
    const editor = read('components/CodeEditor.tsx');
    expect(editor).toContain("paths: { vs: '/monaco/vs' }");
  });
});

describe('execution timeout', () => {
  it('is a fixed 10s ceiling the sandbox cannot influence', () => {
    expect(SANDBOX_TIMEOUT_MS).toBe(10_000);
    expect(frameSource).toMatch(/setTimeout\([^,]+,\s*SANDBOX_TIMEOUT_MS\)/);
    // The timer lives in the parent; nothing inside the frame can clear it.
    for (const html of [createSandboxHTML('web'), createSandboxHTML('python')]) {
      expect(html).not.toContain('clearTimeout');
      expect(html).not.toContain('SANDBOX_TIMEOUT');
    }
  });

  it('tells the learner when execution was killed', () => {
    expect(frameSource).toMatch(/onError\(['"].*timed out.*['"]\)/i);
  });
});

describe('error containment in generated HTML', () => {
  it('wraps learner code and each test so one failure cannot crash the sandbox', () => {
    const web = createSandboxHTML('web');
    expect(web).toMatch(/try\s*\{[\s\S]*?new Function\(code\)[\s\S]*?\}\s*catch/);
    expect(web).toMatch(/try\s*\{[\s\S]*?new Function\(t\.code\)[\s\S]*?\}\s*catch/);

    // Loading the submission is writing its files out and then executing the
    // modules among them, so the guarded call is the loader rather than a bare
    // runPython of one concatenated blob.
    const py = createSandboxHTML('python');
    expect(py).toMatch(/try\s*\{[\s\S]*?materialise\(pyodide, files\)[\s\S]*?\}\s*catch/);
    expect(py).toMatch(/try\s*\{[\s\S]*?pyodide\.runPython\(PY_LOAD\)[\s\S]*?\}\s*catch/);
    expect(py).toMatch(/try\s*\{[\s\S]*?pyodide\.runPython\(t\.code\)[\s\S]*?\}\s*catch/);

    for (const html of [web, py]) {
      expect(html).toMatch(/catch[\s\S]*?post\(\{\s*type:\s*'error'/);
    }
  });
});
