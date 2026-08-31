-- Make the attempt-insert enrollment check actually bind.
--
-- 0002_hardening.sql added `step_attempts_insert_own` as a PERMISSIVE policy.
-- Postgres combines permissive policies for the same command with OR, and
-- `step_attempts_owner` (from 0001_init.sql, `for all`) already permits any row
-- where user_id = auth.uid(). The effective INSERT check was therefore:
--
--   (user_id = auth.uid())
--   OR (user_id = auth.uid() AND enrolled-in-the-step's-project)
--
-- which reduces to the first clause. The enrollment requirement was a no-op and
-- the path it claimed to close — inserting an attempt against a step_id guessed
-- from someone else's project — stayed open.
--
-- RESTRICTIVE policies are ANDed with the permissive set instead, so the
-- enrollment check now genuinely gates the insert. A restrictive policy grants
-- nothing on its own; `step_attempts_owner` remains the permissive grant.

DROP POLICY IF EXISTS step_attempts_insert_own ON step_attempts;

CREATE POLICY step_attempts_insert_enrolled ON step_attempts
  AS RESTRICTIVE
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1
      FROM enrollments e
      JOIN project_steps ps ON ps.project_id = e.project_id
      WHERE ps.id = step_attempts.step_id
        AND e.user_id = auth.uid()
    )
  );
