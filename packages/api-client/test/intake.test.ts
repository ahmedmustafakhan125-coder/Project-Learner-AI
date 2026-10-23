import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../src/client.js';

/**
 * The intake methods (docs/project-learner.md §12): each hits its route with
 * its method, and creating a project sends the intake id and nothing else,
 * so nothing the project is built from comes from the browser.
 */

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const client = new ApiClient({ baseUrl: 'http://api.test/', getToken: async () => 't' });
const ID = '00000000-0000-4000-8000-000000000001';

describe('intake methods', () => {
  it.each([
    ['getFeatures', () => client.getFeatures(), 'GET', '/api/features'],
    ['createIntake', () => client.createIntake({ intent: 'project_generation', originalQuery: 'q', text: 'q', slots: {}, attachments: [], partial: false }), 'POST', '/api/projects/intake'],
    ['updateIntakeScope', () => client.updateIntakeScope(ID, { tierStep: 1 }), 'PATCH', `/api/projects/intake/${ID}/scope`],
    ['researchIntake', () => client.researchIntake(ID), 'POST', `/api/projects/intake/${ID}/research`],
    ['generateStackBrief', () => client.generateStackBrief(ID), 'POST', `/api/projects/intake/${ID}/stack-brief`],
    ['approveStackBrief', () => client.approveStackBrief(ID), 'POST', `/api/projects/intake/${ID}/stack-brief/approve`],
    ['generateIntakeBlueprint', () => client.generateIntakeBlueprint(ID), 'POST', `/api/projects/intake/${ID}/blueprint`],
    ['getProjectStack', () => client.getProjectStack(ID), 'GET', `/api/projects/${ID}/stack`],
  ] as const)('%s', async (_name, call, method, path) => {
    await call();
    expect(calls[0]!.url).toBe(`http://api.test${path}`);
    expect(calls[0]!.init.method).toBe(method);
  });

  it('creates a project from the intake id alone', async () => {
    await client.createProjectFromIntake(ID);
    expect(calls[0]!.url).toBe('http://api.test/api/projects');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ intakeId: ID });
  });
});
