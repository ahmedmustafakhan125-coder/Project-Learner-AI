import { z } from 'zod';

/**
 * Environment validation, run once at startup so a misconfiguration fails
 * immediately and loudly rather than at the first request that needs it.
 *
 * Provider keys are deliberately optional — the platform runs with any one
 * vendor configured, and `packages/llm` already hides models whose key is
 * absent. What is NOT optional is Supabase: without it there is no auth, no
 * persistence, and no budget enforcement.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  SUPABASE_URL: z.string().url('SUPABASE_URL must be a URL — run `npm run db:start`'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  DAILY_USD_BUDGET_PER_USER: z.coerce.number().positive().default(2),

  // The LLM security gateway. Optional so the stack still boots without it, but
  // absent is treated exactly like unreachable: model-bound routes fail closed.
  // See apps/api/src/gateway.ts.
  SECURITY_GATEWAY_URL: z.string().url().optional(),
  SECURITY_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}\n\nCopy .env.example to .env and fill it in.`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: forget the cached env so a different one can be loaded. */
export function resetEnvCache(): void {
  cached = null;
}
