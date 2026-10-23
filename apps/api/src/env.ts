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

/**
 * The role a Supabase key acts as, when the key says: `anon` for a publishable
 * key, `service_role` for a secret key, the `role` claim for a JWT key. Null
 * for anything else, such as a test placeholder.
 */
export function supabaseKeyRole(key: string): string | null {
  if (key.startsWith('sb_publishable_')) return 'anon';
  if (key.startsWith('sb_secret_')) return 'service_role';
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  SUPABASE_URL: z.string().url('SUPABASE_URL must be a URL — run `npm run db:start`'),
  /*
   * The API writes only through this key, so an anon or publishable key here
   * boots fine, reads come back empty and every write fails Row Level
   * Security. Refuse it at boot instead.
   */
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required')
    .refine(
      (key) => {
        const role = supabaseKeyRole(key);
        return role === null || role === 'service_role';
      },
      (key) => ({
        message:
          `SUPABASE_SERVICE_ROLE_KEY acts as ${supabaseKeyRole(key)}, not service_role, so every write would fail Row ` +
          'Level Security. Use the service_role key (or the sb_secret_ key) that `npm run db:start` prints.',
      }),
    ),

  DAILY_USD_BUDGET_PER_USER: z.coerce.number().positive().default(2),

  /*
   * Project Learner (docs/project-learner.md §4). Off by default, and everything
   * it adds sits behind it: with the flag off the app behaves as it did.
   *
   * PROJECT_GEN_FALLBACK=chain lets a contributor with only a Gemini key run
   * project generation on Flash in development. It is refused in production,
   * where a project route with no Claude key must say so, not quietly run on
   * another model.
   */
  PROJECT_LEARNER: z.enum(['on', 'off']).default('off'),
  PROJECT_GEN_FALLBACK: z.enum(['fail', 'chain']).default('fail'),
  /** Spend on `project:*` tasks over seven days. About three T3 projects. */
  PROJECT_USD_BUDGET_PER_USER_PER_WEEK: z.coerce.number().positive().default(5),
}).refine((env) => !(env.NODE_ENV === 'production' && env.PROJECT_GEN_FALLBACK === 'chain'), {
  path: ['PROJECT_GEN_FALLBACK'],
  message: 'chain is development-only; project generation never falls back in production',
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Why boot must stop, or null when it may go on.
 *
 * Only production with the flag on and no Anthropic key fails: every project
 * route would be dead on arrival. With the flag off this returns null whatever
 * the keys, so this code can be deployed before the Render service has a key.
 * Development boots either way and logs the gap instead.
 */
export function projectLearnerBootProblem(
  env: Env,
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== 'production' || env.PROJECT_LEARNER !== 'on') return null;
  if (source['ANTHROPIC_API_KEY']?.trim()) return null;
  return (
    'PROJECT_LEARNER=on needs ANTHROPIC_API_KEY: project generation runs on Claude and has no ' +
    'fallback in production. Set the key, or set PROJECT_LEARNER=off.'
  );
}

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
