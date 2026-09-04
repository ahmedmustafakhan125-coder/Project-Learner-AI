/* ------------------------------------------------------------------ *
 * Per-specialist follow-up conversations
 *
 * The fan-out gives four answers to one question and then stops. Everything
 * after that — "why does that work", "show me the memory graph", "what breaks
 * at scale" — had nowhere to go but a fresh question to all four, which throws
 * away the thing that makes four agents worth running: each one holds a
 * different angle, and pressing on ONE of them is where that angle pays off.
 *
 * One row per turn, per specialist, per question. `agent_responses` already
 * holds each specialist's opening answer and is a single row per agent per
 * message, so it has nowhere to put a conversation; this is that conversation,
 * hanging off the same root message.
 * ------------------------------------------------------------------ */

create table agent_followups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The question that produced the four answers. Cascades with the thread, so
  -- deleting a conversation from the history rail takes its follow-ups too.
  message_id uuid not null references messages (id) on delete cascade,
  agent      agent_kind not null,
  -- Position within this one specialist's conversation, from 0. Unique per
  -- (message, agent) so a double-submit cannot interleave two turns.
  turn_index int not null,
  role       message_role not null,
  content    text not null,
  -- Which model answered. A follow-up can be asked days later, on a different
  -- model from the one that wrote the opening answer.
  model      text,
  created_at timestamptz not null default now(),
  unique (message_id, agent, turn_index)
);

-- The only read this table serves: one specialist's thread, in order.
create index agent_followups_thread_idx
  on agent_followups (message_id, agent, turn_index);

alter table agent_followups enable row level security;
alter table agent_followups force row level security;

create policy agent_followups_owner on agent_followups
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on agent_followups to postgres, anon, authenticated, service_role;
