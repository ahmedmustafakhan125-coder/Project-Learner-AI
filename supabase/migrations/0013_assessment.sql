/* ------------------------------------------------------------------ *
 * Assessment
 *
 * A learner can ask whether a concept stuck. Each sitting is one row in
 * `assessments`: a five-question multiple-choice gate, then — if they pass
 * it — five viva questions marked against rubrics, 25 marks in all.
 *
 * Retakes are new rows with the next `attempt_number`; nothing is ever
 * overwritten, because 12 then 22 is a stronger signal than a flat 22. The
 * grades also go into the brain as events (`viva_score`), which is where
 * mastery is computed — these tables are the working record of a sitting.
 *
 * The answers to the multiple-choice gate live in `assessment_keys`, which
 * the browser cannot read at all: RLS is forced and there is no policy. Owner
 * RLS on `assessments` would otherwise hand the anon key the right option for
 * every question before the learner had answered one. Same reason solution
 * files never reach the browser before a step is attempted.
 * ------------------------------------------------------------------ */

create table assessments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  concept_key    text not null,
  concept_label  text not null,
  attempt_number int  not null check (attempt_number >= 1),
  status         text not null default 'mcq'
                 check (status in ('mcq', 'mcq_failed', 'viva', 'graded', 'abandoned')),
  -- The part safe to show before answering: prompts, options, viva rubrics.
  questions      jsonb not null,
  mcq_answers    jsonb,
  mcq_score      int,
  viva_score     int check (viva_score between 0 and 25),
  -- Per-question marks and the criteria met or missed, once graded.
  report         jsonb,
  -- When the gate or the viva may be sat again, after a result below the bar.
  retake_after   timestamptz,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (user_id, concept_key, attempt_number)
);

create index assessments_concept_idx on assessments (user_id, concept_key, attempt_number desc);

create table assessment_answers (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references assessments (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  question_index int  not null check (question_index between 0 and 4),
  answer         text not null,
  -- The grade as recorded: criteria met, evidence quoted, confidence.
  grade          jsonb not null,
  score          int  not null check (score between 0 and 5),
  created_at     timestamptz not null default now(),
  -- One answer per question: a second submission cannot overwrite a grade.
  unique (assessment_id, question_index)
);

create table assessment_keys (
  assessment_id   uuid primary key references assessments (id) on delete cascade,
  correct_indexes jsonb not null,
  explanations    jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Row Level Security
 * ------------------------------------------------------------------ */

do $mig$
declare t text;
begin
  foreach t in array array['assessments', 'assessment_answers', 'assessment_keys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
    execute format('grant all on %I to postgres, service_role', t);
  end loop;
end
$mig$;

-- The learner may read their own sittings and answers. Every write goes
-- through the API, which marks them — a browser that could write here could
-- award itself marks.
create policy assessments_owner_read on assessments
  for select using (auth.uid() = user_id);
create policy assessment_answers_owner_read on assessment_answers
  for select using (auth.uid() = user_id);
grant select on assessments, assessment_answers to anon, authenticated;

-- assessment_keys: no policy, and no privilege, for anyone but the service role.
revoke all on assessment_keys from anon, authenticated;
