/**
 * P0 exit criterion.
 *
 * Sends one trivial structured request through EVERY configured provider,
 * validates the reply against a Zod schema, prices it from the registry, and
 * writes a row to llm_usage. If this passes, the provider layer works and the
 * rest of the app can be built on top of it.
 *
 *   npm run smoke
 *
 * Providers with no API key are skipped, so this is safe to run with only one
 * vendor configured.
 */

import { z } from 'zod';
import {
  computeCost,
  createProvider,
  listAvailableModels,
  listModels,
  registryReport,
} from '@ai-edu/llm';

const Schema = z.object({
  ok: z.boolean(),
  language: z.string(),
});

const PROMPT =
  'Reply with a JSON object having ok=true and language set to the name of the ' +
  'programming language that uses the .rs file extension.';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (s) => `${c.green}PASS${c.reset} ${s}`;
const bad = (s) => `${c.red}FAIL${c.reset} ${s}`;
const warn = (s) => `${c.yellow}WARN${c.reset} ${s}`;

/* ------------------------------------------------------------------ */

function printRegistry() {
  const report = registryReport();
  console.log(`${c.bold}Registry${c.reset}`);
  console.log(`  configured   : ${report.configured.join(', ') || c.dim + '(none)' + c.reset}`);
  console.log(`  unconfigured : ${c.dim}${report.unconfigured.join(', ') || '(none)'}${c.reset}`);

  if (report.unverifiedPricing.length) {
    console.log(
      '  ' +
        warn(
          `unverified pricing: ${report.unverifiedPricing.join(', ')}\n` +
            `       These models work, but cost is recorded as null and cannot count\n` +
            `       against a budget. Fill pricing in packages/llm/src/registry.ts and\n` +
            `       stamp verifiedOn.`,
        ),
    );
  }
  console.log();
}

async function smokeModel(model) {
  const label = `${model.id} ${c.dim}(${model.vendor})${c.reset}`;
  const started = Date.now();

  try {
    const provider = createProvider(model.id);
    const result = await provider.structured(
      {
        model: model.id,
        maxTokens: 512,
        reasoning: 'none',
        messages: [{ role: 'user', content: PROMPT }],
      },
      Schema,
    );

    const elapsed = Date.now() - started;

    if (result.data.ok !== true) {
      console.log(bad(`${label} — returned ok=${result.data.ok}`));
      return null;
    }
    if (!/rust/i.test(result.data.language)) {
      console.log(warn(`${label} — schema valid but answered '${result.data.language}'`));
    }

    const cost = computeCost(model.id, result.usage);
    const priceStr =
      cost.totalUSD === null
        ? `${c.yellow}unpriced${c.reset}`
        : `$${cost.totalUSD.toFixed(6)}`;

    console.log(
      ok(
        `${label} — strategy=${result.strategy}` +
          `${result.repaired ? ' (repaired)' : ''} ` +
          `${c.dim}${elapsed}ms, ${result.usage.inputTokens}in/${result.usage.outputTokens}out, ${priceStr}${c.reset}`,
      ),
    );

    return { model, usage: result.usage, cost, elapsed, provider: provider.id };
  } catch (err) {
    console.log(bad(`${label} — ${err?.constructor?.name}: ${err?.message}`));
    return null;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Proves the accounting path end to end: a real row, written through the
 * service-role client, read back, then cleaned up.
 */
async function recordUsage(results) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log(
      warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping the llm_usage check.'),
    );
    console.log(`     ${c.dim}Run 'npm run db:start' and copy the printed keys into .env${c.reset}`);
    return true;
  }

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });

  let userId;
  try {
    const email = `smoke-${Date.now()}@example.test`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user.id;
  } catch (err) {
    console.log(bad(`could not create a test user: ${err.message}`));
    return false;
  }

  try {
    const rows = results.map((r) => ({
      user_id: userId,
      task: 'smoke',
      provider: r.provider,
      model: r.model.id,
      input_tokens: r.usage.inputTokens,
      output_tokens: r.usage.outputTokens,
      cache_read_tokens: r.usage.cacheReadTokens,
      cache_write_tokens: r.usage.cacheWriteTokens,
      cost_usd: r.cost.totalUSD,
      unpriced: r.cost.unpriced,
      latency_ms: r.elapsed,
    }));

    const { error: insertError } = await db.from('llm_usage').insert(rows);
    if (insertError) throw insertError;

    const { data: readBack, error: readError } = await db
      .from('llm_usage')
      .select('model, cost_usd, unpriced')
      .eq('user_id', userId);
    if (readError) throw readError;

    if (readBack.length !== results.length) {
      console.log(bad(`wrote ${results.length} usage rows but read back ${readBack.length}`));
      return false;
    }

    // A priced model must land a real number; an unpriced one must land null,
    // never 0 — a 0 would read downstream as "free".
    for (const row of readBack) {
      const expectUnpriced = results.find((r) => r.model.id === row.model)?.cost.unpriced;
      if (expectUnpriced && row.cost_usd !== null) {
        console.log(bad(`${row.model}: unpriced model recorded cost ${row.cost_usd}, expected null`));
        return false;
      }
      if (!expectUnpriced && !(Number(row.cost_usd) > 0)) {
        console.log(bad(`${row.model}: priced model recorded cost_usd=${row.cost_usd}`));
        return false;
      }
    }

    console.log(ok(`llm_usage — wrote and verified ${readBack.length} row(s)`));
    return true;
  } catch (err) {
    console.log(bad(`llm_usage write failed: ${err.message}`));
    return false;
  } finally {
    await db.auth.admin.deleteUser(userId).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`\n${c.bold}${c.cyan}Provider smoke test${c.reset}\n`);
  printRegistry();

  const available = listAvailableModels();
  if (available.length === 0) {
    console.log(bad('No provider is configured.'));
    console.log(
      `\n  Copy .env.example to .env and set at least one key.\n` +
        `  ${c.dim}Known models: ${listModels().map((m) => m.id).join(', ')}${c.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${c.bold}Round-trip${c.reset}`);
  const results = [];
  for (const model of available) {
    const result = await smokeModel(model);
    if (result) results.push(result);
  }
  console.log();

  const allPassed = results.length === available.length;

  console.log(`${c.bold}Accounting${c.reset}`);
  const recorded = results.length > 0 ? await recordUsage(results) : true;
  console.log();

  if (allPassed && recorded) {
    console.log(`${c.green}${c.bold}P0 exit criterion met${c.reset} — ${results.length}/${available.length} provider(s) round-tripped.\n`);
  } else {
    console.log(`${c.red}${c.bold}P0 exit criterion NOT met${c.reset} — ${results.length}/${available.length} provider(s) passed.\n`);
    process.exitCode = 1;
  }
}

await main();
