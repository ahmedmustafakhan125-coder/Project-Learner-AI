-- P5 hardening migration
--
-- Adds a partial index for fast "how many failed attempts" queries and an
-- insert policy that restricts attempt creation to learners enrolled in the
-- step's project. The existing owner policy (step_attempts_owner from
-- 0001_init.sql) already covers read/update/delete; this adds a tighter
-- INSERT check that validates enrollment rather than just user_id ownership.

-- Partial index: only non-passed attempts, used by the "failed attempts"
-- lookups that gate hint unlocking and pacing decisions. Smaller than the
-- full table and avoids scanning passed rows that are never queried here.
CREATE INDEX IF NOT EXISTS step_attempts_active_idx
  ON step_attempts (step_id)
  WHERE passed = false;

-- Ensure users can only write attempts for steps in their own enrollments.
-- This complements the blanket owner policy by requiring the step to actually
-- belong to a project the learner is enrolled in, closing a path where a
-- learner could guess a step_id from another project.
CREATE POLICY step_attempts_insert_own ON step_attempts
  FOR INSERT WITH CHECK (
    user_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM enrollments e
      JOIN project_steps ps ON ps.project_id = e.project_id
      WHERE ps.id = step_attempts.step_id
      AND e.user_id = auth.uid()
    )
  );
