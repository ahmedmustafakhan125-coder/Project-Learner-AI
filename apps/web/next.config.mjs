/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship as TypeScript source within the workspace.
  transpilePackages: ['@ai-edu/core', '@ai-edu/api-client', '@ai-edu/llm'],
};

export default nextConfig;
