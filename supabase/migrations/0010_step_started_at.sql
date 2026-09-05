/* ------------------------------------------------------------------ *
 * When the learner started a step
 *
 * The hint ladder unlocks on "N attempts OR N*5 minutes", and the minutes half
 * never fired. Elapsed time was measured from the FIRST ATTEMPT, so a learner
 * who had not submitted anything had no clock at all — and not being able to
 * submit anything yet is the whole situation hints exist for. The time branch
 * could only help someone who had already used the attempts branch.
 *
 * This is the timestamp it should always have run from: when they opened the
 * step and the editor appeared. Set once, on the first write for that step,
 * and never moved afterwards — a learner who comes back tomorrow has not
 * restarted the clock, they have been stuck since yesterday.
 * ------------------------------------------------------------------ */

alter table step_progress
  add column started_at timestamptz;

/*
 * Backfill from the earliest attempt, which is what the gate used to use. It
 * is the best evidence available for steps already in flight, and leaving them
 * null would restart the clock for every learner mid-project.
 */
update step_progress p
set started_at = a.first_attempt
from (
  select step_id, user_id, min(created_at) as first_attempt
  from step_attempts
  group by step_id, user_id
) a
where a.step_id = p.step_id
  and a.user_id = p.user_id
  and p.started_at is null;
