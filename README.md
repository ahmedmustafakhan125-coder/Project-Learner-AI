# Project Learner

Project-based programming education. A learner gives an area of interest,
target technologies, and a skill level; the platform generates a structured
multi-step coding project and walks them through it. Each step has the learner
write the code themselves, checks it, and only then explains the approach taken
and the alternative tools with their tradeoffs.

The point is the inversion: you do not watch someone build the thing, you build
it and the platform explains what you just did.

Web first. The domain layer is written so a React Native app can reuse it
without changes.

**To run it, read [DEPLOY.md](DEPLOY.md)** — local development and production
deployment live there. **Before changing anything, read
[§ Invariants](#invariants) below.** Those eight are load-bearing, and breaking
any of them produces no error — just silently worse behaviour, silently higher
cost, or a feature that quietly stops running.

---

## Contents

- [What the platform does](#what-the-platform-does)
- [Architecture](#architecture)
- [Invariants](#invariants) — read before changing anything
- [The provider layer](#the-provider-layer)
- [Conventions](#conventions)
- [Commands](#commands)
- [Status](#status)
- [Tests](#tests)

---

## What the platform does

Five behaviours shape the whole pipeline.

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
streams per question would starve the rest of the page. Any single answer can
then be pressed further on its own — a follow-up thread hangs off one
specialist, which is where holding four different angles actually pays off.

**Two-phase project generation.** Phase A produces the plan and step stubs,
which the learner approves before anything is persisted or further generation is
paid for. Phase B writes one step at a time, as they approach it — so a step
that has not been written yet can still be reshaped by how the learner is
actually doing.

**Checkpoints in the learner's own browser.** Each step's work is verified in
three layers: required files, required symbols, then tests executed in a
sandboxed iframe — Pyodide for Python, a bare JS realm for web. Progress,
hints spent, and the editor's contents are saved as the learner goes.

**A project you keep.** The steps taught the learner to build the thing; the
finished project *is* the thing, assembled out of the code they actually wrote
plus a README and deploy config written against that code, downloadable as a
ZIP. Alongside it runs a project tutor — a conversation whose subject is the
codebase being built, gated so it explains and points rather than handing over
the answer.

Around all of it: prompts are screened by a security gateway before they can
reach a model, every provider call is checked against a per-user daily budget,
and each step's work is checkpointed in the browser and saved as the learner
goes.

---

## Architecture

```
apps/
  web/          Next.js 16 — rendering only            ask, projects, editor, sandbox
  api/          Fastify 5 — orchestration and SSE      interview, fan-out, projects,
                                                       attempts, follow-ups, tutor
packages/
  llm/          provider-agnostic LLM layer            registry + 2 adapters
  core/         portable domain logic                  interview, agents, generation,
                                                       pacing, knowledge, tutor
  api-client/   typed SDK + SSE streaming              the only way the web app talks
                                                       to the API
  runners/      checkpoint verification                static layers, short-circuiting
knowledge/      the OKF concept bundle, read at API startup
supabase/
  migrations/   schema + RLS                           16 tables, forced RLS on every one
```

Two things sit in front of every model call, both in `apps/api` because
`packages/core` must stay portable ([invariant 4](#4-packagescore-and-packagesapi-client-must-stay-portable)):

- `gateway.ts` — screens every learner-supplied string before it reaches a model.
- `knowledge.ts` — loads the OKF bundle off disk; selection and rendering are
  pure and live in `packages/core/src/knowledge/`.

**A question:**

```
query -> gateway (ALLOW / MASK / BLOCK)
      -> interview (classify, auto-fill, score) -> CompiledQuery
      -> gateway again, at /api/agents/ask
      -> fanOut (staggered, + selected OKF concepts) -> SSE multiplex -> 4 tabs
```

The gateway appears **twice on purpose**. `/api/agents/ask` accepts a
client-supplied `CompiledQuery` — the browser posts the finished prompt object —
so anything screened only during the interview is bypassed by posting straight
to that route. The same is true of `/api/projects/blueprint`. Screening at the
interview alone enforces nothing.

Screening runs **before** the budget check and before a provider is constructed,
so a blocked prompt costs nothing. Model-bound routes fail **closed**: if the
gateway cannot be reached, the request is refused rather than sent unscreened.

**A project:**

```
goal -> interview -> CompiledQuery -> blueprint (Phase A, approved by learner)
     -> persist stubs -> expand step N on demand (Phase B) + prefetch N+1
     -> checkpoint per step -> assemble the finished project
```

Phase B runs late **on purpose**: a step not yet written can still be reshaped
by how the learner is doing. That is what makes adaptive pacing real rather than
cosmetic.

---

## Invariants

Eight things that will bite you. Each is non-obvious and each is load-bearing.
Code comments elsewhere in the repo cite these by number.

### 1. The four agents must share a byte-identical prompt prefix

`PEDAGOGY_CORE` in `packages/core/src/agents/prompts.ts` is the cached prefix
for every fan-out request. Prompt caching is a **prefix match**: one
interpolated timestamp, user id, or `Date.now()` anywhere in it and every cache
read across the entire application stops working. Nothing fails. No test goes
red. Cost simply quadruples.

Per-agent differences go in a **trailing** `{role: "system"}` message, never in
the system prompt. `packages/core/test/prompt-stability.test.ts` asserts this
directly — all four agents must render identical bytes up to the cache boundary,
and the shared pedagogy block must contain no timestamp, UUID, or interpolation.
If you change prompt assembly, run it.

### 2. The fan-out staggers its lead request on purpose

A cache entry only becomes readable once the request writing it is **already in
flight**. Fire all four agents simultaneously and none can read what the others
are still writing, so every one pays full price.

So on a provider with **explicit prompt caching**, `fanOut()` sends the `simple`
agent alone, waits for its first token (bounded by a 2s timeout so a stalled
lead cannot block the answer), then releases the other three. On providers
without explicit caching, staggering would only add latency for nothing, so all
four go at once.

If you "simplify" this into `Promise.all`, you have just quadrupled the cost of
every question with no visible symptom.

### 3. Unverified model pricing is `null`, never `0`

In `packages/llm/src/registry.ts`, an entry carries real prices only once
someone has opened the vendor's own pricing page and stamped `verifiedOn`.
DeepSeek and Kimi ship with `pricing: null` deliberately, as does
`openrouter/auto` — a router with no fixed price of its own.

`computeCost()` returns `totalUSD: null` for those. A `0` would read downstream
as "this call was free" and silently defeat budget enforcement. **Never fill
these in from memory.** A unit test enforces that any entry with pricing also
carries a date, and the API names every unpriced model at startup.

### 4. `packages/core` and `packages/api-client` must stay portable

They must run unchanged under React Native. Two mechanisms enforce it, because
the web app would work fine either way and the constraint would otherwise rot
silently:

- **ESLint** bans Node builtins, web-framework imports, and vendor SDKs there.
- **The compiler** is the stronger guard: `packages/core` builds with
  `"lib": ["ES2023"]` and no DOM, so `document` and `window` are *type errors*,
  not warnings.

`packages/core` therefore cannot name `AbortSignal` either — it is derived from
the LLM request type in `src/platform.ts` rather than pulling in the DOM lib.

`packages/api-client` *does* compile with the DOM lib, because it needs
`fetch`/`Response`/`ReadableStream`, which React Native also implements. Actual
DOM access there is banned by `no-restricted-globals` instead.

The browser sandbox runners are deliberately exempt. They cannot port, so mobile
will be a read/review/Q&A client with code authoring staying on web.

### 5. Attachment and model output is untrusted

Learners upload arbitrary files, and file text flows into prompts. It is wrapped
in `<attachment>` delimiters, and `PEDAGOGY_CORE` instructs the model to treat
anything inside as data, never as instructions.

The UI does **not** use a Markdown library. `apps/web/lib/markdown.tsx` splits
code fences and renders everything as plain text nodes — a Markdown renderer
with raw-HTML support would be a direct XSS path from model output.

The practice exercise runs in `sandbox="allow-scripts"` **without**
`allow-same-origin`. That combination gives the frame an opaque origin. Adding
`allow-same-origin` alongside `allow-scripts` lets the frame remove its own
sandbox attribute — the two together are equivalent to no sandbox at all.

Note what the sandbox attribute does *not* do: it does not block `fetch`. An
opaque-origin document can still issue requests; they simply carry
`Origin: null`, and anything answering `Access-Control-Allow-Origin: *` is
readable. Network containment comes from the sandbox document's `connect-src`.
Confusing the two produces code that looks contained and is not.

### 6. The sandbox is a route, not a `srcdoc`, and that is not cosmetic

A frame created from a **local scheme** — `srcdoc`, `about:blank`, `blob:`,
`data:` — has no response of its own, so it **inherits the parent's CSP**. The
app policy has no `'unsafe-inline'`, which means an inline `<script>` inside a
`srcdoc` sandbox is *refused*. The frame loads, reports nothing, and the parent
waits forever. No error reaches the UI.

That is why the sandbox is served from `/sandbox`
(`apps/web/app/sandbox/route.ts`). A document loaded from a real URL is governed
by the CSP on its own response, set independently in `apps/web/lib/csp.mjs`.

Inside that document, **`'self'` is meaningless**. The frame's origin is opaque,
so `'self'` resolves against it and matches nothing — not even the origin that
just served the frame. The sandbox policy names the app origin explicitly, and
`/pyodide/*` is served with CORS headers because the frame fetching its own
runtime is, from the browser's point of view, a cross-origin request.

Both facts were verified in Chrome, against a no-CSP control. If you are ever
tempted to move this back to `srcdoc` to "simplify" it, the symptom you will get
is a checkpoint that silently never runs.

### 7. The app's own CSP needs a per-request nonce, and that forces dynamic rendering

The mirror image of invariant 6. Next delivers its hydration payload in
**inline** `<script>` tags, so a policy with neither `'unsafe-inline'` nor a
nonce refuses them and the page renders as dead HTML — it looks completely fine
and nothing on it works.

`apps/web/proxy.ts` mints a per-request nonce and sets the CSP on the *request*
headers, which is where Next reads it back out to stamp its scripts. (Next 16
renamed `middleware.ts` to `proxy.ts`; it is the same mechanism.)

That is also why `app/layout.tsx` sets `dynamic = 'force-dynamic'`. A statically
prerendered page has those inline scripts baked in at build time, and no
per-request nonce can ever match them. Nothing is lost — every page sits behind
`AuthGate` and is learner-specific — but removing that export brings the blank
page straight back.

Monaco and Pyodide are vendored into `public/` at build time by
`apps/web/scripts/vendor-assets.mjs` rather than loaded from jsDelivr, for the
same reason: both default to a CDN, and `script-src` lists none. The copies are
gitignored and rebuilt from `node_modules`, so the served version cannot drift
from `package.json`.

### 8. `NEXT_PUBLIC_APP_ORIGIN` is a security control, not a convenience

The `/sandbox` route builds its CSP from it and names it as the target of every
`postMessage` the sandbox sends back. Unset, the route rebuilds the origin from
the request's `Host` header — which a proxy forwarding `$host` unvalidated lets
a caller choose, putting *their* origin into the sandbox's `script-src` and
`connect-src`.

Leave it unset locally, where the fallback is right. **Set it in production.** A
deployment running on the fallback logs a warning at boot saying so. It is in
`turbo.json`'s `globalEnv` for the same reason — replaying a cached build with
the wrong origin baked in is a security regression rather than a stale string.

---

## The provider layer

Any OpenAI-compatible endpoint works — OpenAI, Gemini, DeepSeek, Kimi/Moonshot,
OpenRouter, Groq, Together, local Ollama or vLLM — plus Anthropic through its
own adapter. Two adapters cover the whole field:

- `adapters/anthropic.ts` — Claude only
- `adapters/openai-compatible.ts` — everything else, via `baseURL`

Adding a model is a data edit in `packages/llm/src/registry.ts` plus making the
conformance suite pass:

```bash
npm run test:conformance --workspace @ai-edu/llm
```

Three rules keep this layer honest:

1. **Claude never goes through the OpenAI-compatible adapter.** It would
   silently lose explicit prompt caching, adaptive thinking, and the 1M context
   window.
2. **`pricing: null` means nobody has verified the numbers** — see
   [invariant 3](#3-unverified-model-pricing-is-null-never-0).
3. **Capability differences are flags, never `if (provider === 'x')`.** An
   over-claimed capability fails at runtime, in production, on one provider only
   — so claim conservatively and let the conformance suite prove better.

Anthropic API specifics that are easy to get wrong from memory, all verified
against a live endpoint:

| Thing | Correct |
|---|---|
| Thinking | `thinking: { type: 'adaptive' }` — `budget_tokens` is a **400** on Opus 5 |
| Depth | `output_config.effort` (`low` … `max`) |
| Structured output | `output_config.format` via `messages.parse()` — `output_format` is deprecated |
| Prefill | Rejected with a 400 on current models |
| Min cacheable prefix | 512 tokens on Opus 5 (silently no-ops below that) |

---

## Conventions

- Zod schemas in `packages/core/src/schemas/` are the single source of truth.
  Every other package derives its types from them.
- The database enums in `supabase/migrations/0001_init.sql` mirror those Zod
  enums. Change one, change the other.
- `apps/web` never calls `fetch` directly — only through `@ai-edu/api-client`,
  which is what will let a React Native app reuse the whole network layer.
- No business logic in React components. It belongs in `packages/core`.
- The service-role Supabase key is `apps/api` only. The browser gets the anon
  key, which is safe because RLS gates every table.
- Progress is server state, not page state. The editor's contents, the
  checkpoint verdict, the unlocked explanation, and the hints already spent live
  in one row per learner per step, so reopening a project resumes it rather than
  replaying it. Passing is the exception — it is derived from the attempts
  table, because it is a graded event and one source of truth beats two that can
  disagree.
- Solution files never reach the browser before a step is attempted, and the
  explanation stays collapsed until the learner asks for it. "Why this approach"
  lands as trivia if it arrives before they have hit the problem.
- Generation is held to what the sandbox can actually run, in code rather than
  in the prompt. That sandbox has the standard library and nothing else — no
  pip, no npm, no network, no server — and a test that cannot pass is worse than
  no test, because it blocks a learner on work they did correctly.
  `packages/core/src/generation/runnable.ts` reads what a step's own files
  import and turns off automatic checking when the sandbox could not have run
  them, leaving the static layers to carry the step.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | web on :3000, api on :3001 |
| `npm run build` | Build everything (Turborepo, cached) |
| `npm test` | 583 unit tests — no network, no browser, no keys, no database |
| `npm run typecheck` | `tsc --noEmit` per workspace |
| `npm run lint` | ESLint, including the portability guards |
| `npm run smoke` | Live provider round-trip + cost accounting |
| `npm run db:start` / `db:stop` / `db:reset` | Local Supabase stack (`db:reset` destroys local data) |
| `npm run test:conformance --workspace @ai-edu/llm` | Provider conformance, after a registry edit |
| `npm run test:containment --workspace @ai-edu/web` | Drives a real browser at the sandbox. Needs `npm run build` and an installed Chrome or Edge. |

---

## Status

Each phase runs **Build → Verify logic → Test logic → Test phase** and ends on
an explicit exit criterion. Do not start a phase until the previous one's exit
criterion is met.

| Phase | State |
|---|---|
| **P0** Scaffold + provider layer | Built and verified. Exit criterion (`npm run smoke`) needs an API key. |
| **P1** Interview + 4-agent Q&A | Built: interview, staggered fan-out, SSE multiplex, 4-tab UI, auth, budgets, attachments, per-agent follow-ups. |
| **P2** Project generation | Built: two-phase generation, blueprint approval, lazy expansion with prefetch, project shell and step view. |
| **P3** Checkpoint flow | Built and verified. Monaco and Pyodide self-hosted, sandbox served from `/sandbox`, static verification, tiered hints, saved progress. |
| **P4** Pacing + tracking | Built and wired end to end. `scorePacing` feeds step expansion and the directive is surfaced to the learner. |
| **P5** Hardening | Mostly built: rate limits, input caps, restrictive RLS, security gateway, sandbox containment proven by execution. |

Shipped after P5: the finished-project artifact and ZIP download, the project
tutor with its write-code gate, and per-specialist follow-up threads.

P3's exit criterion is deliberately adversarial, and it is met **by execution,
not by inspection**. `apps/web/test/sandbox-containment.browser.test.ts` drives
a real browser against the production server and attempts three real escapes. It
carries a fourth test that rebuilds the frame *with* `allow-same-origin` and
asserts the escape then *succeeds* — without that, there is no evidence the
other three can fail, and a containment test that cannot fail is decorative. An
earlier version of that suite passed 18 assertions in 6 ms while executing
nothing at all.

Known and open, none of it blocking:

- **The sandbox result is advisory.** Learner code runs with `parent.postMessage`
  in scope and can forge `{type:'result', passed:true}`. The server-side static
  layers stay authoritative. Closing this properly means running tests somewhere
  the learner's globals cannot reach.
- **`attempt_no` is derived from a count**, so two concurrent submissions can
  race.
- **Layer 2 is a substring check**, so a required symbol inside a comment counts.
- **Rate limiting is per-process and in memory.** Correct for a single API
  instance; several behind a load balancer would need a shared store.

---

## Tests

`npm test` is hermetic by design — no network, no browser, no keys, no database.
583 tests, about 17 seconds cold.

| Package | Tests | What they protect |
|---|---:|---|
| `@ai-edu/core` | 361 | prompt-prefix stability, interview logic, fan-out stagger and isolation, generation schemas, prefetch policy, pacing, hint unlocking, knowledge determinism, tutor gate, sandbox-runnability guard, finished-project assembly |
| `@ai-edu/api` | 69 | attachment allowlist, binary detection, PDF extraction, gateway failure policy, OKF loader, thread routes, ZIP writer |
| `@ai-edu/llm` | 68 | registry, cost nulls, stream utils, adapter mapping, structured-output repair, retry backoff |
| `@ai-edu/web` | 59 | sandbox configuration guards, CSP shape, Markdown rendering without a Markdown library, stylesheet invariants (contrast, full-bleed artwork) |
| `@ai-edu/api-client` | 17 | SSE framing across chunk boundaries, multi-byte splits, CRLF, errors |
| `@ai-edu/runners` | 9 | static verification layering and short-circuiting |

Three browser suites are kept out of that run, because they need a production
build and a real browser: sandbox containment (the P3 exit criterion), sandbox
execution, and tutor drawer layout. Run them with:

```bash
npm run build
npm run test:containment --workspace @ai-edu/web
```

Database behaviour is verified directly against Postgres rather than in unit
tests: migrations apply clean, and RLS was proven to isolate two users across
SELECT, UPDATE and INSERT, with every table confirmed to have forced RLS and a
policy.

Two bugs found by writing these tests, both worth knowing because both were
invisible:

- The fan-out **blocked on client disconnect** — abandoning the iterator awaited
  every in-flight agent. Now detached; callers abort via `signal`.
- The attachment binary check **rejected every text file** — a mangled NUL escape
  became `indexOf('')`, which returns 0. Now uses `bytes.includes(0)`.
