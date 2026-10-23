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

## Phase 2 — done (branch `pl-2-research-brief`, 2026-10-23)

The four tasks are committed one per task. Every phase 2 "done when" check
holds:

- `npm run typecheck` passes (12 of 12 tasks). `npm test` passes 1,524
  tests (1,081 after phase 1): llm 135, core 1,012, api 194. ESLint is clean
  on `packages` and `apps`. `npm run lint` still runs no task (phase 1 note).
- Invariant 18: `packages/core/test/complexity.test.ts`. Invariant 21:
  `prompt-stability.test.ts` (research, brief and scoped classify prompts),
  plus `classify-signals.test.ts`. Invariant 22: `stack-brief.test.ts`.
  Invariants 23 and 25: `research.test.ts`.
- Live `systems-os` research returned 6 allowlisted references (c: 2,
  osdev-core: 4). The second run hit `research_dossiers` and made no search.
  About $0.07 a run.
- 3 live briefs pass `verifyStackBrief` on the first attempt with nothing
  repaired: kernel T5 $0.068, Lox T2 $0.029, Tauri T3 $0.045.
- Live spend for the whole phase: about $0.60 (4 research runs, 6 briefs).
- With the flag off the app runs as before: web 200, API health 200.

The live suites are opt-in, and they load the repository env file the way
the API does:
`npm run test:research --workspace @ai-edu/api -- research.live` and `-- brief.live`.
Set `RECORD_FIXTURES=1` to re-record the fixtures.

### For you to review (drafted in phase 2; there were no phase 0 drafts)

1. `knowledge/tech/*.md`: 8 cards, all `status: draft`. Pins: Tauri 2,
   Rust 1, Python 3, SQLite 3. QEMU, Limine, the cross toolchain and Lox
   have no pin (`null`), because I could not verify them. Check the install
   lines and the Limine docs URL.
2. `knowledge/docs/sources.json`: domains, entry URLs and the `general`
   blocked list.
3. `packages/core/test/fixtures/scoping-goldens.ts`: 31 requests with their
   expected profile and tier. The cut points and floors are tuned to them.
4. The profile layer lists, slots and floors in `packages/core/src/profiles/`.
5. The recorded briefs in `packages/core/test/fixtures/briefs/` and the
   dossier in `packages/core/test/fixtures/research-live.response.json`. Note
   prompt fixes here.

### Found on the way

1. **The 20260318 tools return no citation blocks.** The model reads pages
   through code execution (dynamic filtering) and writes each page's URL at
   the end of the bullet. `parseDossier` turns an inline URL into a reference
   only when a server tool returned that page, and removes it otherwise.
   These references have an empty `citedText`, because no quote comes back,
   and fetched documents have no title, so the title is built from the URL.
   If the UI needs snippets, try `web_fetch_20250910` with citations. §7 says
   fetch citations are on; update it.
2. The model did not search until the prompt said "one web search per key
   first". It used 2 of 3 searches and 4 of 4 fetches.
3. A text block that starts with `#` right after a sentence lost its
   heading. `parseDossier` now starts it on a new line. A regression test
   covers this.
4. The first Lox brief hit the T2 brief `maxTokens` of 4,000 (truncated
   structured output). I did not raise `PROJECT_MODELS`. Instead, the brief
   prompt now asks for a tight brief, and language-tooling T2 requires 4
   layers (§5: 2 to 4). The kernel brief fell from 6,759 to 4,894 output
   tokens.
5. Whether structured output combines with server tools is still untested
   (§7). Research uses `complete()` plus `parseDossier`.

### Open for phase 3 and later

1. **Questions for profile slots.** `questionSlots` (complexity.ts) picks
   the slots, but `generateQuestions` resolves keys through `slotDef`, which
   knows only `SLOT_CATALOG`, so profile slots would be dropped. Let it take
   `SlotDef[]` (questions.ts). `compileQuery` renders only the base slots
   (compile.ts), so tier and profile answers are missing from
   `compiled.text`. They are still in `compiled.slots`.
2. **The ten basic profiles have no research keys and no cards.** At T1 their
   dossier is empty, so every brief fails `grounded` (`LayerChoice.docRefs`
   needs at least one ref). At T2 and up, only the technologies the learner
   named get researched. Before phase 3 serves them, add cards or `research`
   keys, or decide how the route handles `BriefRejectedError`.
3. **Usage recording (invariant 16).** `runProjectResearch` returns `usage`
   and `model` for `recordUsage` under `project:research`. `BriefRejectedError`
   carries the usage it spent; record that too. `LLMUsage.webFetchRequests`
   has no column. Fetches have no fee, so nothing needs one.
4. **Invariant 28 inputs.** `BRIEF_MAX_ATTEMPTS` is 2. Research runs once,
   but the adapter sends up to 3 `pause_turn` continuations of that one turn
   (`MAX_PAUSE_CONTINUATIONS`), each a billed request. Count them in
   `projectCostCeiling`.
