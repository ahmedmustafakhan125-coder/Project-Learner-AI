import { afterEach, describe, expect, it } from 'vitest';

import { loadEnv, projectLearnerBootProblem, resetEnvCache, supabaseKeyRole } from '../src/env.js';

/**
 * The Project Learner flags (docs/project-learner.md §4).
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

describe('Project Learner env', () => {
  it('defaults the flag off, the fallback to fail and the weekly allowance to $5', () => {
    const env = load();
    expect(env.PROJECT_LEARNER).toBe('off');
    expect(env.PROJECT_GEN_FALLBACK).toBe('fail');
    expect(env.PROJECT_USD_BUDGET_PER_USER_PER_WEEK).toBe(5);
  });

  it('accepts the flag on and a chain fallback in development', () => {
    const env = load({ PROJECT_LEARNER: 'on', PROJECT_GEN_FALLBACK: 'chain' });
    expect(env.PROJECT_LEARNER).toBe('on');
    expect(env.PROJECT_GEN_FALLBACK).toBe('chain');
  });

  it('refuses the chain fallback in production', () => {
    expect(() => load({ NODE_ENV: 'production', PROJECT_GEN_FALLBACK: 'chain' })).toThrow(
      /PROJECT_GEN_FALLBACK/,
    );
  });

  it('rejects a flag value that is neither on nor off', () => {
    expect(() => load({ PROJECT_LEARNER: 'yes' })).toThrow(/PROJECT_LEARNER/);
  });
});

describe('projectLearnerBootProblem', () => {
  it('fails production boot with the flag on and no Anthropic key', () => {
    const env = load({ NODE_ENV: 'production', PROJECT_LEARNER: 'on' });
    expect(projectLearnerBootProblem(env, {})).toMatch(/ANTHROPIC_API_KEY/);
    expect(projectLearnerBootProblem(env, { ANTHROPIC_API_KEY: '  ' })).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('passes production boot with the flag on and a key', () => {
    const env = load({ NODE_ENV: 'production', PROJECT_LEARNER: 'on' });
    expect(projectLearnerBootProblem(env, { ANTHROPIC_API_KEY: 'sk-test' })).toBeNull();
  });

  it('leaves boot unchanged with the flag off, even in production with no key', () => {
    const env = load({ NODE_ENV: 'production' });
    expect(projectLearnerBootProblem(env, {})).toBeNull();
  });

  it('does not fail development boot with the flag on and no key', () => {
    const env = load({ PROJECT_LEARNER: 'on' });
    expect(projectLearnerBootProblem(env, {})).toBeNull();
  });
});

/** A JWT-shaped key with the given claims. The signature is never checked here. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

describe('SUPABASE_SERVICE_ROLE_KEY', () => {
  it('reads the role a key acts as', () => {
    expect(supabaseKeyRole(jwt({ role: 'service_role' }))).toBe('service_role');
    expect(supabaseKeyRole(jwt({ role: 'anon' }))).toBe('anon');
    expect(supabaseKeyRole('sb_publishable_abc')).toBe('anon');
    expect(supabaseKeyRole('sb_secret_abc')).toBe('service_role');
    expect(supabaseKeyRole('service-role')).toBeNull();
    expect(supabaseKeyRole('a.not-json.c')).toBeNull();
  });

  it('refuses an anon or publishable key, which would fail every write', () => {
    for (const key of [jwt({ role: 'anon' }), 'sb_publishable_abc']) {
      expect(() => load({ SUPABASE_SERVICE_ROLE_KEY: key })).toThrow(/acts as anon, not service_role/);
    }
  });

  it('accepts a service_role or secret key', () => {
    for (const key of [jwt({ role: 'service_role' }), 'sb_secret_abc']) {
      expect(load({ SUPABASE_SERVICE_ROLE_KEY: key }).SUPABASE_SERVICE_ROLE_KEY).toBe(key);
    }
  });

  it('never puts the key in the error', () => {
    const key = jwt({ role: 'anon', ref: 'unique-marker' });
    expect(() => load({ SUPABASE_SERVICE_ROLE_KEY: key })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(key) }),
    );
  });
});
