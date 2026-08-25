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

## The five things that will bite you

These are non-obvious, and each one is load-bearing. Breaking any of them
produces no error — just silently worse behaviour or silently higher cost.

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

---

## Architecture

```
apps/
  web/          Next.js 16 (App Router) — rendering only
  api/          Fastify — orchestration, SSE, auth, budgets
packages/
  llm/          provider-agnostic LLM layer (2 adapters, N providers)
  core/         portable domain logic — interview, agents, generation, pacing
  api-client/   typed SDK + SSE streaming
  runners/      browser sandboxes (P3, not built)
  ui/           design tokens (not built; tokens currently live in web CSS)
supabase/
  migrations/   13 tables, RLS forced on all of them
```

**Data flow for a question:**

```
query -> interview (classify, auto-fill, score) -> CompiledQuery
      -> fanOut (staggered) -> SSE multiplex -> 4 tabs
```

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
npm test               # 185 tests, no network or keys needed
npm run lint           # includes both portability guards
npm run smoke          # live provider round-trip + cost accounting
npm run db:start       # Supabase local (vendored CLI at .tools/supabase.exe)
```

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
| **P3** Checkpoint flow | Not started. Monaco, iframe + Pyodide sandboxes, 3-layer verification, tiered hints. |
| **P4** Pacing + tracking | Not started. `PacingDirective` contract exists in `packages/core/src/pacing/types.ts`; the scoring does not. |
| **P5** Hardening | Not started. |

**Two things block every outstanding exit criterion:** an API key in `.env`, and
Supabase running. Neither is a code problem.

P3's exit criterion is deliberately adversarial: it is not done until three
specific sandbox-escape attempts (reaching `window.parent`, calling `fetch`, an
infinite loop) are provably contained.

---

## Test coverage

| Package | Tests | What they actually protect |
|---|---:|---|
| `@ai-edu/llm` | 60 | registry, cost nulls, stream utils, adapter mapping, structured-output repair |
| `@ai-edu/core` | 99 | prompt-prefix stability, interview logic, fan-out stagger and isolation, generation schemas, prefetch policy |
| `@ai-edu/api-client` | 13 | SSE framing across chunk boundaries, multi-byte splits, CRLF, errors |
| `@ai-edu/api` | 13 | attachment allowlist and binary detection |

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