5. **Invariant 21, second half.** The test that the brief, blueprint and
   dossier prefix is byte-identical across every step expansion belongs with
   the blueprint and expand changes in phase 3.
6. **Wiring the classify call.** It takes `scoping: true` only from callers
   that pass it. The intake route should pass it with the flag on, then
   call `detectProfile` and `scoreComplexity`.
7. The local `research_dossiers` holds `c` and `osdev-core` until
   2026-11-22. Delete those rows to force live research.
8. `apps/web/next-env.d.ts` was modified before this phase. I left it
   uncommitted.

## Phase 3 — done (branch `pl-3-intake-ui`, 2026-10-23)

The four tasks are committed one per task. Two additions came from you
mid-phase: the template path (adapt a very similar stored project) and
updating the plan. Every phase 3 "done when" check holds:

- `npm run typecheck` passes (12 of 12). `npm test` passes 1,622 tests
  (1,524 after phase 2): llm 137, core 1,051, api 219, api-client 26,
  web 132, gateway 48, runners 9. `npx eslint packages apps` is clean.
  `npm run lint` still runs no task (phase 1 note).
- Invariant 17: `packages/core/test/verify-blueprint.test.ts` and
  `apps/api/test/intake.test.ts`. Invariant 27: `verify-blueprint.test.ts`,
  with a passing and a failing plan for `desktop-app`, `systems-os`,
  `language-tooling` and `general`. Invariant 28:
  `packages/core/test/cost-ceiling.test.ts` (T1 $0.574, T3 $1.452 worst
  case). Invariant 21, prefix half: `prompt-stability.test.ts`.
- Three live runs from the real interview to step 1, read from
  `llm_usage`: kernel `systems-os` T5 $0.41, Lox `language-tooling` T2
  $0.30, Tauri `desktop-app` T3 $0.30. The full table is in §11.
- Migration `0016_intake_plan.sql` is applied to the local database with
  `supabase migration up --local`. It is not applied to the cloud project.
- With the flag off the intake routes are not even loaded, and
  `/api/features` says `projectLearner: false` (`intake-flag.test.ts`).

Live spend for the phase: $1.19 recorded, plus about $0.24 that was never
recorded (item 1 below). That includes two aborted runs whose test driver
answered the interview badly.

### What changed outside the four tasks

1. **Template reuse** (your request). `generation/template.ts` matches on
   the same profile, the same tier, exactly the same named technologies and
   a word overlap of at least 0.7. The dossier and brief are copied with no
   call, the plan is adapted on the new `adapt` stage of `PROJECT_MODELS`
   (Sonnet), and step 1 is copied when step 1, step 2 and the file plan are
   unchanged. Not yet seen live: the three goldens differ from one another.
2. **The Anthropic adapter** (`packages/llm`): paused research turns now
   share one `maxTokens` budget. Without that, invariant 28 could not hold.
3. **Two ceilings raised**, each with §11 and the test updated: brief T1
   and T2 from 4,000 to 6,000 (a live Lox brief was truncated again), and
   step T2 from 8,000 to 12,000 (the Lox step 1 has twelve files and was
   truncated three times running).
4. `apps/web/app/globals.css` gained a block for the new components.
   `BlueprintReview` takes `canRegenerate`. `classify.ts` exports
   `CLASSIFY_MAX_TOKENS`, and `expand.ts` exports `EXPAND_MAX_ATTEMPTS`.
5. `server.ts` allows `PATCH` in CORS and serves `GET /api/features`.
6. **Sign-up bug** (your report): "Invalid path specified in request URL"
   is what Supabase answers when the client's URL ends in `/rest/v1`, the
   REST URL `supabase status` prints beside the API URL. Reproduced against
   local Supabase. `apps/web/lib/supabase.ts` now strips a service suffix
   and trailing slashes (`supabaseBaseUrl`, tested), and `.env.example`
   says which URL to use. Still set `NEXT_PUBLIC_SUPABASE_URL` in
   `apps/web/.env.local` to the plain API URL, `http://127.0.0.1:54321`.
   Production failed the same way: Vercel was built with the dashboard's
   RESTful endpoint (`https://<ref>.supabase.co/rest/v1/`), seen in the
   live bundle. The function now also strips `/graphql/v1`, which fails
   the same way, and anything after a service path. Set the Vercel
   variable to the project URL as well.

### How to see it in the browser

Your dev servers on :3000 and :3001 were already running, so I did not
stop them. I ran the new API on :3002 with `PROJECT_LEARNER=on` set in the
process environment; the env file was not touched. A second `next dev`
refused to start while yours holds the `.next` lock. To use the new flow,
set `PROJECT_LEARNER=on` in the repository env file and restart
`npm run dev`. The web reads the flag from `/api/features`, so the web
side needs no change. A test learner, `phase3-live@learner.test`, owns the
three live projects in the local database.

