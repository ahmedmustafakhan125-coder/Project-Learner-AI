# CONTEXT.md

Orientation for anyone — human or AI — picking this project up cold.
`README.md` explains what the project *is*; this file explains what you need to
know before changing it.

**Location: `E:\AI Education PLatform`.** Moved off `C:` on 2026-08-23 because
C: ran out of disk. Do not recreate it under `C:\Users\...\Desktop`.

---

## What this is, in one paragraph

A platform for project-based programming education. A learner gives an area of
interest, target technologies, and a skill level; the platform generates a
multi-step coding project with a guided tutorial. Each step has the learner
write the code themselves, then explains the approach used and the alternative
tools with their tradeoffs. Every question they ask is answered four ways at
once by four sub-agents, and no question reaches a model until the platform has
interviewed them for the context it is missing.

Web first. The domain layer is deliberately written so a React Native app can
reuse it unchanged.

---

## The six things that will bite you

These are non-obvious, and each one is load-bearing. Breaking any of them
produces no error — just silently worse behaviour, silently higher cost, or a
feature that quietly stops running.

### 1. The four agents must share a byte-identical prompt prefix

`PEDAGOGY_CORE` in `packages/core/src/agents/prompts.ts` is the cached prefix
for every fan-out request. Prompt caching is a **prefix match**: one
interpolated timestamp, user id, or `Date.now()` anywhere in it and every cache
read across the entire application stops working. Nothing fails. No test goes
red. Cost simply quadruples.

Per-agent differences go in a **trailing** `{role: "system"}` message, never in
the system prompt. `packages/core/test/prompt-stability.test.ts` asserts this
directly — if you change prompt assembly, run it.

### 2. The fan-out staggers its lead request on purpose

A cache entry only becomes readable once the request writing it is **already in
flight**. Fire all four agents simultaneously and none can read what the others
are still writing, so every one pays full price.

So `fanOut()` sends the `simple` agent alone, waits for its first token (bounded
by a 2s timeout so a stalled lead cannot block the answer), then releases the
other three. If you "simplify" this into `Promise.all`, you have just
quadrupled the cost of every question with no visible symptom.

### 3. Unverified model pricing is `null`, never `0`

In `packages/llm/src/registry.ts`, only Anthropic entries have verified prices
(stamped `verifiedOn: '2026-06-24'`). DeepSeek, Kimi, and OpenAI ship with
`pricing: null` deliberately.

`computeCost()` returns `totalUSD: null` for those. A `0` would read downstream
as "this call was free" and silently defeat budget enforcement. **Never fill
these in from memory** — open the vendor's own pricing page, set the numbers,
then stamp `verifiedOn`. A unit test enforces that any entry with pricing also
carries a date.

### 4. `packages/core` and `packages/api-client` must stay portable

They must run unchanged under React Native. Two mechanisms enforce it, because
the web app would work fine either way and the constraint would otherwise rot:

- **ESLint** bans Node builtins, web-framework imports, and vendor SDKs there.
- **The compiler** is the stronger guard: `packages/core` builds with
  `"lib": ["ES2023"]` and no DOM, so `document` and `window` are *type errors*.

`packages/core` therefore cannot name `AbortSignal` either — it is derived from
the LLM request type in `src/platform.ts` rather than pulling in the DOM lib.

`packages/api-client` *does* compile with the DOM lib, because it needs
`fetch`/`Response`/`ReadableStream`, which React Native also implements. Actual
DOM access there is banned by `no-restricted-globals` instead.

### 5. Attachment and model output is untrusted

Learners upload arbitrary files, and file text flows into prompts. It is wrapped
in `<attachment>` delimiters, and `PEDAGOGY_CORE` instructs the model to treat
anything inside as data, never as instructions.

The UI does **not** use a markdown library. `AgentTabs.tsx` splits code fences
and renders everything as plain text nodes — a markdown renderer with raw-HTML
support would be a direct XSS path from model output.

The practice exercise runs in `sandbox="allow-scripts"` **without**
`allow-same-origin`. That combination gives the frame an opaque origin. Adding
`allow-same-origin` alongside `allow-scripts` lets the frame remove its own
sandbox attribute — the two together are equivalent to no sandbox at all.

Note what the sandbox attribute does *not* do: it does not block `fetch`. An
opaque-origin document can still issue requests; they simply carry `Origin:
null`, and anything answering `Access-Control-Allow-Origin: *` is readable.
Network containment comes from the sandbox document's `connect-src`. Confusing
the two produces code that looks contained and is not.

### 6. The sandbox is a route, not a `srcdoc`, and that is not cosmetic

A frame created from a **local scheme** — `srcdoc`, `about:blank`, `blob:`,
`data:` — has no response of its own, so it **inherits the parent's CSP**. The
app policy has no `'unsafe-inline'`, which means an inline `<script>` inside a
`srcdoc` sandbox is *refused*. The frame loads, reports nothing, and the parent
waits forever. No error reaches the UI.

That is why the sandbox is served from `/sandbox` (`apps/web/app/sandbox/route.ts`).
A document loaded from a real URL is governed by the CSP on its own response,
which is set independently in `apps/web/lib/csp.mjs`.

