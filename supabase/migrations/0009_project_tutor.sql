/* ------------------------------------------------------------------ *
 * The project tutor
 *
 * A conversation that runs alongside a project rather than alongside a
 * question. `agent_followups` hangs off `messages` — a Q&A thread — and has
 * nowhere to put a conversation whose subject is a codebase being built over
 * days. This is that conversation.
 *
 * One thread per project, not per step. A learner asking "why did we do it
 * that way in step 3" while working on step 7 is asking one question about one
 * project, and splitting the transcript by step would lose exactly the context
 * that makes it worth having. `step_index` records where each turn happened so
 * the rail can show it, not so the thread can be cut into pieces.
 * ------------------------------------------------------------------ */

create table project_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Cascades with the project, so deleting one takes its transcript too.
  project_id  uuid not null references projects (id) on delete cascade,
  -- Which step the learner was looking at. Nullable: a project can be asked
  -- about from the finished-project view, where no step is current.
  step_index  int,
  -- Position in the project-wide thread, from 0. Unique per project so a
  -- double-submit cannot interleave two turns.
  turn_index  int not null,
  role        message_role not null,
  content     text not null,
  -- True when this answer contained code the gate had opened. Reporting only,
  -- but it is the one thing worth being able to count later: how often the
  -- reveal actually fires is how you tell whether the gate is calibrated.
  revealed_code boolean not null default false,
  model       text,
  created_at  timestamptz not null default now(),
  unique (project_id, turn_index)
);

-- The only read this table serves: one project's thread, in order.
create index project_chat_messages_thread_idx
  on project_chat_messages (project_id, turn_index);

alter table project_chat_messages enable row level security;
alter table project_chat_messages force row level security;

create policy project_chat_messages_owner on project_chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on project_chat_messages to postgres, anon, authenticated, service_role;

/* ------------------------------------------------------------------ *
 * Per-step tutor state
 *
 * Goes on step_progress, which migration 0006 established as "one mutable row
 * per learner per step, holding what they have already done here". How many
 * times they have asked, and whether the code has been opened, are exactly
 * that — and putting them here means the gate reads one row it already loads.
 * ------------------------------------------------------------------ */

alter table step_progress
  -- When the tutor was first allowed to write code for this step. Null means
  -- it has not been earned. A timestamp rather than a boolean because "how
  -- long did they hold out" is the question worth asking of this data later.
  add column tutor_unlocked_at timestamptz,
  -- Questions asked to the tutor on this step. One of the gate's inputs, and
  -- incremented server-side so the browser cannot inflate it.
  add column tutor_asks int not null default 0;
