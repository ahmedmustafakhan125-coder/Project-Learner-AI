/* ------------------------------------------------------------------ *
 * The brain
 *
 * Until now the platform forgot a learner the moment a conversation ended:
 * every question started from zero, however many times they had circled the
 * same idea. This is the memory — a per-learner concept graph built out of
 * what they have actually done.
 *
 * Two layers, and the split between them is the whole design:
 *
 *   brain_events      append-only. The source of truth for the brain. One row
 *                     per meaningful thing that happened: a question asked,
 *                     the concepts distilled from its answer, a checkpoint
 *                     result, an assessment score. Anything an LLM produced
 *                     (the distilled concepts) is stored HERE, inside the
 *                     event, so it is never re-asked.
 *
 *   brain_nodes       a projection. Derived from the events by a pure function
 *   brain_edges       in packages/core (`projectBrain`), written only by the
 *   brain_query_      API through `brain_replace_projection` below, and
 *     fingerprints    rebuildable at any time. Deleting all three and
 *                     re-running the projection must reproduce them exactly.
 *
 * Because the projection is a fold over stored events rather than over fresh
 * model calls, a rebuild is byte-identical. Nothing here can drift.
 *
 * The browser may READ every table below for its own rows and may write none
 * of them. That is enforced twice: no insert/update/delete policy exists, and
 * the privileges are revoked outright.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Enums — mirrored by `BrainNodeKind` / `BrainEdgeKind` in
 * packages/core/src/brain/types.ts. Change one, change the other.
 * ------------------------------------------------------------------ */

create type brain_node_kind as enum (
  'concept', 'session', 'insight', 'mistake', 'project', 'checkpoint'
);

create type brain_edge_kind as enum (
  'ACTIVATED', 'RELATED_TO', 'PRODUCED', 'OCCURRED_IN',
  'CONTAINS', 'ASSESSED', 'DUPLICATE_OF'
);

/* ------------------------------------------------------------------ *
 * The event log
 * ------------------------------------------------------------------ */

create table brain_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- What the event happened inside: a Q&A thread, a project, an assessment.
  source_kind text not null check (source_kind in ('thread', 'project', 'assessment')),
  source_id   uuid not null,
  kind        text not null check (kind in (
                'question_asked', 'qa_distilled', 'checkpoint_result',
                'mcq_attempt', 'viva_answer', 'viva_score', 'offer_dismissed')),
  -- Names the real-world occurrence, e.g. `question:<message id>`. Unique per
  -- learner, so a retried write is a no-op rather than a second event.
  dedupe_key  text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

-- The projection reads a learner's whole log in this order.
create index brain_events_user_idx on brain_events (user_id, created_at, id);

/*
 * Append-only. An event is a record of something that happened; editing one
 * would silently rewrite the learner's history on the next rebuild. DELETE is
 * left alone so deleting a user still cascades.
 */
create or replace function brain_events_reject_update()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'brain_events is append-only';
end;
$fn$;

create trigger brain_events_no_update before update on brain_events
  for each row execute function brain_events_reject_update();

/* ------------------------------------------------------------------ *
 * The projection
 * ------------------------------------------------------------------ */

create table brain_nodes (
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- Deterministic, e.g. `concept:closures` or `session:thread:<uuid>`, so a
  -- link to a node survives every rebuild.
  id            text not null,
  kind          brain_node_kind not null,
  key           text not null,
  label         text not null,
  -- Mastery for concepts, 0..1. Null for kinds where it means nothing.
  score         numeric(4,3),
  confidence    numeric(4,3),
  metadata      jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  primary key (user_id, id)
);

create index brain_nodes_kind_idx on brain_nodes (user_id, kind, last_seen_at desc);

create table brain_edges (
  user_id    uuid not null,
  src        text not null,
  dst        text not null,
  kind       brain_edge_kind not null,
  weight     numeric(8,3) not null default 1.0,
  -- The thread, project, or assessment the edge was formed in.
  source_id  uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  primary key (user_id, src, dst, kind),
  foreign key (user_id, src) references brain_nodes (user_id, id) on delete cascade,
  foreign key (user_id, dst) references brain_nodes (user_id, id) on delete cascade,
  -- A score without the rubric it was marked against, or without knowing
  -- which attempt it was, cannot be interpreted later. Refuse it outright.
  constraint brain_edges_assessed_complete check (
    kind <> 'ASSESSED'
    or (metadata ? 'rubric_snapshot' and metadata ? 'attempt_number')
  )
);

create index brain_edges_src_idx on brain_edges (user_id, src, kind);
create index brain_edges_dst_idx on brain_edges (user_id, dst, kind);

/*
 * Exact-match recall. `fingerprint` is the sha256 of the canonical query,
 * computed in apps/api (packages/core cannot reach a hash function and stay
 * portable). Derived from `question_asked` events like everything else here.
 */
