import { appCsp } from './lib/csp.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship as TypeScript source within the workspace.
  transpilePackages: ['@ai-edu/core', '@ai-edu/api-client', '@ai-edu/llm', '@ai-edu/runners'],

  async headers() {
    return [
      {
        // The sandbox sets its own, much tighter policy in app/sandbox/route.ts.
        // Matching it here too would override that, so /sandbox is excluded.
        source: '/((?!sandbox).*)',
        headers: [{ key: 'Content-Security-Policy', value: appCsp() }],
      },
      {
        // Pyodide's wasm and stdlib are fetched BY the sandbox frame, which has
        // an opaque origin. That makes the request cross-origin even though the
        // bytes come from this same server, so it needs CORS to be readable.
        //
        // This exposes only static runtime assets. It is not a path to the API:
        // nothing else on this origin sends these headers.
        source: '/pyodide/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/monaco/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
