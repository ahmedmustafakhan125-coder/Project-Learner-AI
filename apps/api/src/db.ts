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
 * Checked BEFORE a provider call, not after. Checking afterwards would let a
 * single expensive request blow through the ceiling with nothing to stop it.
 */
export async function checkBudget(userId: string): Promise<BudgetStatus> {
  const env = loadEnv();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db()
    .from('llm_usage')
    .select('cost_usd, unpriced')
    .eq('user_id', userId)
    .gte('created_at', since);

  if (error) {
    // Fail open. A metrics outage should not lock every learner out of the
    // product; the ceiling is a cost guard, not a security control.
    console.error('[budget] check failed, allowing request:', error.message);
    return { spentUSD: 0, limitUSD: env.DAILY_USD_BUDGET_PER_USER, exceeded: false, hasUnpricedUsage: false };
  }

  const rows = data ?? [];
  const spentUSD = rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);

  return {
    spentUSD,
    limitUSD: env.DAILY_USD_BUDGET_PER_USER,
    exceeded: spentUSD >= env.DAILY_USD_BUDGET_PER_USER,
    hasUnpricedUsage: rows.some((row) => row.unpriced === true),
  };
}
