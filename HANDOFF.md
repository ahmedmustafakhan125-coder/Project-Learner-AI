# HANDOFF

Notes passed between Project Learner phases (docs/project-learner.md §15).

## Phase 1 — done (branch `pl-1-foundation`, 2026-10-23)

All six "done when" checks hold except where noted:

- `npm run typecheck` and `npm test` pass: 1,081 tests (970 at the start).
- Lint: no errors in source. `npm run lint` runs no task (no workspace defines
  `lint`), and `npx eslint .` reports 205 errors, all in
  `supabase/.temp/…/index.ts`, which the Supabase CLI generates. Add
  `supabase/.temp/**` to the ESLint ignores and a `lint` script per workspace.
- Invariant 15: `packages/llm/test/registry.policy.test.ts`. Invariant 16:
  `apps/api/test/usage-recorded.test.ts` (route tests plus the source check).
- 0015 applied to the local database with `supabase migration up --local`,
  not `npm run db:reset`, to keep local data. The RLS live suite passes 13/13
  against it, including the new intake cases.
- Flag off: routing, user pick, eager prefetch and the daily budget behave as
  before (tested). Two deliberate changes apply whatever the flag: Gemini is
  now priced at its real $0.75 / $3.75 (Q&A budgets count about 7.5x more
  spend than before), and project calls now record real usage.

### Found and fixed on the way

- Claude `structured()` never worked: the SDK's `zodOutputFormat` takes zod v4
  schemas and threw on every v3 schema before sending. The adapter now builds
  the format with `zodToJsonSchema` and the SDK's `jsonSchemaOutputFormat`,
  and validates with the caller's schema. Unit-tested against a recorded
  client; **not yet run live** (see below).
- The RLS live suite's setup insert lacked the required `skill_level`.
- `interview:start` recorded zero usage; it now meters its calls
  (`meterUsage`). `/api/interview/continue` still records nothing at all.

### Open for phase 2 and later

1. Run `npm run test:conformance --workspace @ai-edu/llm` with
   `CONFORMANCE_MODELS=claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`
   now that the Console has credits. The first run failed only on
   "credit balance is too low". It is the first live proof of the structured
   output fix, `output_config.effort` and adaptive thinking on 5.5. Watch for
   structured-output schema keywords the API rejects (`.default()` fields are
   optional in the JSON schema).
2. `gemini-4-argon` passed conformance live with `native-schema`.
   `reasoningControl` stays `none`: the OpenAI-compatible adapter never sends
   `reasoning_effort`, so claiming `effort` would change nothing.
3. Mid-conversation system messages are not claimed for Claude 5.5 (not
   verified); the adapter degrades them to a user turn.
4. Prices to bump: Gemini 3.6 Flash doubles on 2027-01-01 (registry holds the
   current price). Gemini 4 Argon and Claude Haiku 5.5 already hold their
   higher price.
5. Web search pricing ($10 per 1,000) is not in `computeCost` yet (phase 2,
   task 2). `LLMUsage.webSearchRequests` and the `web_searches` column exist;
   `recordUsage` writes the column only when a call searched, so it keeps
   working on databases without 0015.
6. With the flag on, the existing blueprint, expand and finish routes plan at
   `DEFAULT_PROJECT_TIER` (T3) until intake scores a tier (phase 3).
7. The prefetch gate refuses step N+1 with 403 `step_locked` until step N has a
   draft or an attempt. The web still requests it eagerly and ignores the
   refusal, so nothing visible changes; phase 3 can stop asking.
8. `purge_expired_intakes()` exists but nothing calls it yet; call it from the
   intake route in phase 3.
9. `research_dossiers` is in 0015 (phase 1 task 5), not a later migration as
   §12 says. Update §12.
10. `docs/project-learner.md` and `HANDOFF.md` were committed on this branch,
    not on `main` as phase 0 asked.
