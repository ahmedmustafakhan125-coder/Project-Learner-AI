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
 * Containment does NOT come from the iframe attribute alone. That attribute is
 * set by the parent, so it only ever applied when our own page did the framing;
 * a third-party page could frame this route without it and get a document
 * running on our origin. The response now carries `frame-ancestors 'self'` and
 * `X-Frame-Options`, and the document only accepts messages from its opener —
 * so the containment holds however the document was reached.
 */
export const dynamic = 'force-dynamic';

/**
 * The app's own origin, as configuration rather than as something the caller
 * chose.
 *
 * `new URL(request.url).origin` is reconstructed from the Host header, which a
 * deployment that forwards `$host` unvalidated lets an attacker set — and that
 * value lands in `script-src` and `connect-src`, turning the sandbox's network
 * allowlist into an allowlist for their server. Configuration first, request
 * only as the local-development fallback.
 */
let warnedAboutHostFallback = false;

function appOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN;
  if (configured) return configured.replace(/\/+$/, '');

  /*
   * Unset. Fall back to the request, but say so, once.
   *
   * Failing closed here would take the sandbox out entirely on any deployment
   * that has not set the variable yet, which is a worse outcome than the hole
   * itself: reaching it needs a proxy that forwards an unvalidated Host, or
   * cache poisoning. Silence is the thing that cannot be defended - the
   * fallback is the vulnerable path, so a deployment running on it should not
   * have to read the source to find that out.
   */
  if (process.env.NODE_ENV === 'production' && !warnedAboutHostFallback) {
    warnedAboutHostFallback = true;
    console.warn(
      '[sandbox] NEXT_PUBLIC_APP_ORIGIN is not set. The sandbox CSP is being ' +
        'built from the request Host header, which a proxy that forwards it ' +
        'unvalidated lets a caller choose - putting their origin into ' +
        "script-src and connect-src. Set it to the app's own origin.",
    );
  }
  return new URL(request.url).origin;
}

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const runtime = url.searchParams.get('runtime') === 'python' ? 'python' : 'web';
  const origin = appOrigin(request);

  return new Response(createSandboxHTML(runtime, origin), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': sandboxCsp(origin),
      // For browsers that predate frame-ancestors. Same claim, older spelling.
      'X-Frame-Options': 'SAMEORIGIN',
      // The sandbox must never be cached as a top-level navigation target.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
