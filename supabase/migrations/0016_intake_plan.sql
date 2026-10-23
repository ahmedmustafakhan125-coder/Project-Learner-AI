/* ------------------------------------------------------------------ *
 * Project Learner, phase 3 (docs/project-learner.md §12)
 *
 * The intake row now holds everything `POST /api/projects { intakeId }`
 * reads, so nothing a project is built from is trusted from the browser:
 * the plan written against the approved brief, which model wrote each stage,
 * what research found, and the similar project it was adapted from.
 *
 * Every column is nullable or defaulted and nothing reads them with
 * PROJECT_LEARNER off, so this applies under a running app without changing it.
 * ------------------------------------------------------------------ */

alter table project_intakes
  -- The blueprint planned against the approved brief, with step docRefs.
  add column blueprint           jsonb,
  -- How many times the learner asked for a new plan; two are allowed.
  add column blueprint_revisions int not null default 0 check (blueprint_revisions between 0 and 2),
  -- What research found beyond the dossier: limited sources, cards, cache hits.
  add column research_summary    jsonb,
  -- Which model wrote which stage: { research, brief, blueprint }.
  add column generation_models   jsonb not null default '{}'::jsonb,
  -- A very similar stored project whose brief, dossier and plan this intake
  -- adapts instead of planning from nothing. Its owner's learner is never
  -- copied: no memory, no code, only what the models wrote.
  add column template_project_id uuid references projects (id) on delete set null;

-- Finding a template: Project Learner projects of one kind and size, newest first.
create index projects_template_idx on projects (project_profile, complexity_tier, created_at desc)
  where stack_brief is not null and intake_id is not null;
