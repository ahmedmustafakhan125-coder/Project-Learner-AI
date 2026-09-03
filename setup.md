# Setup

Local setup for the AI Education monorepo: a Next.js web app, a Fastify API,
portable domain packages, a local Supabase database, and a separate Python
security gateway — orchestrated with Turborepo over npm workspaces.

Read [CONTEXT.md](CONTEXT.md) next: it covers the invariants this guide only
gestures at (what may import what, why the service-role key never reaches the
browser, which layers must stay portable).

## Quick start

```powershell
git clone <repository-url>
cd AI-Education
npm install
copy .env.example .env          # bash: cp .env.example .env
# fetch the Supabase CLI into .tools\  — see §3.1
npm run db:start                # needs Docker; copy the printed keys into .env
# mirror the two NEXT_PUBLIC_ values into apps\web\.env.local  — see §2.2
npm run smoke                   # verify the provider layer end to end
npm run dev                     # web :3000, api :3001
```

Two things the quick start does **not** cover, both of which you will hit within
minutes of opening the app:

- **The security gateway** (§4). Without it, asking a question is refused. The
  gateway is a separate service and screening fails closed by design.
- **`apps/web/.env.local`** (§2.2). Next.js does not read the repo-root `.env`,
  so the browser cannot see Supabase and login will not work.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>= 20.11.0` (from `engines`) | Current LTS or newer is fine; this repo is developed on 24.x. |
| **npm** | 11.x (pinned as `npm@11.10.0` via `packageManager`) | npm workspaces — install **from the repo root only**. Not yarn, not pnpm. |
| **Docker Desktop** | Running | The local Supabase stack runs entirely in containers. |
| **Supabase CLI** | v2.115.0, vendored at `.tools/supabase.exe` | The npm wrapper has no win32-x64 binary. `.tools/` is gitignored — fetch it once, see §3.1. |
| **Python** | 3.11+ | Only for the security gateway (§4), which lives in its own repo. |
| **Git** | Any | |

**Disk space.** The first `npm run db:start` pulls several GB of container
images. On Windows, Docker's data disk lives on `C:` at
`AppData\Local\Docker\wsl\disk\docker_data.vhdx` regardless of where this repo
sits, so check free space on `C:` before starting the database.

---

## 2. Install and configure

```powershell
npm install
```

One install at the root covers everything — `apps/*` and `packages/*` are npm
workspaces, so dependencies are hoisted and never need a separate install inside
`apps/web` or `apps/api`.

### 2.1 The root `.env`

```powershell
copy .env.example .env          # bash: cp .env.example .env
```

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | One provider key is required | Claude. **Start here** — Anthropic is the only vendor with verified pricing in the registry, so it is the only one whose spend counts against the daily budget. |
| `OPENAI_API_KEY` | Optional | OpenAI models. |
| `GEMINI_API_KEY` | Optional | Gemini models. |
| `OPENROUTER_API_KEY` | Optional | OpenRouter, which fronts many vendors behind one key. |
| `DEEPSEEK_API_KEY` | Optional | DeepSeek models. |
| `MOONSHOT_API_KEY` | Optional | Kimi / Moonshot models. |
| `SUPABASE_URL` | Yes | Local default `http://127.0.0.1:54321`. |
| `SUPABASE_ANON_KEY` | Yes | Printed by `npm run db:start`. Safe to expose — every table is RLS-gated. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | **Bypasses RLS.** Belongs to `apps/api` only. Never `NEXT_PUBLIC_`-prefixed, never in the browser. |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes (web) | Browser-visible copy. Also needed in `apps/web/.env.local` — see §2.2. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes (web) | Browser-visible copy of the anon key. |
| `SECURITY_GATEWAY_URL` | Effectively yes | Where prompts are screened, e.g. `http://127.0.0.1:8000`. Unset is treated exactly like unreachable, and model-bound routes then refuse (§4). |
| `SECURITY_GATEWAY_TIMEOUT_MS` | Optional | Default `15000`. The gateway sits in front of the fan-out, so it is bounded on purpose. |
| `DAILY_USD_BUDGET_PER_USER` | Optional | Default `2`. Checked before each provider call. Spend on unpriced models cannot count against it. |
| `PORT` | Optional | API port, default `3001`. |
| `WEB_ORIGIN` | Optional | Default `http://localhost:3000`. The one non-localhost origin CORS will accept — set it if you serve the web app from anywhere else. |
| `NEXT_PUBLIC_API_URL` | Optional | Where the browser looks for the API. Defaults to `http://localhost:3001`. |

Every provider key is optional individually: a model appears in the picker only
when its vendor's key is present, and the app runs fine with one vendor
configured. With none, the API starts and says so loudly.

### 2.2 `apps/web/.env.local` — the step everyone misses

**Next.js does not read the repo-root `.env`.** It only loads `.env*` files from
its own directory. The API and the smoke script read the root file; the browser
bundle does not. Mirror the two public values:

```env
# apps/web/.env.local   (gitignored)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key printed by npm run db:start>
```

`NEXT_PUBLIC_*` values are inlined at compile time — restart `next dev` after
changing them.

---

## 3. Database

### 3.1 Get the CLI

`.tools/` is gitignored, so a fresh clone has no CLI. Fetch it once:

```powershell
mkdir .tools
cd .tools
curl -LO https://github.com/supabase/cli/releases/download/v2.115.0/supabase_windows_amd64.tar.gz
tar -xzf supabase_windows_amd64.tar.gz
del supabase_windows_amd64.tar.gz
cd ..
```

The `db:*` scripts call `.\.tools\supabase.exe` directly, so nothing needs to be
on `PATH`. On macOS or Linux, put the platform binary at the same path or run
the equivalent `supabase` commands yourself.

### 3.2 Start it

```powershell
npm run db:start
```

First run pulls several GB of images. On start the CLI applies everything in
`supabase/migrations/` and prints the local URLs and keys — **keep that
output**. Copy the anon key and the service-role key into `.env` (§2.1), and the
anon key into `apps/web/.env.local` (§2.2).

```powershell
npm run db:stop     # stops the stack; data survives
npm run db:reset    # recreates the database and re-applies every migration — destroys local data
```

### 3.3 Migrations

| File | What it does |
|---|---|
| `0001_init.sql` | The schema: 13 tables, RLS enabled **and forced** on every one, owner policies, new-user bootstrap trigger. |
| `0002_hardening.sql` | Partial index for failed-attempt lookups, plus an enrollment check on attempt inserts. |
| `0003_restrictive_attempt_insert.sql` | Makes that enrollment check actually bind — as a permissive policy it was OR-ed with the owner policy and reduced to a no-op. |
| `0004_grant_schema_permissions.sql` | Grants and default privileges for the Supabase roles. |
| `0005_step_drafts.sql` | The learner's editor contents, one mutable row per learner per step. |
| `0006_step_progress.sql` | Renames that table to `step_progress` and widens it: revealed explanation, last checkpoint run, hints opened. |

**Adding a migration without losing data.** `db:reset` wipes everything, which
is rarely what you want mid-project. Write the file into `supabase/migrations/`
and apply just the pending ones:

```powershell
.\.tools\supabase.exe migration list --local     # what is applied, what is pending
.\.tools\supabase.exe migration up --local       # apply the pending ones
```

### 3.4 Ports and tools

| Port | Service |
|---|---|
| `54321` | Supabase API — this is `SUPABASE_URL` |
| `54322` | Postgres direct connection (Postgres 17; `54320` is the shadow DB) |
| `54323` | Supabase Studio — browse tables, run SQL: <http://127.0.0.1:54323> |
| `54324` | Local mail viewer — anything the app "sends" in dev lands here |
| `54329` | Connection pooler |

### 3.5 Local auth

Configured for friction-free development: email signup is on, **confirmation is
off** (`enable_confirmations = false`), minimum password length 6. Any address
works — sign up in the web UI and you are in immediately. Password-reset mail is
readable at <http://127.0.0.1:54324>.

---

## 4. The security gateway

Every learner-supplied prompt — questions, interview answers, and the text
extracted from uploaded attachments — is screened before it can reach a model:
prompt injection, jailbreaks, system-prompt extraction, secrets, PII. The
gateway is a separate FastAPI service, run from the
`llm-security-gateway-final` repo:

```bash
uvicorn app.main:app --reload --port 8000
```

Then point the API at it:

```env
SECURITY_GATEWAY_URL=http://127.0.0.1:8000
```

**Model-bound routes fail closed.** Asking a question, running the interview,
and generating a project all screen first, and an unscreened prompt is never
allowed through to a model — so with the gateway down or `SECURITY_GATEWAY_URL`
unset, those routes refuse. Read-only routes keep working. If the app loads,
lists models, and then refuses every question, check the gateway before
anything else:

```powershell
curl http://127.0.0.1:8000/health
```

---

## 5. Run it

```powershell
npm run dev
```

| Service | URL | Notes |
|---|---|---|
| Web (Next.js 16) | <http://localhost:3000> | `next dev -p 3000` |
| API (Fastify 5) | <http://localhost:3001> | `tsc -b` then `node --watch dist/server.js`, with the root `.env` loaded |

`predev` runs `apps/web/scripts/vendor-assets.mjs` first, which copies Monaco
and the Pyodide runtime out of `node_modules` into `apps/web/public/`. Both
libraries default to a CDN, and the app CSP lists none — serving them from our
own origin is what keeps the policy tight. The copies are gitignored and rebuilt
from `node_modules`, so they cannot drift from `package.json`.

Open <http://localhost:3000>, sign up with any email, and ask a question. Four
specialist agents stream answers in parallel over one SSE connection.

### Verify the install

```powershell
npm test           # 285 unit tests — no network, no API keys, no database
npm run typecheck  # tsc --noEmit per workspace
npm run lint       # ESLint everywhere, including the portability guards
npm run smoke      # live provider round-trip + cost accounting
```

`npm test` is the best post-install check: core 134, llm 68, api 47, web 14,
api-client 13, runners 9 — all offline.

`npm run smoke` needs real keys. It sends one trivial structured request through
every configured provider, validates the reply, prices it, and — if Supabase is
configured — writes and reads back an `llm_usage` row to prove the accounting
path end to end.

---

## 6. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Web (:3000) and API (:3001) in watch mode |
| `npm run build` | Build every workspace; cached in `.turbo/` |
| `npm test` | The full offline test suite |
| `npm run test:conformance` | Provider conformance suite for the LLM layer |
| `npm run typecheck` | Type-check every workspace without emitting |
| `npm run lint` | ESLint across all workspaces |
| `npm run clean` | Remove build outputs, Turborepo cache, and `node_modules` |
| `npm run db:start` / `db:stop` / `db:reset` | Local Supabase stack |
| `npm run smoke` | Round-trip every configured provider and price it |

Useful workspace-level commands:

```powershell
npm run test:conformance --workspace @ai-edu/llm   # after editing the model registry
npm run vendor:assets --workspace @ai-edu/web      # re-vendor Monaco/Pyodide by hand
```

---

## 7. Providers

**Start with `ANTHROPIC_API_KEY`.** Anthropic is the only vendor with verified
pricing in `packages/llm/src/registry.ts`, so it is the only one that produces
real cost figures and enforces `DAILY_USD_BUDGET_PER_USER`. Every other vendor's
pricing is deliberately `null`: their usage is recorded at `null` cost and
cannot count against the budget. The API prints a warning at startup naming
every model in that state.

Never fill in prices from memory. Take them from the vendor's pricing page and
stamp `verifiedOn`.

**More keys are additive.** Set several and each vendor's models appear in the
picker; providers without keys are skipped everywhere, including `npm run
smoke`.

**Any OpenAI-compatible vendor works** — Groq, Together, OpenRouter, local
Ollama or vLLM — through `packages/llm/src/adapters/openai-compatible.ts`.
Adding a model is a data edit in `packages/llm/src/registry.ts` plus making the
conformance suite pass. One hard rule: Claude never goes through the
OpenAI-compatible adapter, which would silently drop explicit prompt caching,
adaptive thinking, and the 1M context window.

---

## 8. Troubleshooting

### "Failed to fetch" when you ask a question

In order of likelihood:

1. The API is not running. `curl http://localhost:3001/health` should return
   `{"ok":true}`.
2. You are loading the web app from something other than `localhost` — a LAN IP,
   say. CORS accepts localhost and `WEB_ORIGIN`, nothing else. Set `WEB_ORIGIN`
   to the origin you are actually using, and add that host to
   `allowedDevOrigins` in `next.config.mjs` to silence Next's dev-resource
   warnings.
3. `NEXT_PUBLIC_API_URL` points somewhere the browser cannot reach.

### Every question is refused, but the app otherwise works

The security gateway is down or unset. See §4 — model-bound routes fail closed
by design.

### The web app says Supabase is not configured, or login does nothing

`apps/web/.env.local` is missing or stale (§2.2). Next.js never reads the
repo-root `.env`, and `NEXT_PUBLIC_*` values are baked in at compile time —
restart the dev server after editing them.

### 429 `budget_exceeded`

`DAILY_USD_BUDGET_PER_USER` (default $2) is per user and resets 24 hours after
each request. Raise it in `.env` and restart the API.

### `next build` fails, or Turbopack complains about WASM bindings

`@next/swc-win32-x64-msvc` is an optional dependency and can silently fail to
install. Check and reinstall:

```powershell
Test-Path node_modules\@next\swc-win32-x64-msvc          # should print True
npm install @next/swc-win32-x64-msvc@^16.3.2 --workspace @ai-edu/web
```

### `tsc -b` reports success but emits no `dist/`

Stale `*.tsbuildinfo`. They are gitignored but survive a filesystem copy, and
TypeScript trusts them. Delete them all and force a rebuild:

```powershell
Get-ChildItem -Recurse -Filter *.tsbuildinfo |
  Where-Object { $_.FullName -notmatch 'node_modules' } | Remove-Item
npx turbo run build --force
```

Use `--force` after any repo move so Turborepo does not replay a cache keyed to
the old location.

### `npm run db:start` fails

- **Disk space** — Docker's data disk lives on `C:` even when the repo does not.
- **Ports 54320–54329 in use** — another Supabase project is running. Stop it
  first.
- **`npx supabase` does not work on Windows** — the npm wrapper ships no
  win32-x64 binary. Use the vendored CLI (§3.1); the `db:*` scripts already do.

### `npm run smoke` says "No provider is configured"

No LLM key in the root `.env`. Add at least one (§2.1).

### Which key goes where

- Root `.env` — everything server-side: provider keys, both Supabase keys,
  budget, gateway.
- `apps/web/.env.local` — only the two `NEXT_PUBLIC_SUPABASE_*` values.
- The service-role key goes **nowhere** `NEXT_PUBLIC_`-prefixed. It bypasses
  RLS. The browser gets the anon key, which is safe precisely because every
  table is RLS-gated.

---

## 9. Layout

```
AI-Education/
├── apps/
│   ├── web/            Next.js 16 (App Router) + React 19 — rendering only.
│   │                   Monaco editor, sandboxed checkpoint frames, SSE consumption.
│   └── api/            Fastify 5 — orchestration, SSE, auth, budgets, attachments,
│                       gateway screening, knowledge loading.
├── packages/
│   ├── llm/            provider-agnostic LLM layer — model registry + 2 adapters
│   ├── core/           portable domain logic — interview, agents, generation, pacing
│   ├── api-client/     typed SDK + SSE streaming (the only way the web app talks to the API)
│   └── runners/        checkpoint verification layers
├── knowledge/          the OKF concept bundle, read once at API startup
├── supabase/
│   ├── config.toml     local stack config — ports, auth, seeding
│   └── migrations/     0001 … 0006 (§3.3)
├── scripts/
│   └── smoke-providers.mjs
├── .tools/             vendored supabase.exe (gitignored — §3.1)
├── turbo.json          pipeline + env-var cache keys
├── CONTEXT.md          invariants and gotchas for contributors — read this
└── setup.md            this file
```

Conventions worth knowing before your first change:

- `apps/web` never calls `fetch` directly. All API traffic goes through
  `@ai-edu/api-client`, which is what will let a React Native app reuse the
  whole network layer.
- `packages/core` and `packages/api-client` must stay portable to React Native.
  Lint bans Node builtins and vendor SDKs there, and `core` compiles without the
  DOM lib — `document` and `window` are type errors in it.
- Zod schemas in `packages/core/src/schemas/` are the single source of truth;
  the database enums mirror them.
- Checkpoint tests run in the learner's browser under Pyodide or a bare JS
  realm — standard library only, no pip, no npm, no network. Generation is held
  to that contract in code, not just in the prompt.
