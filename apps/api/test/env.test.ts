import { afterEach, describe, expect, it } from 'vitest';

import { loadEnv, projectStudioBootProblem, resetEnvCache } from '../src/env.js';

/**
 * The Project Studio flags (docs/project-studio.md §4).
 *
 * The flag defaults off, and with it off nothing about boot changes: deploying
 * this code must not take down a live API that has no Anthropic key yet.
 */

const BASE = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
} as NodeJS.ProcessEnv;

afterEach(() => resetEnvCache());

function load(extra: Record<string, string> = {}) {
  resetEnvCache();
  return loadEnv({ ...BASE, ...extra });
}

describe('Project Studio env', () => {
  it('defaults the flag off, the fallback to fail and the weekly allowance to $5', () => {
    const env = load();
    expect(env.PROJECT_STUDIO).toBe('off');
    expect(env.PROJECT_GEN_FALLBACK).toBe('fail');
    expect(env.PROJECT_USD_BUDGET_PER_USER_PER_WEEK).toBe(5);
  });

  it('accepts the flag on and a chain fallback in development', () => {
    const env = load({ PROJECT_STUDIO: 'on', PROJECT_GEN_FALLBACK: 'chain' });
    expect(env.PROJECT_STUDIO).toBe('on');
    expect(env.PROJECT_GEN_FALLBACK).toBe('chain');
  });

  it('refuses the chain fallback in production', () => {
    expect(() => load({ NODE_ENV: 'production', PROJECT_GEN_FALLBACK: 'chain' })).toThrow(
      /PROJECT_GEN_FALLBACK/,
    );
  });

  it('rejects a flag value that is neither on nor off', () => {
    expect(() => load({ PROJECT_STUDIO: 'yes' })).toThrow(/PROJECT_STUDIO/);
  });
});

describe('projectStudioBootProblem', () => {
  it('fails production boot with the flag on and no Anthropic key', () => {
    const env = load({ NODE_ENV: 'production', PROJECT_STUDIO: 'on' });
    expect(projectStudioBootProblem(env, {})).toMatch(/ANTHROPIC_API_KEY/);
    expect(projectStudioBootProblem(env, { ANTHROPIC_API_KEY: '  ' })).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('passes production boot with the flag on and a key', () => {
    const env = load({ NODE_ENV: 'production', PROJECT_STUDIO: 'on' });
    expect(projectStudioBootProblem(env, { ANTHROPIC_API_KEY: 'sk-test' })).toBeNull();
  });

  it('leaves boot unchanged with the flag off, even in production with no key', () => {
    const env = load({ NODE_ENV: 'production' });
    expect(projectStudioBootProblem(env, {})).toBeNull();
  });

  it('does not fail development boot with the flag on and no key', () => {
    const env = load({ PROJECT_STUDIO: 'on' });
    expect(projectStudioBootProblem(env, {})).toBeNull();
  });
});
