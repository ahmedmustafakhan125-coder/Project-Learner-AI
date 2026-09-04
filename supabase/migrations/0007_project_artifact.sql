/* ------------------------------------------------------------------ *
 * The finished project
 *
 * Steps taught the learner to build the thing; this is the thing. It is the
 * project assembled out of the code they actually wrote, plus a README and the
 * deployment config written against that code — the difference between having
 * done a tutorial and having something to show someone.
 *
 * Cached rather than derived on every request because producing it costs an
 * LLM call: the README and the deploy artifacts are written once, against the
 * finished code, and re-read from here afterwards. The `files` inside are a
 * snapshot at generation time, so `generated_at` is what tells the UI it was
 * made before the learner's most recent work.
 * ------------------------------------------------------------------ */

alter table projects
  -- { files, readmeMd, deployment, stepsFromReference, fullyLearnerWritten, generatedAt }
  add column artifact jsonb,
  add column artifact_generated_at timestamptz;

-- Partial: only finished projects have one, and the index exists to answer
-- "has this been generated yet" without reading the blob itself.
create index projects_artifact_idx
  on projects (user_id, artifact_generated_at desc)
  where artifact_generated_at is not null;
