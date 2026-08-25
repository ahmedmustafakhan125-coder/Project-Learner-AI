# AI Education Platform

Project-based programming education. A learner gives an area of interest, target
technologies, and a skill level; the platform generates a structured multi-step
coding project with a guided tutorial. Each step has the learner write the code
themselves, then explains the approach taken and the alternative tools with
their tradeoffs.

Two behaviours shape the whole pipeline:

- **Context interview** — a query is never sent to a model as typed. The
  platform fills in what it can infer, asks a short batch of questions for what
  it genuinely cannot, and only then compiles a full-context query.
- **Four-agent fan-out** — every compiled query is answered four ways in
  parallel: plain explanation, industrial examples, a practice exercise with a
  runnable HTML UI, and key concepts to remember.

Web first; the domain layer is written so a React Native app can reuse it
without changes.

## Getting started

```bash
npm install
cp .env.example .env      # set at least one provider key
npm run db:start          # Supabase local (needs Docker)
                          # copy the printed keys into .env
npm run smoke             # verify the provider layer end to end
npm run dev               # web on :3000, api on :3001
```

`npm run smoke` is the P0 gate: it round-trips a structured request through
every configured provider, prices it, and writes a verified `llm_usage` row.

## Layout

```
apps/
  web/          Next.js 16 — rendering only              ✅ ask + projects
  api/          Fastify — orchestration, SSE, budgets    ✅ interview, fan-out, projects
packages/
  llm/          provider-agnostic LLM layer              ✅
  core/         portable domain logic                    ✅ interview, agents, generation
  api-client/   typed SDK + SSE streaming                ✅
  runners/      browser sandboxes (web-only)             ⬜ P3
  ui/           design tokens                            ⬜ (tokens live in web CSS for now)
supabase/
  migrations/   schema + RLS                             ✅ 13 tables
```

## Working with providers

Any OpenAI-compatible endpoint works — OpenAI, DeepSeek, Kimi/Moonshot, Groq,
Together, OpenRouter, local Ollama or vLLM — plus Anthropic through its own
adapter. Two adapters cover all of them.

Adding a model is a data edit in `packages/llm/src/registry.ts` plus making the
conformance suite pass:

```bash
npm run test:conformance --workspace @ai-edu/llm
```

Three rules keep this layer honest:

1. **Claude never goes through the OpenAI-compatible adapter.** It would
   silently lose explicit prompt caching, adaptive thinking, and the 1M context
   window.
2. **`pricing: null` means nobody has verified the numbers.** Cost is then
   recorded as `null`, never `0` — a zero reads downstream as "this call was
   free" and quietly defeats budget enforcement. Fill real numbers from the
   vendor's own pricing page, then stamp `verifiedOn`. Only Anthropic is
   verified today.
3. **Capability differences are flags, never `if (provider === 'x')`.** An
   over-claimed capability fails at runtime, in production, on one provider
   only — so claim conservatively and let the conformance suite prove better.

## The caching design (and why a test guards it)

The four agents share one byte-identical prompt prefix and differ only in a
trailing instruction, so shared context is processed once and read three times
instead of being paid for four times.

That saving depends on a detail that is easy to lose: **a cache entry only
becomes readable once the request writing it is already in flight.** Firing all
four at once means none can read what the others are still writing, and every
one pays full price. So the fan-out sends the lead request alone, waits for its
first token (bounded by a timeout), then releases the other three.

Nothing about a broken prefix fails loudly — no error, no red test, just
quadrupled cost. So `packages/core/test/prompt-stability.test.ts` asserts the
invariant directly: all four agents render identical bytes up to the cache
boundary, and `PEDAGOGY_CORE` contains no timestamp, UUID, or interpolation.


## Why project generation runs in two phases

Generating a whole project in one call is slow, expensive, and — the part that
actually matters — forecloses adaptation. A project written up front can only be
followed.

So Phase A produces the plan and step *stubs*, which the learner approves before
anything is persisted or further generation is paid for. Phase B writes one step
at a time, as they approach it. A step that has not been written yet can still
be reshaped by how the learner is actually doing, which is what makes P4's
adaptive pacing possible at all rather than cosmetic.

The blueprint is stored verbatim and sent as a cached prefix to every expansion,
so writing step 7 re-reads the plan rather than re-paying for it.

Two details the UI enforces deliberately:

- **Solution files never reach the browser** before a step is attempted.
  Shipping the whole project's steps at once would hand over every answer.
- **The explanation is collapsed by default.** "Why this approach" lands as
  trivia if it arrives before the learner has hit the problem; the button says
  so rather than hiding the reason.

## Portability guard

`packages/core` and `packages/api-client` must run unchanged under React
Native. Two mechanisms enforce that, because the web app would work fine either
way and the constraint would otherwise rot silently:

- **Lint** bans Node builtins, web-framework imports, and vendor SDKs there.
- **The compiler** is the stronger guard: `packages/core` builds without the DOM
  lib, so `document` and `window` are type errors, not warnings.

`packages/api-client` does compile with the DOM lib, because it needs the
web-standard networking types (`fetch`, `Response`, `ReadableStream`) that React
Native also implements. Actual DOM access there is banned by ESLint instead.

The browser sandbox runners (iframe, Pyodide) are deliberately exempt — they
cannot port to native, so mobile will be a read/review/Q&A client with code
authoring staying on web.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | web on :3000, api on :3001 |
| `npm run build` | Build everything (Turborepo, cached) |
| `npm test` | Unit tests — no network, no keys needed |
| `npm run lint` | ESLint, including the portability guards |
| `npm run smoke` | Live provider round-trip + cost accounting |
| `npm run db:start` / `db:reset` | Supabase local stack |

## Build phases

Each phase runs **Build → Verify logic → Test logic → Test phase** and ends on
an explicit exit criterion. The full plan is at
`~/.claude/plans/this-is-a-platform-flickering-galaxy.md`.

| Phase | Status |
|---|---|
| **P0** — Scaffold + provider layer | Built and verified. Exit criterion (`npm run smoke`) needs an API key. |
| **P1** — Interview + 4-agent Q&A | Built: interview pipeline, staggered fan-out, SSE multiplex, 4-tab UI, auth, budgets. Remaining: attachment upload endpoint + UI; end-to-end run against a live key. |
| **P2** — Project generation | Built: two-phase generation, blueprint approval, lazy step expansion with prefetch, project shell + step view. Remaining: live run against a key. |
| **P3** — Checkpoint flow | Not started |
| **P4** — Pacing + tracking | Not started |
| **P5** — Hardening | Not started |

### Test coverage today

| Package | Tests | Covers |
|---|---:|---|
| `@ai-edu/llm` | 60 | registry, cost, stream utils, adapter mapping, structured-output repair |
| `@ai-edu/core` | 99 | prompt-prefix stability, interview logic, fan-out stagger and isolation, generation schemas and prefetch policy |
| `@ai-edu/api-client` | 13 | SSE framing across chunk boundaries, multi-byte splits, CRLF, errors |
| `@ai-edu/api` | 13 | attachment type allowlist and binary detection |

Database verification is not unit-tested but was run directly against Postgres:
the migration applies clean, and RLS was proven to isolate two users across
SELECT, UPDATE, and INSERT — including a check that all 13 tables have forced
RLS with a policy.
