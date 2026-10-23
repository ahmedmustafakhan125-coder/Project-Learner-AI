import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Budget scopes (docs/project-studio.md §11).
 *
 * With PROJECT_STUDIO on, `project:*` rows count against a weekly project
 * allowance and everything else against the daily Q&A one, so a learner who
 * spends their projects cannot lose their questions. With it off, every row
 * counts against the daily allowance, as before.
 */

const state = vi.hoisted(() => ({
  filters: [] as Array<[string, ...unknown[]]>,
  rows: [] as Array<{ cost_usd: number | null; unpriced: boolean }>,
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'gte', 'like', 'not']) {
        chain[name] = (...args: unknown[]) => {
          state.filters.push([name, ...args]);
          return chain;
        };
      }
      chain['insert'] = async (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return { error: null };
      };
      chain['then'] = (resolve: (value: unknown) => unknown) =>
        resolve({ data: state.rows, error: null });
      return chain;
    },
  }),
}));

const { checkBudget, recordUsage } = await import('../src/db.js');
const { resetEnvCache } = await import('../src/env.js');

function setEnv(extra: Record<string, string>) {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    DAILY_USD_BUDGET_PER_USER: '2',
    PROJECT_USD_BUDGET_PER_USER_PER_WEEK: '5',
    ...extra,
  });
  resetEnvCache();
}

const since = () => state.filters.find((f) => f[0] === 'gte')?.[2] as string;
const ageHours = (iso: string) => (Date.now() - Date.parse(iso)) / 3_600_000;

beforeEach(() => {
  state.filters = [];
  state.rows = [{ cost_usd: 1.5, unpriced: false }, { cost_usd: 1, unpriced: false }];
  state.inserted = [];
});

afterEach(() => {
  delete process.env['PROJECT_STUDIO'];
  resetEnvCache();
});

describe('checkBudget with PROJECT_STUDIO on', () => {
  beforeEach(() => setEnv({ PROJECT_STUDIO: 'on' }));

  it('counts project:* rows over seven days against the weekly allowance', async () => {
    const status = await checkBudget('u1', 'project');
    expect(state.filters).toContainEqual(['like', 'task', 'project:%']);
    expect(ageHours(since())).toBeCloseTo(24 * 7, 0);
    expect(status).toMatchObject({ spentUSD: 2.5, limitUSD: 5, exceeded: false });
  });

  it('leaves project rows out of the daily Q&A allowance', async () => {
    const status = await checkBudget('u1');
    expect(state.filters).toContainEqual(['not', 'task', 'like', 'project:%']);
    expect(ageHours(since())).toBeCloseTo(24, 0);
    expect(status).toMatchObject({ spentUSD: 2.5, limitUSD: 2, exceeded: true });
  });
});

describe('checkBudget with PROJECT_STUDIO off', () => {
  beforeEach(() => setEnv({ PROJECT_STUDIO: 'off' }));

  it('counts every row over a day against the daily allowance, whatever the scope', async () => {
    for (const scope of ['qa', 'project'] as const) {
      state.filters = [];
      const status = await checkBudget('u1', scope);
      expect(state.filters.some((f) => f[0] === 'like' || f[0] === 'not')).toBe(false);
      expect(ageHours(since())).toBeCloseTo(24, 0);
      expect(status.limitUSD).toBe(2);
    }
  });
});

describe('recordUsage', () => {
  beforeEach(() => setEnv({}));

  const base = {
    userId: 'u1',
    task: 'project:research',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
  };

  it('writes web_searches when the call ran searches', async () => {
    await recordUsage({
      ...base,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 3 },
    });
    expect(state.inserted[0]).toMatchObject({ web_searches: 3 });
  });

  it('leaves the column out otherwise, so it works before 0015 is applied', async () => {
    await recordUsage({
      ...base,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(state.inserted[0]).not.toHaveProperty('web_searches');
  });
});
