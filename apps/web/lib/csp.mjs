/**
 * Content-Security-Policy, in one place because two very different documents
 * need two very different policies and getting them mixed up is silent.
 *
 * The app page and the execution sandbox are NOT governed by the same policy,
 * and cannot be:
 *
 *   - A `srcdoc` iframe INHERITS its parent's CSP (inheritance applies to the
 *     local schemes: about:srcdoc, about:blank, blob:, data:). Under the app
 *     policy, which has no 'unsafe-inline', the sandbox's own bootstrap script
 *     is refused and nothing in the frame ever runs. Verified in Chrome.
 *
 *   - A frame loaded from a real http(s) URL does NOT inherit. It is governed
 *     by the CSP on its own response, which is why the sandbox is served from
 *     /sandbox rather than embedded as srcdoc.
 *
 * Inside the sandbox, `'self'` is useless. `sandbox="allow-scripts"` without
 * `allow-same-origin` gives the frame an opaque origin, and `'self'` resolves
 * against that opaque origin, so it matches nothing — not even documents from
 * the very origin that served the frame. The app origin is therefore named
 * explicitly in the sandbox policy.
 */

/** Policy for the application's own pages. */
export function appCsp() {
  return [
    "default-src 'self'",
    // unsafe-eval: Monaco's workers compile with it.
    "script-src 'self' 'unsafe-eval' blob:",
    // unsafe-inline: Next.js injects critical CSS inline.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // The execution sandbox is same-origin (/sandbox), so 'self' covers it.
    "frame-src 'self' blob:",
    "connect-src 'self' https://*.supabase.co",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Policy for the execution sandbox document.
 *
 * `origin` must be the absolute app origin (scheme://host[:port]) — see the
 * note above about `'self'` being meaningless in an opaque origin.
 *
 * `connect-src` naming the app origin is what lets Pyodide fetch its wasm and
 * stdlib from /pyodide. It does NOT open a path to the API: a request from an
 * opaque origin is cross-origin, so it still needs the server to return CORS
 * headers, and only the static /pyodide assets do.
 */
export function sandboxCsp(origin) {
  return [
    "default-src 'none'",
    // unsafe-inline: the sandbox bootstrap is inline by design — it must not be
    // a separate request the learner's code could race or intercept.
    // unsafe-eval: `new Function` for the web runtime, and Pyodide's wasm.
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}`,
    `connect-src ${origin}`,
    `worker-src ${origin} blob:`,
    "style-src 'unsafe-inline'",
    "img-src data:",
  ].join('; ');
}
