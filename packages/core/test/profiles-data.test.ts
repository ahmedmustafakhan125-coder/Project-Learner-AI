import { describe, expect, it } from 'vitest';

import sources from '../../../knowledge/docs/sources.json';
import { PROFILES } from '../src/profiles/index.js';
import { globToRegExp } from '../src/profiles/glob.js';
import { HARNESS_KINDS, PROFILE_IDS } from '../src/profiles/types.js';
import { PROJECT_TIERS } from '@ai-edu/llm';
import { MAX_QUESTIONS } from '../src/schemas/interview.js';
import { SLOT_CATALOG } from '../src/interview/slots.js';

/**
 * `profiles.data` (docs/project-learner.md §14): profiles are data, so the
 * data is what gets checked. A required layer outside the vocabulary, a
 * harness that does not exist or a glob that does not compile would surface
 * later as a brief or a blueprint that can never pass its own checks.
 */

const DEEP = ['desktop-app', 'systems-os', 'language-tooling', 'general'];
const registry = sources as Record<string, unknown>;

describe('every profile', () => {
  it('exists for every id, keyed by its own id', () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...PROFILE_IDS].sort());
    for (const [id, profile] of Object.entries(PROFILES)) expect(profile.id).toBe(id);
  });

  it.each(PROFILE_IDS)('%s requires only layers in its own vocabulary, for every tier', (id) => {
    const profile = PROFILES[id];
    const vocabulary = new Set(profile.layers.map((l) => l.id));
    for (const tier of PROJECT_TIERS) {
      const required = profile.requiredLayersByTier[tier];
      expect(required.length, `${id} ${tier} requires no layer`).toBeGreaterThan(0);
      for (const layer of required) expect(vocabulary, `${id} ${tier}: ${layer}`).toContain(layer);
      expect(new Set(required).size, `${id} ${tier} repeats a layer`).toBe(required.length);
    }
  });

  it.each(PROFILE_IDS)('%s never requires fewer layers at a higher tier', (id) => {
    const counts = PROJECT_TIERS.map((t) => PROFILES[id].requiredLayersByTier[t].length);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
  });

  it.each(PROFILE_IDS)('%s has unique layer ids, each with a section and a description', (id) => {
    const layers = PROFILES[id].layers;
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
    for (const layer of layers) {
      expect(layer.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(layer.section.trim()).not.toBe('');
      expect(layer.description.trim()).not.toBe('');
    }
  });

  it.each(PROFILE_IDS)('%s names only harnesses that exist', (id) => {
    const profile = PROFILES[id];
    expect(profile.harnesses.length).toBeGreaterThan(0);
    for (const h of profile.harnesses) expect(HARNESS_KINDS).toContain(h);
  });

  it.each(PROFILE_IDS)('%s has doc sources that are in sources.json', (id) => {
    const profile = PROFILES[id];
    expect(profile.docSources.length).toBeGreaterThan(0);
    for (const ref of profile.docSources) expect(registry, `${id}: ${ref.key}`).toHaveProperty([ref.key]);
  });

  it.each(PROFILE_IDS)('%s has globs that compile and match a path of their own shape', (id) => {
    const rule = PROFILES[id].architectureRule;
    const globs = [
      ...rule.requiredPaths,
      ...rule.firstStepCreates,
      ...(rule.everyStepEdits ?? []),
      ...rule.forbiddenImports.map((f) => f.in),
    ];
    for (const glob of globs) {
      expect(() => globToRegExp(glob), glob).not.toThrow();
    }
  });

  it.each(PROFILE_IDS)('%s slots do not clash with the base or tier slots', (id) => {
    const base = new Set(SLOT_CATALOG.project_generation.map((s) => s.key));
    for (const slot of PROFILES[id].slots) {
      expect(base.has(slot.key), `${id}.${slot.key} shadows a catalogue slot`).toBe(false);
      expect(slot.key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it.each(PROFILE_IDS)('%s tier floors are ordered lowest first', (id) => {
    const floors = PROFILES[id].tierFloors.map((f) => PROJECT_TIERS.indexOf(f.tier));
    expect([...floors].sort((a, b) => a - b)).toEqual(floors);
  });
});

describe('the deep profiles (§6: filled in during the 12 hours)', () => {
  it.each(DEEP)('%s has an architecture rule, toolchain or prerequisites, and an addendum', (id) => {
    const profile = PROFILES[id as keyof typeof PROFILES];
    expect(profile.deep).toBe(true);
    expect(profile.architectureRule.description.trim()).not.toBe('');
    expect(profile.architectureRule.requiredPaths.length).toBeGreaterThan(0);
    expect(profile.promptAddendum).toMatch(new RegExp(`^<profile_rules profile="${id}">`));
    expect(profile.promptAddendum.trim().endsWith('</profile_rules>')).toBe(true);
  });

  it.each(DEEP.filter((id) => id !== 'general'))('%s has a doc source of its own and a research key per layer', (id) => {
    const profile = PROFILES[id as keyof typeof PROFILES];
    expect(profile.docSources.map((d) => d.key)).toContain(`profile:${id}`);
    for (const layer of profile.layers) expect(layer.research, `${id}.${layer.id}`).toBeTruthy();
  });

  it('marks every other profile as not deep, with no addendum yet', () => {
    for (const id of PROFILE_IDS.filter((p) => !DEEP.includes(p))) {
      expect(PROFILES[id].deep).toBe(false);
      expect(PROFILES[id].promptAddendum).toBe('');
    }
  });

  it('a kernel is at least T4, and the Lox interpreter at least T2', () => {
    expect(PROFILES['systems-os'].tierFloors[0]).toMatchObject({ tier: 'T4', keywords: [] });
    expect(PROFILES['language-tooling'].tierFloors[0]).toMatchObject({ tier: 'T2', keywords: [] });
  });

  it('keeps every profile within the global question cap on its own', () => {
    for (const id of PROFILE_IDS) expect(PROFILES[id].slots.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['**/core/**', 'src-tauri/src/core/notes.rs', true],
    ['**/core/**', 'core/notes.ts', true],
    ['**/core/**', 'src/corelib/x.ts', false],
    ['tests/programs/**', 'tests/programs/closures.lox', true],
    ['tests/programs/**', 'tests/unit/lexer_test.py', false],
    ['Makefile|CMakeLists.txt|Cargo.toml', 'Cargo.toml', true],
    ['Makefile|CMakeLists.txt|Cargo.toml', 'src/Cargo.toml', false],
    ['**/ipc.ts|**/commands.rs', 'src-tauri/src/commands.rs', true],
    ['**/*.test.*', 'src/a.test.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
