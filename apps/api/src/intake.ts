import { CompiledQuery, ProfileId, ScopeSignals, getProfile } from '@ai-edu/core';
import type { PlannedBlueprint, Profile } from '@ai-edu/core';
import type { ProjectTier } from '@ai-edu/llm';

import { db } from './db.js';

/**
 * The intake row (`project_intakes`, migrations 0015 and 0016): read by the
 * intake routes and by `POST /api/projects { intakeId }`, which builds a
 * project from it and nothing else.
 *
 * Kept apart from routes/intake.ts so routes/projects.ts can read a row
 * without loading the intake routes, which exist only with PROJECT_LEARNER on.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INTAKE_COLUMNS =
  'id, user_id, compiled_query, signals, project_profile, profile_confidence, tier, tier_reasons, dossier, ' +
  'research_summary, brief, brief_revisions, blueprint, blueprint_revisions, generation_models, template_project_id, ' +
  'status, expires_at';

export interface IntakeRow {
  id: string;
  compiled_query: unknown;
  signals: unknown;
  project_profile: ProfileId;
  profile_confidence: number;
  tier: ProjectTier;
  tier_reasons: string[];
  dossier: unknown;
  research_summary: unknown;
  brief: unknown;
  brief_revisions: unknown[];
  blueprint: PlannedBlueprint | null;
  blueprint_revisions: number;
  generation_models: Record<string, string>;
  template_project_id: string | null;
  status: 'scoped' | 'researched' | 'briefed' | 'approved' | 'abandoned';
  expires_at: string;
}

export interface Intake {
  row: IntakeRow;
  compiled: CompiledQuery;
  profile: Profile;
  signals: ScopeSignals;
}

/* ------------------------------------------------------------------ *
 * The intake row
 * ------------------------------------------------------------------ */

/** The learner's own intake, unexpired, or null. The service role bypasses RLS, so the user filter is the control. */
export async function loadIntake(id: string, userId: string): Promise<Intake | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db()
    .from('project_intakes')
    .select(INTAKE_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  const row = data as IntakeRow | null;
  if (!row) return null;
  if (row.status !== 'approved' && new Date(row.expires_at).getTime() < Date.now()) return null;
  const compiled = CompiledQuery.safeParse(row.compiled_query);
  const profile = ProfileId.safeParse(row.project_profile);
  if (!compiled.success || !profile.success) return null;
  return {
    row,
    compiled: compiled.data,
    profile: getProfile(profile.data),
    signals: ScopeSignals.catch({ domainWords: [], interfaces: [] }).parse(row.signals ?? {}),
  };
}

export async function updateIntake(intake: Intake, userId: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await db().from('project_intakes').update(patch).eq('id', intake.row.id).eq('user_id', userId);
  if (error) console.error('[intake] update failed:', error.message);
  return !error;
}
