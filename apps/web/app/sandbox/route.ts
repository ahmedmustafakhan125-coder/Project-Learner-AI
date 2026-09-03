import { createSandboxHTML } from '@/lib/sandbox-protocol';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs shared with next.config.mjs, which cannot import TS.
import { sandboxCsp } from '@/lib/csp.mjs';

/**
 * Serves the execution sandbox as its own document.
 *
 * This is deliberately a route rather than a `srcdoc` attribute. A srcdoc frame
 * inherits the parent's CSP, and the app policy has no 'unsafe-inline', so the
 * sandbox bootstrap script is refused and the frame silently does nothing. A
 * frame loaded from a real URL is governed by the CSP on its own response
 * instead, which is what makes the sandbox runnable while keeping the app page
 * locked down. See lib/csp.mjs.
 *
 * The frame is still given an opaque origin by `sandbox="allow-scripts"` on the
 * iframe itself — serving over http changes the policy, never the containment.
 */
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const runtime = url.searchParams.get('runtime') === 'python' ? 'python' : 'web';

  return new Response(createSandboxHTML(runtime), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': sandboxCsp(url.origin),
      // The sandbox must never be cached as a top-level navigation target.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