### Open for phase 4 and later

1. **A truncated structured call records no usage** (invariant 16 gap).
   `LLMStructuredOutputError` carries no `usage`, so a call cut off at
   `maxTokens` bills its full output and leaves no `llm_usage` row. Give
   the error the response's usage and record it in the routes.
2. **The ten basic profiles cannot get a brief without a named, carded
   technology.** Their dossier is empty, so `verifyStackBrief` rejects
   every layer as `grounded` and the route answers 502. This was seen live:
   "an operating system" answered as "Web app" became `web-fullstack`.
   Draft `sources.json` entries and cards, or `research` keys, for those
   profiles (phase 0-style data work), or decide to ground on profile entry
   pages.
3. **The interview is not scoped.** `/api/interview/*` still classifies
   without `scoping: true`, so tier and profile slots are never asked and
   the intake's own classify call does the scoping afterwards (phase 2
   items 1 and 6 still stand).
4. The Lox step 1 came back with `runtime: none` and no tests:
   `groundCheckpoint` stripped them, probably because the corpus runner
   uses a subprocess. The solution self-test (phase 4) is where this shows.
5. Tauri step 1's first attempt left 11 of its 13 files out (repaired by
   its one retry). The blueprint put 13 files in step 1, and Lox 12. A
   `verifyBlueprint` warning on a very large first step may be worth adding.
6. Not built from `verifyBlueprint`'s list (§9): milestone count, every
   layer used by a planned file, the dependency manifest, `docTopics` and
   `needsDocs`. `forbiddenImports` belongs to `verifyDependencies`.
7. Reused briefs may carry phrasing pitched at the first learner's memory.
   Only model output is copied, but if that matters, adapt the brief too
   or reuse only briefs written without memory.
8. Approved intakes never expire (`purge_expired_intakes` keeps them).
   Expire approved rows that never became a project.
9. The step page still requests step N+1 eagerly and ignores the 403
   (phase 1 item 7).
10. Apply `0015` and `0016` to the cloud project only when the flag flips
    in production (phase 7).

## Outside the phases — brain tests and the workspace on Argon (branch `brain-tests-argon`, 2026-10-23)

Your request: the brain's tests were not working; run them on Gemini 4
Argon, make Argon the default in the four-agent workspace with every other
model hidden, and put your ghost bot in the brain's test section. None of it
is behind `PROJECT_LEARNER`.

**Why the tests failed.** "Test me on this" generated on `review`, which is
Gemini 3.6 Flash with json-mode. The local `llm_usage` has two
`assessment:generate` calls from 15:08 with about 410 output tokens each and
no saved sitting. Both returned JSON, but a full test is 5 MCQs plus 5
rubric'd viva questions, and both failed `validateGeneratedAssessment`, so
the route answered 502 `generation_failed`.

**What changed**
1. `packages/llm`: a new `assessment` TaskKind resolves to `gemini-4-argon`
   with the flag on or off. Its chain holds only models whose output limit
   covers 16,000 tokens, and with the flag on a pick is ignored, as for the
   tutor. `fanout` (the fan-out and its follow-ups) now leads with Argon. With
   the flag off the tutor follows `fanout`, so it lands on Argon too. The
   interview stays on Flash.
2. `PICKER_MODELS = ['gemini-4-argon']` and `listPickerModels()`:
   `/api/models` lists only Argon. Hidden models still resolve for stored
   choices. The ask page names the one model in a chip instead of a one-item
   menu.
3. The assessment generator's `maxTokens` goes from 6,000 to 16,000, and the
   grader's from 1,500 to 6,000. Gemini's thinking page says the limit
   "sets the maximum number of tokens a response can generate, including
   thought tokens". Argon defaults to medium thinking.
4. `apps/web/public/bots/ghost.png` is made from your image (plate removed,
   eyes kept, 151×132 like the other bots). It sits beside "Test me on this"
   and leans while the test is written.
5. Tests: the invariant 15 file (`registry.policy.test.ts`) pins the new
   routing and the picker; `brain-replay.test.tsx` pins the bot. §1, §4 and
   the rules list in the plan, and CLAUDE.md, now say Argon for these jobs.

**Open**
1. Not run live: no Argon assessment has been generated yet. Argon passed
   conformance with `native-schema` in phase 1.
2. Cost. Argon is $4 / $20 per million tokens against Flash's $0.75 / $3.75,
   and thinking is billed as output. A fan-out question is four Argon calls.
   A first sitting is one generation and ten grading calls (each viva answer
   is graded twice). The $2 daily allowance will run out several times
   sooner.
3. The OpenAI-compatible adapter never sends `reasoning_effort`. Gemini's
   compatibility layer accepts it for Argon (`low`, `medium`, `high`;
   `minimal` maps to `low`). Sending `low` for grading would cut cost, but it
   needs adapter support and a conformance run.
