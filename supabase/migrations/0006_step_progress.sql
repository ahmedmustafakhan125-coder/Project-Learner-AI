/* ------------------------------------------------------------------ *
 * Per-step learner state
 *
 * The draft table was already "one mutable row per learner per step". The
 * editor's contents were simply the first thing kept there; the rest of the
 * step's state belongs in the same row and for the same reason.
 *
 * Everything here answers "what has this learner already done on this step",
 * so that reopening a project resumes it instead of replaying it: the
 * checkpoint result they already saw, the explanation they already unlocked,
 * the hints they already spent.
 * ------------------------------------------------------------------ */

alter table step_drafts rename to step_progress;
alter index step_drafts_user_idx rename to step_progress_user_idx;
alter policy step_drafts_owner on step_progress rename to step_progress_owner;
alter trigger step_drafts_set_updated_at on step_progress rename to step_progress_set_updated_at;

alter table step_progress
  -- When the learner chose to see the explanation. Null means they have not,
  -- and a timestamp is worth more than a boolean if we ever want to know
  -- whether they read it before or after passing.
  add column revealed_at timestamptz,
  -- The last checkpoint run as the learner saw it: { status, layers, at }.
  -- Restored into the panel so a revisited step does not present itself as
  -- never attempted.
  add column last_run jsonb,
  -- Hint tiers already opened. A spent hint cannot be un-spent by reloading,
  -- and this is also what makes step_attempts.hints_used a real number.
  add column hints_opened jsonb not null default '[]'::jsonb;
