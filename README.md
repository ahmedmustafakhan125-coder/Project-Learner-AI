# AI Education Platform

Project-based programming education. A learner gives an area of interest, target
technologies, and a skill level; the platform generates a structured multi-step
coding project and walks them through it. Each step has the learner write the
code themselves, checks it, and only then explains the approach taken and the
alternative tools with their tradeoffs.

Web first. The domain layer is written so a React Native app can reuse it
without changes.

**Setup lives in [setup.md](setup.md).** The invariants you need before changing
anything are in [CONTEXT.md](CONTEXT.md).

## What the platform actually does

Three behaviours shape the whole pipeline.

**The context interview.** A query is never sent to a model as typed. The
platform fills in what it can infer from the learner's profile and current
project, asks a short batch of questions for what it genuinely cannot, and only
then compiles a full-context query. Which slots exist and whether enough is
known are decided by deterministic code — the model only extracts and phrases —
so the interview is testable without touching an API.

**The four-agent fan-out.** Every compiled query is answered four ways in
parallel: a plain explanation, industrial examples, a practice exercise, and the
key concepts to remember. All four share one SSE connection rather than opening
four, because browsers cap concurrent connections per origin at six and four
streams per question would starve the rest of the page.

**Two-phase project generation.** Phase A produces the plan and step stubs,
which the learner approves before anything is persisted or further generation is
paid for. Phase B writes one step at a time, as they approach it — so a step
that has not been written yet can still be reshaped by how the learner is
actually doing.

Around those: prompts are screened by a security gateway before they can reach a
model, every provider call is checked against a per-user daily budget, and each
step's work is checkpointed in the browser and saved as the learner goes.

## Getting started

```bash
npm install
cp .env.example .env      # set at least one provider key
npm run db:start          # Supabase local (needs Docker); copy the printed keys into .env
npm run smoke             # verify the provider layer end to end
npm run dev               # web on :3000, api on :3001
```

Two more steps that the commands above do not cover, and both will stop you:
the browser needs its own `apps/web/.env.local`, and the security gateway has to
be running or every question is refused. [setup.md](setup.md) walks through
both.

## Layout

```
apps/
  web/          Next.js 16 — rendering only            ask, projects, editor, sandbox
  api/          Fastify 5 — orchestration and SSE      interview, fan-out, projects, attempts
packages/
  llm/          provider-agnostic LLM layer            registry + 2 adapters
  core/         portable domain logic                  interview, agents, generation, pacing
  api-client/   typed SDK + SSE streaming              the only way the web app talks to the API
  runners/      checkpoint verification                static layers, short-circuiting
knowledge/      the OKF concept bundle, read at API startup
supabase/
  migrations/   schema + RLS                           14 tables, forced RLS on every one
```

A request for an answer goes: browser → `@ai-edu/api-client` → `POST
/api/agents/ask` → security gateway → budget check → `fanOut` in core → the LLM
layer → four agent streams multiplexed back over one SSE connection.

## Design decisions worth knowing

### The four agents share a byte-identical prompt prefix

Shared context is processed once and read three times instead of being paid for
four times. That saving depends on a detail that is easy to lose: a cache entry
only becomes readable once the request writing it is already in flight. So on a
provider with **explicit prompt caching**, the fan-out sends the lead request
alone, waits for its first token (bounded by a timeout), then releases the other
three. On providers without it, staggering would only add latency for nothing,
so all four go at once.

Nothing about a broken prefix fails loudly — no error, no red test, just
quadrupled cost. `packages/core/test/prompt-stability.test.ts` asserts the
invariant directly: all four agents render identical bytes up to the cache
boundary, and the shared pedagogy block contains no timestamp, UUID, or
interpolation.

### Checkpoints run in the learner's browser, and generation is held to that

A step's checkpoint has three layers: required files, required symbols, then
tests executed in a sandboxed iframe — Pyodide for Python, a bare JS realm for
web. The submission is written into that sandbox as *files*, so a test can read
`requirements.txt` by name and `import main` the way it would on a real machine.

That sandbox has the standard library and nothing else: no pip, no npm, no
network, no server. A step about installing FastAPI cannot be verified there,
and a test that cannot pass is worse than no test — it blocks a learner on work
they did correctly. So generation is held to the contract in code, not just in
the prompt: `packages/core/src/generation/runnable.ts` reads what a step's own
files import and turns off automatic checking when the sandbox could not have
run them, leaving the static layers to carry the step.

### Progress is server state, not page state

The editor's contents, the checkpoint verdict, the unlocked explanation, and the
hints already spent all live in one row per learner per step. Reopening a
project resumes it rather than replaying it. Passing is the exception: it is
derived from the attempts table, because it is a graded event and one source of
truth beats two that can disagree.

### Solution files never reach the browser early

