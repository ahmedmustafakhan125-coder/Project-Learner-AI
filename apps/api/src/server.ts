import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { prepare as prepareScreening } from '@ai-edu/gateway';
import { listPickerModels, registryReport } from '@ai-edu/llm';

import { requireAuth, userOf } from './auth.js';
import { checkBudget } from './db.js';
import { loadEnv, projectLearnerBootProblem } from './env.js';
import { reportScreeningTo } from './gateway.js';
import { registerRateLimit } from './rateLimit.js';
import { agentRoutes } from './routes/agents.js';
import { assessmentRoutes } from './routes/assessment.js';
import { attemptRoutes } from './routes/attempts.js';
import { attachmentRoutes } from './routes/attachments.js';
import { brainRoutes } from './routes/brain.js';
import { followUpRoutes } from './routes/followups.js';
import { interviewRoutes } from './routes/interview.js';
import { projectRoutes } from './routes/projects.js';
import { threadRoutes } from './routes/threads.js';
import { tutorRoutes } from './routes/tutor.js';

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

  // The security gateway's audit trail: one line per screened prompt.
  reportScreeningTo({
    decision: (record) => app.log.info({ screening: record }, 'screening decision'),
    failure: (inputId, err) => app.log.error({ err, inputId }, 'screening failed'),
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Cache-Control'],
  });
  await registerRateLimit(app);

  app.get('/health', async () => ({ ok: true }));

  /** Which models the four-agent workspace offers: Gemini 4 Argon only (`PICKER_MODELS`). */
  app.get('/api/models', { preHandler: requireAuth }, async () => ({
    models: listPickerModels().map((model) => ({
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

  /** What this deployment has switched on, so the web follows the server's flag rather than a copy of it. */
  app.get('/api/features', async () => ({ projectLearner: env.PROJECT_LEARNER === 'on' }));

  await app.register(multipart);
  await app.register(attachmentRoutes);
  await app.register(interviewRoutes);
  await app.register(agentRoutes);
  await app.register(followUpRoutes);
  await app.register(attemptRoutes);
  await app.register(projectRoutes);
  // Project Learner's intake and nav summary exist only with the flag on; off, they are not even loaded.
  if (env.PROJECT_LEARNER === 'on') {
    const { intakeRoutes } = await import('./routes/intake.js');
    await app.register(intakeRoutes);
    const { meRoutes } = await import('./routes/me.js');
    await app.register(meRoutes);
  }
  await app.register(threadRoutes);
  await app.register(tutorRoutes);
  await app.register(brainRoutes);
  await app.register(assessmentRoutes);

  return app;
}

async function main(): Promise<void> {
  const env = loadEnv();
  // Trains and warms up screening before the port opens, so a broken install
  // stops here instead of refusing every question with 422.
  prepareScreening();
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

  const bootProblem = projectLearnerBootProblem(env);
  if (bootProblem) throw new Error(bootProblem);
  if (env.PROJECT_LEARNER === 'on') {
    console.log('  project learner: on');
    // As loud as unpriced models: these projects are not planned by Claude.
    if (env.PROJECT_GEN_FALLBACK === 'chain') {
      console.warn(
        '  WARNING: PROJECT_GEN_FALLBACK=chain — without a Claude key, project generation ' +
          'runs on the conversational chain. Development only.',
      );
    }
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
