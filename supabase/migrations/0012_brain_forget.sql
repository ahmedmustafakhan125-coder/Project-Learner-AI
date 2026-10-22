/* ------------------------------------------------------------------ *
 * Forgetting
 *
 * Deleting a conversation or a project from the history rail has always
 * removed its messages. It did not remove what the brain had learned from it:
 * the question, the concepts distilled from the answer, the mistakes it
 * revealed. A learner who deletes something means it to be gone, so the brain
 * forgets it too.
 *
 * The events are the source of truth, so forgetting is deleting a source's
 * events and rebuilding. Two things make that safe:
 *
 *   1. `brain_forget_source` deletes under the same per-learner lock that
 *      `brain_replace_projection` writes under, so a forget and a projection
 *      write can never interleave.
 *
 *   2. It clears the stored watermark. The log has just lost events — quite
 *      possibly its newest — so the rebuild that follows has an OLDER
 *      watermark than the one stored, and the stale-snapshot guard would
 *      refuse it. The forgotten conversation would stay in the graph.
 *
 * `brain_replace_projection` also learns to clear a projection outright when
 * given no watermark: forgetting a learner's only conversation leaves an empty
 * log, and an empty log must mean an empty brain.
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

  -- No watermark: the log is empty, so the brain is too.
  if p_watermark_at is null then
    delete from brain_edges where user_id = p_user_id;
    delete from brain_nodes where user_id = p_user_id;
    delete from brain_query_fingerprints where user_id = p_user_id;
    delete from brain_projection_state where user_id = p_user_id;
    return true;
  end if;

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

create or replace function brain_forget_source(
  p_user_id     uuid,
  p_source_kind text,
  p_source_id   uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('brain:' || p_user_id::text, 0));

  delete from brain_events
  where user_id = p_user_id
    and source_kind = p_source_kind
    and source_id = p_source_id;
  get diagnostics removed = row_count;

  if removed > 0 then
    delete from brain_projection_state where user_id = p_user_id;
  end if;

  return removed;
end;
$fn$;

/* Both are SECURITY DEFINER; see 0011 for why the browser roles are revoked by name. */
revoke all on function brain_replace_projection(uuid, timestamptz, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function brain_replace_projection(uuid, timestamptz, uuid, jsonb, jsonb, jsonb)
  to service_role;

revoke all on function brain_forget_source(uuid, text, uuid) from public, anon, authenticated;
grant execute on function brain_forget_source(uuid, text, uuid) to service_role;
