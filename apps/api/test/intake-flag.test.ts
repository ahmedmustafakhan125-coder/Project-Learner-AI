import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '../src/env.js';
import { buildServer } from '../src/server.js';

/**
 * Everything Project Learner adds sits behind PROJECT_LEARNER: with the flag
 * off the intake routes do not exist at all, and /api/features says so.
 */

beforeEach(() => {
  process.env['SUPABASE_URL'] = 'http://127.0.0.1:54321';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role';
});

afterEach(() => {
  delete process.env['PROJECT_LEARNER'];
  resetEnvCache();
});

async function serverWith(flag: 'on' | 'off') {
  process.env['PROJECT_LEARNER'] = flag;
  resetEnvCache();
  return buildServer();
}

describe('PROJECT_LEARNER gates the intake routes', () => {
  it('has no intake routes with the flag off', async () => {
    const app = await serverWith('off');
    expect((await app.inject({ method: 'POST', url: '/api/projects/intake', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/features' })).json()).toEqual({ projectLearner: false });
    await app.close();
  });

  it('registers them, behind auth, with the flag on', async () => {
    const app = await serverWith('on');
    expect((await app.inject({ method: 'POST', url: '/api/projects/intake', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/features' })).json()).toEqual({ projectLearner: true });
    await app.close();
  });

  it('lets the browser send PATCH for the scope chips', async () => {
    const app = await serverWith('on');
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects/intake/x/scope',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PATCH' },
    });
    expect(preflight.headers['access-control-allow-methods']).toContain('PATCH');
    await app.close();
  });
});
