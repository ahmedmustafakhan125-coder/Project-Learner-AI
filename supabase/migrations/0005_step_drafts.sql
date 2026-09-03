/* ------------------------------------------------------------------ *
 * Work in progress
 *
 * The editor's contents between attempts. Without this the learner's code
 * lives only in React state: navigating to another step, reloading, or coming
 * back tomorrow silently threw away everything they had written and handed
 * them the starter files again.
 *
 * Separate from step_attempts on purpose. An attempt is a submitted, graded
 * event and its files are a historical record that must not change; a draft is
 * mutable current state, one row per learner per step, overwritten as they
 * type.
 * ------------------------------------------------------------------ */

create table step_drafts (
  user_id    uuid not null references auth.users (id) on delete cascade,
  step_id    uuid not null references project_steps (id) on delete cascade,
  -- Same shape as step_attempts.submitted_files: [{ path, contents }].
  files      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, step_id)
);

create index step_drafts_user_idx on step_drafts (user_id, updated_at desc);

alter table step_drafts enable row level security;
alter table step_drafts force row level security;

create policy step_drafts_owner on step_drafts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger step_drafts_set_updated_at before update on step_drafts
  for each row execute function set_updated_at();

grant all on step_drafts to postgres, anon, authenticated, service_role;
