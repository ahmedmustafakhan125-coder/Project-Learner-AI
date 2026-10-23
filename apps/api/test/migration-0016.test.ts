import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_REGENERATIONS } from '../src/routes/intake.js';

/** Migration 0016 adds what `POST /api/projects { intakeId }` reads to the intake row. */

const SQL = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0016_intake_plan.sql', import.meta.url)),
  'utf8',
);

describe('0016', () => {
  it('bounds plan regenerations where the route does', () => {
    expect(SQL).toContain(`check (blueprint_revisions between 0 and ${MAX_REGENERATIONS})`);
  });

  it('lets a deleted template project go without taking the intake with it', () => {
    expect(SQL).toMatch(/template_project_id uuid references projects \(id\) on delete set null/);
  });

  it('adds no policy: the intake row is still written only by the API', () => {
    expect(SQL).not.toMatch(/create policy/i);
    expect(SQL).not.toMatch(/\bgrant\b/i);
  });
});
