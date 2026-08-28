/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship as TypeScript source within the workspace.
  transpilePackages: ['@ai-edu/core', '@ai-edu/api-client', '@ai-edu/llm'],

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // unsafe-eval: required by Monaco editor web workers
              // blob:: required for iframe sandbox srcdoc
              "script-src 'self' 'unsafe-eval' blob:",
              // unsafe-inline: Next.js injects critical CSS inline
              "style-src 'self' 'unsafe-inline'",
              // blob:: iframe sandbox srcdoc for the practice agent's exercises
              "frame-src 'self' blob:",
              // cdn.jsdelivr.net: Pyodide runtime
              // *.supabase.co: Supabase API (auth + data)
              "connect-src 'self' https://cdn.jsdelivr.net https://*.supabase.co",
              "img-src 'self' data:",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
