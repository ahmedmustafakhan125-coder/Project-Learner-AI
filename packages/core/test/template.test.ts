import { describe, expect, it } from 'vitest';

import {
  SIMILARITY_FLOOR,
  canReuseFirstStep,
  fingerprintRequest,
  pickTemplate,
  requestSimilarity,
} from '../src/generation/template.js';
import { PROFILES } from '../src/profiles/index.js';
import type { CompiledQuery } from '../src/schemas/interview.js';
import type { StepStub } from '../src/schemas/project.js';

/** Template reuse: only a very similar request on the same stack is adapted. */

const compiled = (query: string, slots: Record<string, string> = {}): CompiledQuery => ({
  intent: 'project_generation',
  originalQuery: query,
  text: `<learner_question>${query}</learner_question>`,
  slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { value: v, source: 'query' as const }])),
  attachments: [],
  partial: false,
});

const desktop = PROFILES['desktop-app'];
const fp = (query: string, slots: Record<string, string> = {}, tier: 'T2' | 'T3' = 'T3') =>
  fingerprintRequest(compiled(query, slots), desktop, tier);

describe('requestSimilarity', () => {
  it('matches the same request worded a little differently', () => {
    const a = fp('A Tauri notes app', { tech: 'Tauri' });
    const b = fp('I want to build a notes app in Tauri', { tech: 'Tauri' });
    expect(requestSimilarity(a, b)).toBeGreaterThanOrEqual(SIMILARITY_FLOOR);
  });

  it('ignores the time and level a learner has', () => {
    const a = fp('A Tauri notes app', { tech: 'Tauri', time_budget: '10 hours' });
    const b = fp('A Tauri notes app', { tech: 'Tauri', time_budget: 'a weekend', skill_level: 'advanced' });
    expect(requestSimilarity(a, b)).toBe(1);
  });

  it('refuses a different technology, tier or profile outright', () => {
    const a = fp('A notes app', { tech: 'Tauri' });
    expect(requestSimilarity(a, fp('A notes app', { tech: 'Electron' }))).toBe(0);
    expect(requestSimilarity(a, fp('A notes app', { tech: 'Tauri' }, 'T2'))).toBe(0);
    expect(requestSimilarity(a, fingerprintRequest(compiled('A notes app', { tech: 'Tauri' }), PROFILES.general, 'T3'))).toBe(0);
  });

  it('keeps different projects on the same stack apart', () => {
    const a = fp('A Tauri notes app', { tech: 'Tauri' });
    const b = fp('A Tauri music player with playlists', { tech: 'Tauri' });
    expect(requestSimilarity(a, b)).toBeLessThan(SIMILARITY_FLOOR);
  });
});

describe('pickTemplate', () => {
  it('takes the closest match above the floor, the newest on a tie, or nothing', () => {
    const want = fp('A Tauri notes app', { tech: 'Tauri' });
    const candidates = [
      { fingerprint: fp('A Tauri notes app', { tech: 'Tauri' }), value: 'newest' },
      { fingerprint: fp('A Tauri notes app', { tech: 'Tauri' }), value: 'older' },
      { fingerprint: fp('A Tauri music player', { tech: 'Tauri' }), value: 'other' },
    ];
    expect(pickTemplate(want, candidates)?.value).toBe('newest');
    expect(pickTemplate(want, candidates.slice(2))).toBeNull();
  });
});

describe('canReuseFirstStep', () => {
  const s = (title: string, creates: string[]): StepStub => ({ title, objective: 'o', concepts: [], estMinutes: 30, creates, edits: [] });
  const bp = (steps: StepStub[], files = ['a.rs', 'b.rs']) => ({ finalFileTree: files.map((path) => ({ path })), steps });

  it('reuses step 1 only when step 1, step 2 and the file plan are unchanged', () => {
    const template = bp([s('One', ['a.rs']), s('Two', ['b.rs']), s('Three', [])]);
    expect(canReuseFirstStep(bp([s('One', ['a.rs']), s('Two', ['b.rs']), s('Changed', [])]), template)).toBe(true);
    expect(canReuseFirstStep(bp([s('One!', ['a.rs']), s('Two', ['b.rs'])]), template)).toBe(false);
    expect(canReuseFirstStep(bp([s('One', ['a.rs']), s('Two?', ['b.rs'])]), template)).toBe(false);
    expect(canReuseFirstStep(bp([s('One', ['a.rs']), s('Two', ['b.rs'])], ['a.rs', 'c.rs']), template)).toBe(false);
  });
});
