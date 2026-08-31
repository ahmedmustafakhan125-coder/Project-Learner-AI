/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship as TypeScript source within the workspace.
  transpilePackages: ['@ai-edu/core', '@ai-edu/api-client', '@ai-edu/llm', '@ai-edu/runners'],

  async headers() {
    return [
      // The page CSP is NOT set here. It carries a per-request nonce, which a
      // static header cannot express, so middleware.ts owns it. The sandbox
      // sets its own in app/sandbox/route.ts.
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