create table brain_query_fingerprints (
  user_id     uuid not null references auth.users (id) on delete cascade,
  fingerprint text not null,
  canonical   text not null,
  thread_id   uuid not null,
  message_id  uuid not null,
  created_at  timestamptz not null,
  primary key (user_id, fingerprint)
);

create index brain_query_fingerprints_recent_idx
  on brain_query_fingerprints (user_id, created_at desc);

/*
 * Which event the stored projection was built from. Two rebuilds can race —
 * each reads the log, then writes — and without this the one that read the
 * older log could land second and quietly drop the newest event.
 */
create table brain_projection_state (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  watermark_at timestamptz not null,
  watermark_id uuid not null,
  rebuilt_at   timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Row Level Security — owner may read, nobody may write through RLS
 * ------------------------------------------------------------------ */

do $mig$
declare t text;
begin
  foreach t in array array[
    'brain_events', 'brain_nodes', 'brain_edges',
    'brain_query_fingerprints', 'brain_projection_state'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_owner_read on %I for select using (auth.uid() = user_id)', t, t);
    -- 0004 granted ALL to anon/authenticated by default. Reading is all the
    -- browser is ever allowed here, so take the rest back explicitly rather
    -- than rely on the absent policy alone.
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
    execute format('grant select on %I to anon, authenticated', t);
    execute format('grant all on %I to postgres, service_role', t);
  end loop;
end
$mig$;

/* ------------------------------------------------------------------ *
 * Writing the projection
 *
 * One transaction: lock the learner, refuse a snapshot older than the one
 * already stored, then replace their nodes, edges and fingerprints wholesale.
 * Replace rather than patch because the projection is a pure function of the
 * log — there is nothing in the old rows worth keeping.
 * ------------------------------------------------------------------ */

create or replace function brain_replace_projection(
  p_user_id      uuid,
  p_watermark_at timestamptz,
  p_watermark_id uuid,
  p_nodes        jsonb,
  p_edges        jsonb,
  p_fingerprints jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  current_at timestamptz;
  current_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('brain:' || p_user_id::text, 0));

  select watermark_at, watermark_id into current_at, current_id
  from brain_projection_state
  where user_id = p_user_id;

  -- Equal is allowed: rebuilding the same log twice is how a rebuild is proved.
  if current_at is not null
     and (p_watermark_at, p_watermark_id) < (current_at, current_id) then
    return false;
  end if;

  delete from brain_edges where user_id = p_user_id;
  delete from brain_nodes where user_id = p_user_id;
  delete from brain_query_fingerprints where user_id = p_user_id;

  insert into brain_nodes (
    user_id, id, kind, key, label, score, confidence, metadata, first_seen_at, last_seen_at
  )
  select p_user_id, n.id, n.kind::brain_node_kind, n.key, n.label, n.score, n.confidence,
         coalesce(n.metadata, '{}'::jsonb), n.first_seen_at, n.last_seen_at
  from jsonb_to_recordset(coalesce(p_nodes, '[]'::jsonb)) as n(
    id text, kind text, key text, label text, score numeric, confidence numeric,
    metadata jsonb, first_seen_at timestamptz, last_seen_at timestamptz);

  insert into brain_edges (user_id, src, dst, kind, weight, source_id, metadata, created_at)
  select p_user_id, e.src, e.dst, e.kind::brain_edge_kind, e.weight, e.source_id,
         coalesce(e.metadata, '{}'::jsonb), e.created_at
  from jsonb_to_recordset(coalesce(p_edges, '[]'::jsonb)) as e(
    src text, dst text, kind text, weight numeric, source_id uuid,
    metadata jsonb, created_at timestamptz);

  insert into brain_query_fingerprints (
    user_id, fingerprint, canonical, thread_id, message_id, created_at
  )
  select p_user_id, f.fingerprint, f.canonical, f.thread_id, f.message_id, f.created_at
  from jsonb_to_recordset(coalesce(p_fingerprints, '[]'::jsonb)) as f(
    fingerprint text, canonical text, thread_id uuid, message_id uuid, created_at timestamptz);

  insert into brain_projection_state (user_id, watermark_at, watermark_id, rebuilt_at)
  values (p_user_id, p_watermark_at, p_watermark_id, now())
  on conflict (user_id) do update
    set watermark_at = excluded.watermark_at,
        watermark_id = excluded.watermark_id,
        rebuilt_at   = excluded.rebuilt_at;

  return true;
end;
$fn$;

/*
 * SECURITY DEFINER bypasses RLS, and 0004's default privileges hand EXECUTE on
 * every new routine to anon and authenticated. Left as is, any signed-in
 * browser could overwrite any learner's brain. Only the API may call this.
 */
revoke all on function brain_replace_projection(uuid, timestamptz, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function brain_replace_projection(uuid, timestamptz, uuid, jsonb, jsonb, jsonb)
  to service_role;
