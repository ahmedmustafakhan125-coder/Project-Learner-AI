import { NextResponse, type NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs, shared with next.config.mjs which cannot import TS.
import { appCsp } from './lib/csp.mjs';

/**
 * Per-request CSP nonce.
 *
 * Next.js delivers its hydration payload in inline <script> tags. A policy with
 * neither 'unsafe-inline' nor a nonce refuses them, and the result is a page
 * that renders and then does nothing at all — no interactivity, one minified
 * React error in the console, and no other symptom.
 *
 * Setting the CSP on the *request* headers is what makes this work: Next reads
 * the nonce back out of that header and stamps it onto every script it emits.
 * Setting it only on the response would secure the page against its own app.
 *
 * Named `proxy` rather than `middleware`: Next 16 deprecated the middleware
 * file convention. Same execution point, same contract.
 *
 * /sandbox is excluded below. It serves its own, far tighter policy — see
 * app/sandbox/route.ts and the note in lib/csp.mjs about why it cannot inherit
 * this one.
 */
export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = appCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except the sandbox, Next's own static output, and the vendored
     * runtimes — those are immutable assets that need no policy and would only
     * pay the middleware cost.
     */
    '/((?!sandbox|_next/static|_next/image|monaco|pyodide|favicon.ico).*)',
  ],
};
