import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ComplexityTier, ProfileId, Verification } from '@ai-edu/core';
import { describe, expect, it } from 'vitest';

/**
 * Migration 0015 mirrors the Zod enums, per the convention in 0001. A value
 * added on one side only would be a row the database refuses, or a parse that
 * fails on a row it accepted.
 */

const SQL = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0015_project_studio.sql', import.meta.url)),
  'utf8',
);

function sqlEnum(name: string): string[] {
  const match = SQL.match(new RegExp(`create type ${name}\\s+as enum \\(([^)]*)\\)`, 'i'));
  if (!match) throw new Error(`no enum ${name} in 0015`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('0015 enums mirror the Zod enums', () => {
  it('project_profile', () => expect(sqlEnum('project_profile')).toEqual(ProfileId.options));
  it('complexity_tier', () => expect(sqlEnum('complexity_tier')).toEqual(ComplexityTier.options));
  it('step_verification', () => expect(sqlEnum('step_verification')).toEqual(Verification.options));
  it('intake_status', () =>
    expect(sqlEnum('intake_status')).toEqual(['scoped', 'researched', 'briefed', 'approved', 'abandoned']));
});

describe('0015 keeps writes with the API', () => {
  it('forces RLS on both new tables', () => {
    for (const table of ['project_intakes', 'research_dossiers']) {
      expect(SQL).toContain(`array['project_intakes', 'research_dossiers']`);
      expect(SQL).toMatch(/force row level security/);
      expect(SQL).toContain(table);
    }
  });

  it('gives the browser read access to its own intakes and nothing else', () => {
    expect(SQL).toMatch(/create policy project_intakes_owner_read on project_intakes\s+for select/);
    expect(SQL).not.toMatch(/create policy \w+ on project_intakes\s+for (all|insert|update|delete)/);
    expect(SQL).not.toMatch(/create policy \w+ on research_dossiers/);
  });

  it('names project columns project_profile, never profile', () => {
    expect(SQL).not.toMatch(/add column profile\b/);
  });
});
