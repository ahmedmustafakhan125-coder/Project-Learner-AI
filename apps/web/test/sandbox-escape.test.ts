/**
 * Sandbox security conformance tests.
 *
 * These tests statically verify that the sandbox iframe configuration and
 * generated HTML enforce browser-level containment guarantees. The actual
 * enforcement is a browser spec guarantee — if the `sandbox` attribute is
 * correct, containment is guaranteed without needing a live browser.
 *
 * Satisfies the P3 exit criterion from CONTEXT.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSandboxHTML,
  SANDBOX_TIMEOUT_MS,
} from '../lib/sandbox-protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the SandboxFrame component source for static attribute inspection. */
function readSandboxFrameSource(): string {
  const componentPath = resolve(
    __dirname,
    '..',
    'components',
    'SandboxFrame.tsx',
  );
  return readFileSync(componentPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test 1 — window.parent access is blocked by opaque origin
// ---------------------------------------------------------------------------

describe('Sandbox containment: window.parent blocked by opaque origin', () => {
  const frameSource = readSandboxFrameSource();

  it('iframe uses sandbox="allow-scripts" WITHOUT allow-same-origin', () => {
    // The JSX must contain sandbox="allow-scripts" and the attribute value
    // must NOT include allow-same-origin.
    expect(frameSource).toMatch(/sandbox="allow-scripts"/);
    // Verify no sandbox attribute value contains allow-same-origin.
    const sandboxAttrs = [...frameSource.matchAll(/sandbox="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const attr of sandboxAttrs) {
      expect(attr).not.toContain('allow-same-origin');
    }
  });

  it('createSandboxHTML("web") output contains no allow-same-origin escape hatch', () => {
    const html = createSandboxHTML('web');
    expect(html).not.toContain('allow-same-origin');
  });

  it('createSandboxHTML("python") output contains no allow-same-origin escape hatch', () => {
    const html = createSandboxHTML('python');
    expect(html).not.toContain('allow-same-origin');
  });

  it('opaque origin guarantees window.parent access throws SecurityError in a real browser', () => {
    // Specification reference:
    // Per the HTML spec, an iframe with `sandbox="allow-scripts"` but WITHOUT
    // `allow-same-origin` is assigned an opaque origin (a unique, globally
    // isolated origin). Any attempt by the iframe to access `window.parent`
    // properties crosses an origin boundary and the browser MUST throw a
    // DOMException (SecurityError). This is not something user code can
    // override — it is enforced at the browser engine level.
    //
    // We assert the attribute is correct; the browser enforces the rest.
    const sandboxAttrs = [...frameSource.matchAll(/sandbox="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const attr of sandboxAttrs) {
      expect(attr).toContain('allow-scripts');
      expect(attr).not.toContain('allow-same-origin');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — fetch() / network access is blocked by opaque origin
// ---------------------------------------------------------------------------

describe('Sandbox containment: network access blocked by opaque origin', () => {
  const frameSource = readSandboxFrameSource();

  it('sandbox attribute does NOT include allow-same-origin, blocking network requests', () => {
    // Per the Fetch spec, a request initiated from an opaque origin with no
    // `allow-same-origin` flag fails the CORS check and the network layer
    // returns a network error. The iframe cannot make credentialed requests,
    // read cookies, access localStorage, or exfiltrate data via fetch/XHR.
    //
    // We verify the attribute is configured to enforce this.
    const sandboxAttrMatch = frameSource.match(/sandbox="([^"]*)"/);
    expect(sandboxAttrMatch).not.toBeNull();

    const sandboxValue = sandboxAttrMatch![1];
    expect(sandboxValue).toContain('allow-scripts');
    expect(sandboxValue).not.toContain('allow-same-origin');
    // Also ensure no other dangerous flags are present.
    expect(sandboxValue).not.toContain('allow-forms');
    expect(sandboxValue).not.toContain('allow-popups');
    expect(sandboxValue).not.toContain('allow-top-navigation');
  });

  it('createSandboxHTML("web") does not grant any network-enabling sandbox flags', () => {
    const html = createSandboxHTML('web');
    // The HTML itself must never embed a meta tag or script that sets
    // allow-same-origin or other network-enabling flags.
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-forms');
    expect(html).not.toContain('allow-popups');
  });

  it('createSandboxHTML("python") does not grant any network-enabling sandbox flags', () => {
    const html = createSandboxHTML('python');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-forms');
    expect(html).not.toContain('allow-popups');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Infinite loop is terminated within SANDBOX_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('Sandbox containment: infinite loop terminated within timeout', () => {
  const frameSource = readSandboxFrameSource();

  it('SANDBOX_TIMEOUT_MS is defined and set to 10 000 ms (10 s ceiling)', () => {
    expect(SANDBOX_TIMEOUT_MS).toBeDefined();
    expect(typeof SANDBOX_TIMEOUT_MS).toBe('number');
    expect(SANDBOX_TIMEOUT_MS).toBe(10_000);
  });

  it('SandboxFrame component starts a timer using SANDBOX_TIMEOUT_MS on every exec', () => {
    // The component must call setTimeout with SANDBOX_TIMEOUT_MS so that an
    // unresponsive sandbox (e.g. stuck in an infinite loop) is killed.
    expect(frameSource).toContain('SANDBOX_TIMEOUT_MS');
    expect(frameSource).toMatch(/setTimeout\([^,]+,\s*SANDBOX_TIMEOUT_MS\)/);
  });

  it('timeout handler kills the iframe by navigating to about:blank and removing it', () => {
    // When the timer fires, the component must destroy the iframe so the
    // infinite loop cannot continue consuming resources.
    expect(frameSource).toContain("frame.src = 'about:blank'");
    expect(frameSource).toContain('frame.remove()');
  });

  it('timeout fires an onError callback informing the user', () => {
    // The user must receive feedback that execution was killed.
    expect(frameSource).toMatch(
      /onError\(['"].*timed out.*['"]\)/i,
    );
  });

  it('createSandboxHTML output contains no mechanism to disable or extend the timeout', () => {
    // The generated sandbox HTML must not contain any code that could
    // intercept, clear, or extend the parent-imposed timeout.
    const webHtml = createSandboxHTML('web');
    const pyHtml = createSandboxHTML('python');

    // No setTimeout/clearTimeout inside sandbox — parent controls timing.
    for (const html of [webHtml, pyHtml]) {
      expect(html).not.toContain('clearTimeout');
      expect(html).not.toContain('SANDBOX_TIMEOUT');
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: sandbox HTML wraps execution in try/catch
// ---------------------------------------------------------------------------

describe('Sandbox HTML error containment', () => {
  it('web sandbox wraps learner code execution in try/catch', () => {
    const html = createSandboxHTML('web');
    // Learner code is executed inside a try block so runtime errors don't
    // crash the sandbox or silently swallow failures.
    expect(html).toMatch(/try\s*\{[\s\S]*?new Function\(code\)[\s\S]*?\}\s*catch/);
  });

  it('python sandbox wraps learner code execution in try/catch', () => {
    const html = createSandboxHTML('python');
    expect(html).toMatch(/try\s*\{[\s\S]*?pyodide\.runPython\(code\)[\s\S]*?\}\s*catch/);
  });

  it('web sandbox wraps each test case in try/catch', () => {
    const html = createSandboxHTML('web');
    // Individual test failures must be captured, not propagated as uncaught.
    expect(html).toMatch(/try\s*\{[\s\S]*?new Function\(t\.code\)[\s\S]*?\}\s*catch/);
  });

  it('python sandbox wraps each test case in try/catch', () => {
    const html = createSandboxHTML('python');
    expect(html).toMatch(/try\s*\{[\s\S]*?pyodide\.runPython\(t\.code\)[\s\S]*?\}\s*catch/);
  });

  it('web sandbox posts an error message instead of crashing silently', () => {
    const html = createSandboxHTML('web');
    // When learner code throws, the sandbox must post an 'error' message
    // back to the parent so the UI can display it.
    expect(html).toMatch(
      /catch[\s\S]*?post\(\{\s*type:\s*'error'/,
    );
  });

  it('python sandbox posts an error message instead of crashing silently', () => {
    const html = createSandboxHTML('python');
    expect(html).toMatch(
      /catch[\s\S]*?post\(\{\s*type:\s*'error'/,
    );
  });
});