Inside that document, **`'self'` is meaningless**. The frame's origin is opaque,
so `'self'` resolves against it and matches nothing — not even the origin that
just served the frame. The sandbox policy names the app origin explicitly, and
`/pyodide/*` is served with CORS headers because the frame fetching its own
runtime is, from the browser's point of view, a cross-origin request.

Both facts were verified in Chrome, against a no-CSP control. If you are ever
tempted to move this back to `srcdoc` to "simplify" it, the symptom you will get
is a checkpoint that silently never runs.

Monaco and Pyodide are therefore vendored into `public/` at build time by
`apps/web/scripts/vendor-assets.mjs` rather than loaded from jsDelivr. Both
default to a CDN, and `script-src` lists none. The copies are gitignored and
rebuilt from `node_modules`, so the served version cannot drift from
`package.json`.

---

## Architecture

```
apps/
  web/          Next.js 16 (App Router) — rendering only
  api/          Fastify — orchestration, SSE, auth, budgets
packages/
  llm/          provider-agnostic LLM layer (2 adapters, N providers)
  core/         portable domain logic — interview, agents, generation, pacing, knowledge
  api-client/   typed SDK + SSE streaming
  runners/      static checkpoint verification (layers 1 and 2)
  ui/           design tokens (not built; tokens currently live in web CSS)
knowledge/      OKF v0.2 bundle — the curated wiki the four agents consult
supabase/
  migrations/   13 tables, RLS forced on all of them
```

Two things sit in front of every model call, both in `apps/api` because
`packages/core` must stay portable:

- `gateway.ts` — screens every learner-supplied string before it reaches a model.
- `knowledge.ts` — loads the OKF bundle off disk; selection and rendering are
  pure and live in `packages/core/src/knowledge/`.

**Data flow for a question:**

```
query -> gateway (ALLOW / MASK / BLOCK)
      -> interview (classify, auto-fill, score) -> CompiledQuery
      -> gateway again, at /api/agents/ask
      -> fanOut (staggered, + selected OKF concepts) -> SSE multiplex -> 4 tabs
```

The gateway appears **twice on purpose**. `/api/agents/ask` accepts a
client-supplied `CompiledQuery` — the browser posts the finished prompt object —
so anything screened only during the interview is bypassed by posting straight to
that route. The same is true of `/api/projects/blueprint`. Screening at the
interview alone enforces nothing.

Screening runs **before** the budget check and before a provider is constructed,
so a blocked prompt costs nothing. Model-bound routes fail **closed**: if the
gateway cannot be reached, the request is refused rather than sent unscreened.

**Data flow for a project:**

```
goal -> interview -> CompiledQuery -> blueprint (Phase A, approved by learner)
     -> persist stubs -> expand step N on demand (Phase B) + prefetch N+1
```

Phase B runs late **on purpose**: a step not yet written can still be reshaped
by how the learner is doing. That is what makes adaptive pacing (P4) real
instead of cosmetic.

---

## Provider layer

Two adapters cover the whole field, because DeepSeek, Kimi/Moonshot, Groq,
Together, OpenRouter and local Ollama all speak the OpenAI-compatible protocol:

- `adapters/anthropic.ts` — Claude only
- `adapters/openai-compatible.ts` — everything else, via `baseURL`

**Claude must never go through the compatible adapter.** It would silently lose
explicit prompt caching, adaptive thinking, and the 1M context window.

Differences are expressed as `ProviderCapabilities` flags, never
`if (provider === 'x')`. Claim capabilities conservatively — an over-claimed
capability fails at runtime, in production, on one provider only.

Anthropic API specifics that are easy to get wrong from memory, all verified:

| Thing | Correct |
|---|---|
| Thinking | `thinking: { type: 'adaptive' }` — `budget_tokens` is a **400** on Opus 5 |
| Depth | `output_config.effort` (`low`…`max`) |
| Structured output | `output_config.format` via `messages.parse()` — `output_format` is deprecated |
| Prefill | Rejected with a 400 on current models |
| Min cacheable prefix | 512 tokens on Opus 5 (silently no-ops below that) |

---

## Commands

```bash
npm install
npm run dev            # web :3000, api :3001
npm run build          # all packages (Turborepo, cached)
npm test               # 273 tests, no network, browser, or keys needed
npm run lint           # includes both portability guards
npm run smoke          # live provider round-trip + cost accounting
npm run db:start       # Supabase local (vendored CLI at .tools/supabase.exe)

# P3 exit criterion. Needs `npm run build` first, and an installed Chrome or Edge.
npm run test:containment --workspace @ai-edu/web
```

`npm test` is deliberately hermetic. The containment suite is separate because it
builds the app, starts the production server, and drives a real browser — see
the phase table below for why that separation matters.

---

## Environment gotchas on this machine

- **Docker's data disk lives on `C:`** (`AppData\Local\Docker\wsl\disk\docker_data.vhdx`),
  *not* on E:. Pulling images still consumes C: space. C: is a 238 GB drive that
  runs close to full — check free space before `npm run db:start`, which needs a
  few GB there. Filling C: is what forced the move to E: in the first place.
