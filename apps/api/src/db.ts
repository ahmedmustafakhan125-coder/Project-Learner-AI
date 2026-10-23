import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeCost } from '@ai-edu/llm';
import type { LLMUsage } from '@ai-edu/llm';

import { loadEnv } from './env.js';

/**
 * Database access.
 *
 * This client uses the service-role key and therefore BYPASSES Row Level
 * Security. It must never be exposed to the browser, and every query made
 * through it must filter by user_id explicitly — the database will not do it
 * for us here. RLS remains the backstop for anything reaching Postgres with the
 * anon key.
 */

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const env = loadEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/* ------------------------------------------------------------------ *
 * Usage accounting
 * ------------------------------------------------------------------ */

export interface RecordUsageArgs {
  userId: string;
  task: string;
  provider: string;
  model: string;
  usage: LLMUsage;
  latencyMs?: number;
}

/**
 * Cost is derived from the registry, not passed in, so a caller cannot report a
 * figure that disagrees with the price table. Unpriced models record `null` —
 * never `0`, which would read as "free" and silently defeat the budget check.
 *
 * Never throws: losing an accounting row is bad, but failing a learner's answer
 * because a metrics insert hiccuped is worse.
 */
export async function recordUsage(args: RecordUsageArgs): Promise<void> {
  const cost = computeCost(args.model, args.usage);

  const { error } = await db().from('llm_usage').insert({
    user_id: args.userId,
    task: args.task,
    provider: args.provider,
    model: args.model,
    input_tokens: args.usage.inputTokens,
    output_tokens: args.usage.outputTokens,
    cache_read_tokens: args.usage.cacheReadTokens,
    cache_write_tokens: args.usage.cacheWriteTokens,
    cost_usd: cost.totalUSD,
    unpriced: cost.unpriced,
    latency_ms: args.latencyMs ?? null,
    // Only when there were searches: the column arrives with migration 0015,
    // and a row naming it on a database without it would be lost entirely.
    ...(args.usage.webSearchRequests ? { web_searches: args.usage.webSearchRequests } : {}),
  });

  if (error) {
    console.error('[usage] failed to record:', error.message);
  }
}

/* ------------------------------------------------------------------ *
 * Budget
 * ------------------------------------------------------------------ */

export interface BudgetStatus {
  spentUSD: number;
  limitUSD: number;
  exceeded: boolean;
  /**
   * True when some of today's calls ran on models with unverified pricing, so
   * `spentUSD` understates reality. Surfaced rather than hidden — a budget that
   * silently ignores part of the spend is worse than one that admits the gap.
   */
  hasUnpricedUsage: boolean;
}

/**
 * Which allowance a call draws on.
 *
 * With PROJECT_LEARNER on, rows whose task starts `project:` count against a
 * weekly project allowance and everything else against the daily Q&A one, so
 * a learner who spends their projects still has their questions. With it off,
 * every row counts against the daily allowance, whatever the scope, as before.
 */
export type BudgetScope = 'qa' | 'project';

const PROJECT_TASKS = 'project:%';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checked BEFORE a provider call, not after. Checking afterwards would let a
 * single expensive request blow through the ceiling with nothing to stop it.
 */
export async function checkBudget(userId: string, scope: BudgetScope = 'qa'): Promise<BudgetStatus> {
  const env = loadEnv();
  const scoped = env.PROJECT_LEARNER === 'on';
  const project = scoped && scope === 'project';
  const limitUSD = project ? env.PROJECT_USD_BUDGET_PER_USER_PER_WEEK : env.DAILY_USD_BUDGET_PER_USER;
  const since = new Date(Date.now() - (project ? 7 * DAY_MS : DAY_MS)).toISOString();

  let query = db()
    .from('llm_usage')
    .select('cost_usd, unpriced')
    .eq('user_id', userId)
    .gte('created_at', since);
  if (scoped) {
    query = project ? query.like('task', PROJECT_TASKS) : query.not('task', 'like', PROJECT_TASKS);
  }
  const { data, error } = await query;

  if (error) {
    // Fail open. A metrics outage should not lock every learner out of the
    // product; the ceiling is a cost guard, not a security control.
    console.error('[budget] check failed, allowing request:', error.message);
    return { spentUSD: 0, limitUSD, exceeded: false, hasUnpricedUsage: false };
  }

  const rows = data ?? [];
  const spentUSD = rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);

  return {
    spentUSD,
    limitUSD,
    exceeded: spentUSD >= limitUSD,
    hasUnpricedUsage: rows.some((row) => row.unpriced === true),
  };
}
