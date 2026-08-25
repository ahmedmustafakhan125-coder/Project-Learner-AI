-- AI Education Platform — initial schema
--
-- Every table carries a user_id and has RLS enabled with an owner-only policy.
-- The service-role key bypasses RLS and lives only in apps/api; the browser
-- only ever holds the anon key, so these policies are the real access control.

create extension if not exists "pgcrypto";

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

create type skill_level    as enum ('beginner', 'intermediate', 'advanced');
create type project_status as enum ('draft', 'generating', 'active', 'completed', 'abandoned');
create type agent_kind     as enum ('simple', 'industry', 'practice', 'concepts');
create type agent_status   as enum ('pending', 'streaming', 'complete', 'error');
create type query_intent   as enum ('project_generation', 'concept_question', 'debug_help', 'other');
create type message_role   as enum ('user', 'assistant');

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

create or replace function set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  default_skill skill_level not null default 'beginner',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Stable interview answers graduate into here so returning learners are asked
-- progressively fewer questions. These slots are merged during the interview's
-- auto-fill step, before any question is generated.
create table user_context_profile (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  slots       jsonb not null default '{}'::jsonb,
  confidence  jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

create table projects (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  title             text not null,
  summary           text,
  area_of_interest  text,
  tech_stack        jsonb not null default '[]'::jsonb,
  skill_level       skill_level not null,
  learning_goals    jsonb not null default '[]'::jsonb,
  prerequisites     jsonb not null default '[]'::jsonb,
  estimated_hours   numeric(5,1),
  status            project_status not null default 'draft',
  -- The blueprint is kept verbatim: it is the cached prefix for every later
  -- step-expansion call, so it must not drift.
  blueprint         jsonb,
  generation_model  text,
  generation_params jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table project_steps (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  step_index       int  not null,
  title            text not null,
  objective        text,
  concepts         jsonb not null default '[]'::jsonb,
  est_minutes      int,
  -- Null until Phase-B expansion runs. Steps are expanded lazily so adaptive
  -- pacing can still change them; a fully pre-generated project cannot adapt.
  instructions_md  text,
  explanation_md   text,
  alternatives     jsonb,
  starter_files    jsonb,
  solution_files   jsonb,
  checkpoint       jsonb,
  pacing_directive jsonb,
  expanded_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, step_index)
);

create table enrollments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  project_id         uuid not null references projects (id) on delete cascade,
  current_step_index int not null default 0,
  status             project_status not null default 'active',
  pace_state         jsonb not null default '{}'::jsonb,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),
  unique (user_id, project_id)
);

create table step_attempts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  step_id         uuid not null references project_steps (id) on delete cascade,
  attempt_no      int  not null,
  submitted_files jsonb not null default '{}'::jsonb,
  run_output      jsonb,
  test_results    jsonb,
  ai_review       jsonb,
  passed          boolean not null default false,
  hints_used      int not null default 0,
  duration_ms     int,
  created_at      timestamptz not null default now(),
  unique (step_id, attempt_no)
);

/* ------------------------------------------------------------------ *
 * Interview + Q&A
 * ------------------------------------------------------------------ */

create table threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  project_id uuid references projects (id) on delete set null,
  step_id    uuid references project_steps (id) on delete set null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table interview_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  thread_id      uuid references threads (id) on delete cascade,
  raw_query      text not null,
  intent         query_intent not null default 'other',
  -- Slots resolved so far, plus which were auto-filled vs. asked. Retaining
  -- this is what makes it measurable whether the questions improved answers.
  slots          jsonb not null default '{}'::jsonb,
  auto_filled    jsonb not null default '[]'::jsonb,
  questions      jsonb not null default '[]'::jsonb,
  answers        jsonb not null default '{}'::jsonb,
  rounds         int not null default 0,
  sufficiency    numeric(3,2),
  skipped        boolean not null default false,
  compiled_query text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table messages (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid not null references threads (id) on delete cascade,
  user_id              uuid not null references auth.users (id) on delete cascade,
  role                 message_role not null,
  content              text not null,
  interview_session_id uuid references interview_sessions (id) on delete set null,
  created_at           timestamptz not null default now()
);

