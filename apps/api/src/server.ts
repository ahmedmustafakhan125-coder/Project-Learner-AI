import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { listAvailableModels, registryReport } from '@ai-edu/llm';

import { requireAuth, userOf } from './auth.js';
import { checkBudget } from './db.js';
import { loadEnv } from './env.js';
import { registerRateLimit } from './rateLimit.js';
import { agentRoutes } from './routes/agents.js';
import { attemptRoutes } from './routes/attempts.js';
import { attachmentRoutes } from './routes/attachments.js';
import { followUpRoutes } from './routes/followups.js';
import { interviewRoutes } from './routes/interview.js';
import { projectRoutes } from './routes/projects.js';
import { threadRoutes } from './routes/threads.js';

export async function buildServer() {
  const env = loadEnv();

  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'warn' },
    // SSE responses are written directly to the raw socket, so Fastify's own
    // request timeout must not cut a long fan-out short.
    connectionTimeout: 0,
    // Rate limiting falls back to `request.ip` for unauthenticated routes.
    // Without this, every request behind a proxy or load balancer reports the
    // proxy's address and they all share one bucket.
    trustProxy: true,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        cb(null, true);
        return;
      }
      cb(null, origin === env.WEB_ORIGIN);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Cache-Control'],
  });
  await registerRateLimit(app);

  app.get('/health', async () => ({ ok: true }));

  /** Which models this deployment can actually offer, for the picker. */
  app.get('/api/models', { preHandler: requireAuth }, async () => ({
    models: listAvailableModels().map((model) => ({
      id: model.id,
      label: model.label,
      vendor: model.vendor,
      blurb: model.blurb ?? null,
      contextWindow: model.capabilities.maxContext,
      // Surfaced so the UI can mark models whose spend cannot be metered.
      unpriced: model.pricing === null,
    })),
  }));

  app.get('/api/budget', { preHandler: requireAuth }, async (request) =>
    checkBudget(userOf(request).id),
  );

  await app.register(multipart);
  await app.register(attachmentRoutes);
  await app.register(interviewRoutes);
  await app.register(agentRoutes);
  await app.register(followUpRoutes);
  await app.register(attemptRoutes);
  await app.register(projectRoutes);
  await app.register(threadRoutes);

  return app;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();

  const report = registryReport();
  if (report.configured.length === 0) {
    console.error(
      '\n  No LLM provider is configured. Set at least one of ANTHROPIC_API_KEY, ' +
        'OPENAI_API_KEY, DEEPSEEK_API_KEY, or MOONSHOT_API_KEY in .env.\n',
    );
  } else {
    console.log(`  providers: ${report.configured.join(', ')}`);
  }

  // Deliberately loud. Spend on these models records as null cost, so the daily
  // budget silently under-counts until someone fills the pricing in.
  if (report.unverifiedPricing.length > 0) {
    console.warn(
      `  WARNING: unverified pricing for ${report.unverifiedPricing.join(', ')} — ` +
        `usage on these models cannot be counted against the budget. ` +
        `Fill pricing in packages/llm/src/registry.ts.`,
    );
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`  api listening on http://localhost:${env.PORT}\n`);
}

// Only auto-start when run directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
