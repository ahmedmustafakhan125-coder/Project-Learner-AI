/* ------------------------------------------------------------------ *
 * Project Learner (docs/project-learner.md §12)
 *
 * Intake, the Stack Brief and the Research Dossier, behind PROJECT_LEARNER.
 * Nothing here is read with the flag off, and every new column is nullable
 * or defaulted, so this applies under a running app without changing it.
 *
 * `profiles` is already the user table, so a project's kind of software is
 * `project_profile` everywhere below.
 *
 * Enums mirror the Zod enums in packages/core (profiles/types.ts and
 * schemas/stack.ts), per the convention in 0001; a test holds them together.
 * ------------------------------------------------------------------ */

create type project_profile as enum (
  'web-frontend', 'web-fullstack', 'api-backend', 'cli-tool', 'desktop-app',
  'mobile-app', 'game', 'graphics', 'systems-os', 'language-tooling',
  'systems-other', 'data-ml', 'embedded', 'general'
);
create type complexity_tier   as enum ('T1', 'T2', 'T3', 'T4', 'T5');
create type intake_status     as enum ('scoped', 'researched', 'briefed', 'approved', 'abandoned');
create type step_verification as enum ('browser', 'cli', 'static');

/* ------------------------------------------------------------------ *
 * Intake
 *
 * One row per project being planned, from the moment the interview returns a
 * CompiledQuery until the learner approves the plan. It exists so the brief
 * and dossier a project is built from are read back from here, never trusted
 * from the browser: `POST /api/projects { intakeId }` reads this row.
 *
 * The interview itself stays client-held, as InterviewState is today. The
 * `interview_sessions` table from 0001 is unused by code and is left alone.
 * ------------------------------------------------------------------ */

create table project_intakes (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  -- The gateway-screened CompiledQuery the intake began with.
  compiled_query     jsonb not null,
  -- What the classify call extracted: domain words, shape, low-level hints.
  signals            jsonb not null default '{}'::jsonb,
  project_profile    project_profile not null,
  profile_confidence numeric(4,3) not null check (profile_confidence between 0 and 1),
  tier               complexity_tier not null,
  tier_reasons       jsonb not null default '[]'::jsonb,
  -- Inline until the shared technology cache serves repeat stacks.
  dossier            jsonb,
  brief              jsonb,
  -- Every earlier brief, oldest first; the learner may regenerate twice.
  brief_revisions    jsonb not null default '[]'::jsonb,
  status             intake_status not null default 'scoped',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Unapproved intakes are deleted after seven days (purge_expired_intakes).
  expires_at         timestamptz not null default now() + interval '7 days'
);

create index project_intakes_user_idx    on project_intakes (user_id, created_at desc);
create index project_intakes_expires_idx on project_intakes (expires_at) where status <> 'approved';

create trigger project_intakes_set_updated_at before update on project_intakes
  for each row execute function set_updated_at();

/*
 * Deletes intakes that expired before approval. Called by the API; nothing
 * schedules it in the database, because pg_cron is not on every deployment.
 */
create or replace function purge_expired_intakes()
returns int
language sql
security definer set search_path = public
as $fn$
  with gone as (
    delete from project_intakes
    where status <> 'approved' and expires_at < now()
    returning 1
  )
  select count(*)::int from gone;
$fn$;

revoke all on function purge_expired_intakes() from public, anon, authenticated;
grant execute on function purge_expired_intakes() to service_role;

/* ------------------------------------------------------------------ *
 * Projects and steps
 *
 * Old projects keep nulls and read back through the tolerant parsers
 * (parseStoredStackBrief, parseStoredDossier), falling back to the
 * "Built with" list from tech_stack.
 * ------------------------------------------------------------------ */

alter table projects
  add column project_profile   project_profile,
  add column complexity_tier   complexity_tier,
  add column stack_brief       jsonb,
  add column dossier           jsonb,
  -- Which model wrote which stage, from the server, never the request body.
  add column generation_models jsonb,
  add column intake_id         uuid references project_intakes (id) on delete set null;

-- `checkpoint` is already jsonb, so later contract and harness fields need
-- only Zod defaults.
alter table project_steps
  add column doc_refs     jsonb not null default '[]'::jsonb,
  add column verification step_verification;

-- Billed per search on top of tokens. Zero for every row written before this.
alter table llm_usage
  add column web_searches int not null default 0 check (web_searches >= 0);

/* ------------------------------------------------------------------ *
 * The technology dossier cache
 *
 * The technology-level part of a dossier (versions, APIs, toolchain and their
 * references) for one technology at one pinned version, reused for 30 days so
 * the tenth Tauri project in a week pays nothing for research. Project notes
 * stay with their intake. Shared across learners and holding nothing about
 * any of them, so only the API reads or writes it.
 * ------------------------------------------------------------------ */

create table research_dossiers (
  id           uuid primary key default gen_random_uuid(),
  -- 'tauri', 'rust', 'limine': the tech card id, or the research key.
  tech         text not null check (length(tech) between 1 and 120),
  -- The pinned major the research was done against; '' when unpinned.
  version_pin  text not null default '',
  dossier      jsonb not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  unique (tech, version_pin)
);

create index research_dossiers_expires_idx on research_dossiers (expires_at);

/* ------------------------------------------------------------------ *
 * Row Level Security
 *
 * Forced on both tables, following 0002. A learner may read their own
 * intakes; every write goes through the API with the service role. A browser
 * that could write an intake could approve a brief no model wrote, which is
 * the gap the intake row exists to close.
 *
 * research_dossiers has no policy and no privilege for anyone but the service
 * role, like assessment_keys in 0013.
 * ------------------------------------------------------------------ */

do $mig$
declare t text;
begin
  foreach t in array array['project_intakes', 'research_dossiers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
    execute format('grant all on %I to postgres, service_role', t);
  end loop;
end
$mig$;

create policy project_intakes_owner_read on project_intakes
  for select using (auth.uid() = user_id);
grant select on project_intakes to anon, authenticated;

revoke all on research_dossiers from anon, authenticated;