-- One row per sub-agent per user message: four rows fan out from one query.
create table agent_responses (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  agent      agent_kind not null,
  status     agent_status not null default 'pending',
  content_md text not null default '',
  structured jsonb,
  model      text,
  usage      jsonb,
  latency_ms int,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, agent)
);

-- The practice agent's generated exercise, including its self-contained HTML UI.
create table exercises (
  id                uuid primary key default gen_random_uuid(),
  agent_response_id uuid not null references agent_responses (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  title             text,
  html              text not null,
  spec              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create table attachments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  thread_id        uuid references threads (id) on delete cascade,
  message_id       uuid references messages (id) on delete cascade,
  storage_path     text not null,
  filename         text not null,
  mime_type        text not null,
  size_bytes       bigint not null,
  extracted_text   text,
  -- Uploaded once to the provider and referenced by all four fan-out requests
  -- rather than resending the bytes four times.
  provider_file_id text,
  provider         text,
  created_at       timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Cost accounting
 * ------------------------------------------------------------------ */

create table llm_usage (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  task               text not null,
  provider           text not null,
  model              text not null,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  -- Null, never zero, when the model's pricing has not been verified. A zero
  -- here would read as "free" and silently defeat budget enforcement.
  cost_usd           numeric(12,6),
  unpriced           boolean not null default false,
  latency_ms         int,
  created_at         timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Indexes
 * ------------------------------------------------------------------ */

create index projects_user_idx        on projects (user_id, created_at desc);
create index project_steps_order_idx  on project_steps (project_id, step_index);
create index project_steps_user_idx   on project_steps (user_id);
create index enrollments_user_idx     on enrollments (user_id);
create index step_attempts_lookup_idx on step_attempts (user_id, step_id, attempt_no desc);
create index threads_user_idx         on threads (user_id, updated_at desc);
create index messages_thread_idx      on messages (thread_id, created_at);
create index agent_responses_msg_idx  on agent_responses (message_id);
create index interview_user_idx       on interview_sessions (user_id, created_at desc);
create index attachments_message_idx  on attachments (message_id);
-- Drives the per-user daily budget check on the hot path.
create index llm_usage_budget_idx     on llm_usage (user_id, created_at desc);

/* ------------------------------------------------------------------ *
 * updated_at triggers
 * ------------------------------------------------------------------ */

do $mig$
declare t text;
begin
  foreach t in array array[
    'profiles', 'user_context_profile', 'projects', 'project_steps',
    'enrollments', 'threads', 'interview_sessions', 'agent_responses'
  ] loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t);
  end loop;
end
$mig$;

/* ------------------------------------------------------------------ *
 * Row Level Security
 * ------------------------------------------------------------------ */

do $mig$
declare t text;
begin
  foreach t in array array[
    'profiles', 'user_context_profile', 'projects', 'project_steps',
    'enrollments', 'step_attempts', 'threads', 'interview_sessions',
    'messages', 'agent_responses', 'exercises', 'attachments', 'llm_usage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$mig$;

-- profiles keys on `id`; every other table keys on `user_id`.
create policy profiles_owner on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

do $mig$
declare t text;
begin
  foreach t in array array[
    'user_context_profile', 'projects', 'project_steps', 'enrollments',
    'step_attempts', 'threads', 'interview_sessions', 'messages',
    'agent_responses', 'exercises', 'attachments', 'llm_usage'
  ] loop
    execute format(
      'create policy %I_owner on %I for all
       using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
  end loop;
end
$mig$;

/* ------------------------------------------------------------------ *
 * New-user bootstrap
 * ------------------------------------------------------------------ */

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $fn$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  insert into public.user_context_profile (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