- **The Supabase npm wrapper has no win32-x64 binary.** The CLI is vendored at
  `.tools/supabase.exe` (v2.115.0) and gitignored. If it is missing, download it
  from the supabase/cli GitHub releases (`supabase_windows_amd64.tar.gz`).
- **Next.js needs its native SWC binary.** `@next/swc-win32-x64-msvc` is an
  optional dependency that can silently fail to install; without it Turbopack
  refuses to build. Reinstall it explicitly if `next build` complains about
  WASM bindings.
- **After copying this repo anywhere, delete `*.tsbuildinfo`.** TypeScript will
  otherwise read them, conclude everything is already built, and emit nothing —
  `tsc -b` reports *success* with no `dist/`. Turborepo will also replay a stale
  cache; use `turbo run build --force` after a move.

---

## Phase status

Each phase runs **Build → Verify logic → Test logic → Test phase** and ends on
an explicit exit criterion. Do not start a phase until the previous one's exit
criterion is met.

| Phase | State |
|---|---|
| **P0** Scaffold + provider layer | Built, verified. Exit criterion (`npm run smoke`) needs an API key. |
| **P1** Interview + 4-agent Q&A | Built: interview, staggered fan-out, SSE multiplex, 4-tab UI, auth, budgets, attachments. Needs a live run. |
| **P2** Project generation | Built: two-phase generation, blueprint approval, lazy expansion + prefetch, project shell and step view. Needs a live run. |
| **P3** Checkpoint flow | Built and verified. Monaco and Pyodide self-hosted, sandbox served from `/sandbox`, static verification, tiered hints. Exit criterion met — see below. |
| **P4** Pacing + tracking | Built and wired end to end. `scorePacing` feeds step expansion, and the directive is surfaced to the learner. |
| **P5** Hardening | Mostly built: rate limits, input caps, restrictive RLS, security gateway. Open items listed below. |

**Two things block every outstanding exit criterion:** an API key in `.env`, and
Supabase running. Neither is a code problem.

P3's exit criterion is deliberately adversarial, and it is now **met by
execution, not by inspection**. `apps/web/test/sandbox-containment.browser.test.ts`
drives a real browser against the production server and attempts all three
escapes. It carries a fourth test that rebuilds the frame WITH
`allow-same-origin` and asserts the escape then *succeeds* — without that, there
is no evidence the other three can fail, and a containment test that cannot fail
is decorative. An earlier version of this suite passed 18 assertions in 6ms while
executing nothing at all.

**Still open in P5**, none of them blocking:

- The sandbox result is advisory, not trusted. Learner code runs with
  `parent.postMessage` in scope and can forge `{type:'result', passed:true}`.
  Server-side layers 1 and 2 stay authoritative; closing this properly means
  running tests somewhere the learner's globals cannot reach.
- `attempt_no` is derived from a count, so two concurrent submissions can race.
- Layer 2 is a substring check, so a required symbol inside a comment counts.

---

## Test coverage

| Package | Tests | What they actually protect |
|---|---:|---|
| `@ai-edu/llm` | 68 | registry, cost nulls, stream utils, adapter mapping, structured-output repair, retry backoff |
| `@ai-edu/core` | 124 | prompt-prefix stability, interview logic, fan-out stagger and isolation, generation schemas, prefetch policy, pacing scoring, knowledge selection determinism |
| `@ai-edu/api-client` | 13 | SSE framing across chunk boundaries, multi-byte splits, CRLF, errors |
| `@ai-edu/api` | 47 | attachment allowlist, binary detection, PDF extraction, gateway failure policy, OKF loader |
| `@ai-edu/runners` | 9 | static verification layering and short-circuiting |
| `@ai-edu/web` | 12 | sandbox configuration guards, CSP shape |
| `@ai-edu/web` (browser) | 4 | **the P3 exit criterion** — real escapes in a real browser, plus a mutation check |

Database behaviour is not unit-tested but was verified directly against
Postgres: the migration applies clean, and RLS was proven to isolate two users
across SELECT, UPDATE and INSERT, with all 13 tables confirmed to have forced
RLS and a policy.

Two bugs found by writing these tests, both worth knowing because both were
invisible:

- The fan-out **blocked on client disconnect** — abandoning the iterator awaited
  every in-flight agent. Now detached; callers abort via `signal`.
- The attachment binary check **rejected every text file** — a mangled NUL
  escape became `indexOf('')`, which returns 0. Now uses `bytes.includes(0)`.

---

## Conventions

- Zod schemas in `packages/core/src/schemas/` are the single source of truth.
  Every other package derives its types from them.
- The database enums in `supabase/migrations/0001_init.sql` mirror those Zod
  enums. Change one, change the other.
- `apps/web` never calls `fetch` directly — only through `@ai-edu/api-client`.
- No business logic in React components. It belongs in `packages/core`.
- The service-role Supabase key is `apps/api` only. The browser gets the anon
  key, which is safe because RLS gates everything.