Not before a step is attempted, and the explanation stays collapsed until the
learner asks for it — "why this approach" lands as trivia if it arrives before
they have hit the problem. The button says so rather than hiding the reason.

### `packages/core` and `packages/api-client` must stay portable

Two mechanisms enforce it, because the web app would work fine either way and
the constraint would otherwise rot silently. **Lint** bans Node builtins,
web-framework imports, and vendor SDKs. **The compiler** is the stronger guard:
`core` builds without the DOM lib, so `document` and `window` are type errors,
not warnings. `api-client` does compile with the DOM lib — it needs the
web-standard networking types React Native also implements — and is held to the
line by ESLint instead.

The browser sandbox runners are deliberately exempt. They cannot port, so mobile
will be a read/review/Q&A client with code authoring staying on web.

## Working with providers

Any OpenAI-compatible endpoint works — OpenAI, Gemini, DeepSeek, Kimi/Moonshot,
OpenRouter, Groq, Together, local Ollama or vLLM — plus Anthropic through its
own adapter. Two adapters cover all of them, and adding a model is a data edit
in `packages/llm/src/registry.ts` plus making the conformance suite pass:

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
   verified today; the API names the unverified models at startup.
3. **Capability differences are flags, never `if (provider === 'x')`.** An
   over-claimed capability fails at runtime, in production, on one provider only
   — so claim conservatively and let the conformance suite prove better.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | web on :3000, api on :3001 |
| `npm run build` | Build everything (Turborepo, cached) |
| `npm test` | 285 unit tests — no network, no browser, no keys |
| `npm run typecheck` | `tsc --noEmit` per workspace |
| `npm run lint` | ESLint, including the portability guards |
| `npm run smoke` | Live provider round-trip + cost accounting |
| `npm run db:start` / `db:reset` | Supabase local stack (`db:reset` destroys local data) |
| `npm run test:containment --workspace @ai-edu/web` | Drives a real browser at the sandbox. Needs `npm run build` and an installed Chrome or Edge. |

## Status

Each phase runs **Build → Verify logic → Test logic → Test phase** and ends on
an explicit exit criterion.

| Phase | State |
|---|---|
| **P0** Scaffold + provider layer | Built and verified. Exit criterion (`npm run smoke`) needs an API key. |
| **P1** Interview + 4-agent Q&A | Built: interview, fan-out, SSE multiplex, 4-tab UI, auth, budgets, attachments. |
| **P2** Project generation | Built: two-phase generation, blueprint approval, lazy expansion with prefetch, project shell and step view. |
| **P3** Checkpoint flow | Built and verified. Monaco and Pyodide self-hosted, sandbox served from `/sandbox`, static verification, tiered hints, saved progress. |
| **P4** Pacing + tracking | Built and wired end to end. `scorePacing` feeds step expansion and the directive is surfaced to the learner. |
| **P5** Hardening | Mostly built: rate limits, input caps, restrictive RLS, security gateway. |

Known and open, none of it blocking:

- The sandbox result is advisory. Learner code runs with `parent.postMessage` in
  scope and can forge a pass; the server-side static layers stay authoritative.
  Closing it properly means running tests where the learner's globals cannot
  reach.
- `attempt_no` is derived from a count, so two concurrent submissions can race.
- Layer 2 is a substring check, so a required symbol inside a comment counts.

## Tests

`npm test` is hermetic — no network, no browser, no keys, no database.

| Package | Tests | What they protect |
|---|---:|---|
| `@ai-edu/core` | 134 | prompt-prefix stability, interview logic, fan-out stagger and isolation, generation schemas, prefetch policy, pacing, knowledge determinism, sandbox-runnability guard |
| `@ai-edu/llm` | 68 | registry, cost nulls, stream utils, adapter mapping, structured-output repair, retry backoff |
| `@ai-edu/api` | 47 | attachment allowlist, binary detection, PDF extraction, gateway failure policy, OKF loader |
| `@ai-edu/web` | 14 | sandbox configuration guards, CSP shape, error containment |
| `@ai-edu/api-client` | 13 | SSE framing across chunk boundaries, multi-byte splits, CRLF, errors |
| `@ai-edu/runners` | 9 | static verification layering and short-circuiting |

The containment suite is separate (`npm run test:containment --workspace
@ai-edu/web`) because it builds the app, starts the production server, and
drives a real browser. It attempts three real sandbox escapes, and carries a
fourth test that rebuilds the frame *with* `allow-same-origin` and asserts the
escape then succeeds — without that, there is no evidence the other three can
fail, and a containment test that cannot fail is decorative.

Database behaviour is verified directly against Postgres rather than in unit
tests: migrations apply clean, and RLS was proven to isolate two users across
SELECT, UPDATE and INSERT, with every table confirmed to have forced RLS and a
policy.
