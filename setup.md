# Setup Guide — AI Education Platform

Local setup for the AI Education monorepo: a Next.js web app, a Fastify API,
portable domain packages, and a local Supabase database — orchestrated with
Turborepo over npm workspaces.

## Quick start

```powershell
git clone <repository-url>
cd AI-Education
npm install
copy .env.example .env        # bash: cp .env.example .env — set at least one provider key
npm run db:start              # needs Docker; copy the printed keys into .env (see §4)
npm run smoke                 # verify the provider layer end to end
npm run dev                   # web on http://localhost:3000, api on http://localhost:3001
```

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>= 20.11.0` (from `engines`) | A current LTS (22.18+ / 24) is recommended: the API dev script runs TypeScript directly through Node (`node --watch src/server.ts`), which relies on Node's built-in type stripping. |
| **npm** | 11.x (pinned as `npm@11.10.0` via `packageManager`) | The repo uses npm workspaces — install **from the repo root only**. Do not use yarn/pnpm. |
| **Docker Desktop** | Running | The local Supabase stack (`npm run db:start`) runs entirely in containers. |
| **Git** | Any | For cloning. |
| **Supabase CLI** | v2.115.0, vendored at `.tools/supabase.exe` | Windows only — the npm wrapper has no win32-x64 binary. See §4.1. |

**Disk space:** the first `npm run db:start` pulls several GB of container images.
On this machine Docker's data disk lives on `C:` at
`AppData\Local\Docker\wsl\disk\docker_data.vhdx` — regardless of where the repo
itself sits — so make sure `C:` has several GB free **before** starting the
database (see §8.3).

---

## 2. Clone & install

```powershell
git clone <repository-url>
cd AI-Education
npm install
```

One install at the root covers everything: `apps/*` and `packages/*` are npm
workspaces, so dependencies are hoisted and never need a separate install inside
`apps/web` or `apps/api`.

### The SWC binary (Windows gotcha)

`@next/swc-win32-x64-msvc@^16.3.2` is declared as an **optionalDependency** of
`apps/web`. Optional dependencies can silently fail to install (partial
installs, `--no-optional` config, platform resolution hiccups) — and without the
native binary, **Turbopack refuses to build** and `next build` fails with
complaints about WASM bindings.

Verify it landed after install:

```powershell
Test-Path node_modules\@next\swc-win32-x64-msvc   # should print True
```

If it is missing, reinstall it explicitly:

```powershell
npm install @next/swc-win32-x64-msvc@^16.3.2 --workspace @ai-edu/web
```

(or delete `node_modules` and `package-lock.json` and run `npm install` again).

### If you received the repo as a copy/zip instead of a clone

Delete every `*.tsbuildinfo` before building. These files are gitignored but
survive filesystem copies, and a stale one makes `tsc -b` report *success* while
emitting nothing (no `dist/` — see §8.2). Also use `npx turbo run build --force`
once, so Turborepo doesn't replay the stale cache from the previous location.

```powershell
Get-ChildItem -Recurse -Filter *.tsbuildinfo |
  Where-Object { $_.FullName -notmatch 'node_modules' } | Remove-Item
```

---

## 3. Environment variables

Copy the template and fill it in:

```powershell
copy .env.example .env        # bash: cp .env.example .env
```

### Variable reference

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | Recommended | Claude access. **Start with this one** — Anthropic is the only vendor whose pricing is verified in the registry, so it is the only one that produces real cost figures and counts against the budget out of the box. |
| `OPENAI_API_KEY` | Optional | OpenAI models. Works, but pricing is unverified (`null`) — usage can't count against the daily budget. |
| `DEEPSEEK_API_KEY` | Optional | DeepSeek models. Same unverified-pricing caveat. |
| `MOONSHOT_API_KEY` | Optional | Kimi/Moonshot models. Same unverified-pricing caveat. |
| `SUPABASE_URL` | Yes (full app) | Supabase API endpoint. Local default: `http://127.0.0.1:54321`. |
| `SUPABASE_ANON_KEY` | Yes (full app) | The anon key printed by `npm run db:start`. Safe to use server-side; every table is gated by Row Level Security. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (full app) | **Bypasses RLS.** Belongs to `apps/api` only — never expose it to the browser and never prefix it with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes (web) | Browser-visible copy of the Supabase URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes (web) | Browser-visible copy of the anon key. Safe to ship because RLS gates everything. |
| `DAILY_USD_BUDGET_PER_USER` | Optional | Per-user daily spend ceiling in USD (default `2.00`), enforced before each provider call. Usage on models with unverified pricing cannot be counted against it. |

Every provider key is optional — a model only appears in the picker when its
vendor's key is present, and the app runs fine with a single provider.

### Where `.env` is actually read

- **`apps/api`** loads the root `.env` explicitly (`node --env-file-if-exists=../../.env` in its `dev`/`start` scripts).
- **`npm run smoke`** loads it explicitly (`node --env-file-if-exists=.env`).
- **`apps/web` (Next.js) does *not* read the repo-root `.env`.** Next.js only loads `.env*` files from its own app directory (`apps/web/`). So mirror the two browser-visible variables into `apps/web/.env.local` (gitignored), or export them in your shell before `npm run dev`:

```env
# apps/web/.env.local
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key printed by npm run db:start>
```

`NEXT_PUBLIC_*` values are inlined at compile time — restart `next dev` after
changing them.

### A minimal working `.env`

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
MOONSHOT_API_KEY=

SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key from npm run db:start>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from npm run db:start>

NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key>

DAILY_USD_BUDGET_PER_USER=2.00
```

---

## 4. Database setup (local Supabase)

### 4.1 Get the CLI

The Supabase npm wrapper has **no win32-x64 binary**, so the CLI is vendored at
`.tools/supabase.exe` (v2.115.0). The `.tools/` directory is **gitignored**, so
after a fresh clone you must fetch it once:

```powershell
mkdir .tools
cd .tools
curl -LO https://github.com/supabase/cli/releases/download/v2.115.0/supabase_windows_amd64.tar.gz
tar -xzf supabase_windows_amd64.tar.gz
del supabase_windows_amd64.tar.gz
cd ..
```

The `db:*` npm scripts invoke `./.tools/supabase.exe` directly, so no PATH
setup is needed. (On macOS/Linux, either place the platform binary at the same
path or run the equivalent `npx supabase` commands directly.)

### 4.2 Start the stack

Make sure Docker Desktop is running and `C:` has a few GB free, then:

```powershell
npm run db:start        # ./.tools/supabase.exe start
```

The first run pulls the container images (several GB). On start, the CLI
applies the migrations in `supabase/migrations/` and prints the local URLs and
keys — **keep that output**, you need it for `.env`.

### 4.3 Copy the printed keys

From the `db:start` output, copy into the root `.env`:

- `SUPABASE_ANON_KEY` ← the printed **anon key**
- `SUPABASE_SERVICE_ROLE_KEY` ← the printed **service_role key**

…and the same anon key into `apps/web/.env.local` as
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (see §3). The URL is already
`http://127.0.0.1:54321` in both files.

### 4.4 Migrations and resets

Migrations live in `supabase/migrations/`:

- `0001_init.sql` — the schema: **13 tables, RLS forced on every one of them**
- `0002_hardening.sql` — hardening pass

They apply automatically when the local database is first initialized. To wipe
the local database and re-apply everything from scratch at any time:

```powershell
npm run db:reset        # ./.tools/supabase.exe db reset
```

Stopping the stack preserves data until a reset:

```powershell
npm run db:stop
```

Note: `supabase/config.toml` enables seeding from `supabase/seed.sql`, but that
file does not exist in the repo — a reset applies just the migrations. Create a
`seed.sql` if you want seed data.

### 4.5 Local ports and tools

| Port | Service |
|---|---|
| `54321` | Supabase API (REST/Auth gateway — this is `SUPABASE_URL`) |
| `54322` | Postgres direct connection (Postgres 17; `54320` is the internal shadow DB) |
| `54323` | Supabase Studio — browse tables, run SQL: <http://127.0.0.1:54323> |
| `54324` | Local email viewer — mail the app "sends" in dev is captured here |
| `54327` | Analytics |

### 4.6 Local auth

Local auth is configured for friction-free development: email signups are
enabled, **email confirmation is disabled** (`enable_confirmations = false`),
and the minimum password length is 6. Any email address works — sign up in the
web UI and you are in immediately. Outgoing mail (e.g. password resets) is
viewable at <http://127.0.0.1:54324>.

---

## 5. Running the app

```powershell
npm run dev
```

This starts both servers via Turborepo:

| Service | URL | Notes |
|---|---|---|
| Web (Next.js 16) | <http://localhost:3000> | `next dev -p 3000` — the UI: ask a question (4-agent fan-out), generate projects |
| API (Fastify 5) | <http://localhost:3001> | `node --watch src/server.ts` with the root `.env` loaded; port comes from `PORT` (default 3001) |

The web app calls the API at `http://localhost:3001` by default (override with
`NEXT_PUBLIC_API_URL`).

Other entry points:

```powershell
npm run build      # build every workspace via Turborepo (TypeScript packages → dist/, web → .next/)
npm test           # 185 unit tests — no network, no API keys, no database needed
npm run smoke      # live provider round-trip + cost accounting (see §7)
npm run lint       # ESLint across all workspaces, incl. the portability guards
npm run typecheck  # tsc --noEmit per workspace
```

`npm test` is the best post-install sanity check — it exercises the LLM
registry, prompt-prefix stability, interview logic, fan-out staggering, SSE
framing, and attachment handling with zero external dependencies.

---

## 6. Available scripts

Root `package.json` (all run through Turborepo where applicable):

| Command | What it does |
|---|---|
| `npm run dev` | Start web (:3000) and API (:3001) in watch mode |
| `npm run build` | Build all workspaces; cached in `.turbo/` |
| `npm test` | Run the 185 unit tests (@ai-edu/llm 60, @ai-edu/core 99, @ai-edu/api-client 13, @ai-edu/api 13) |
| `npm run test:conformance` | Provider conformance suite for the LLM layer |
| `npm run lint` | ESLint for every workspace, including the React-Native portability guards |
| `npm run typecheck` | Type-check every workspace without emitting |
| `npm run clean` | Remove build outputs, Turborepo cache, and `node_modules` |
| `npm run db:start` | Start the local Supabase stack (vendored CLI, needs Docker) |
| `npm run db:stop` | Stop the stack (data persists until `db:reset`) |
| `npm run db:reset` | Recreate local Postgres and re-apply all migrations |
| `npm run smoke` | Round-trip a structured request through **every configured provider**, price it, and write a verified `llm_usage` row — the P0 exit criterion |

Workspace-level command worth knowing when editing the provider registry:

```powershell
npm run test:conformance --workspace @ai-edu/llm
```

---

## 7. LLM provider setup

**Start with `ANTHROPIC_API_KEY`.** Anthropic is the only vendor with verified
pricing in `packages/llm/src/registry.ts` (stamped `verifiedOn: '2026-06-24'`),
so it is the only provider that produces real cost figures and enforces the
per-user daily budget out of the box.

**Other keys are optional and additive.** `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
and `MOONSHOT_API_KEY` each light up that vendor's models in the picker. Their
pricing is deliberately `null` (unverified), so their usage is recorded as
`null` cost and cannot count against `DAILY_USD_BUDGET_PER_USER` — never fill
prices in from memory; take them from the vendor's pricing page and stamp
`verifiedOn`.

**Running multiple providers:** just set multiple keys. A model appears in the
picker only when its vendor's key is present, providers without keys are
skipped everywhere (including `npm run smoke`), and `npm run smoke` round-trips
all configured providers at once.

**Adding any OpenAI-compatible vendor** (Groq, Together, OpenRouter, local
Ollama/vLLM, …): the provider layer covers them all with two adapters —
`packages/llm/src/adapters/anthropic.ts` (Claude only) and
`packages/llm/src/adapters/openai-compatible.ts` (everything else via
`baseURL`). Adding a model is a **data edit** in `packages/llm/src/registry.ts`
plus making the conformance suite pass:

```powershell
npm run test:conformance --workspace @ai-edu/llm
```

One hard rule: Claude never goes through the OpenAI-compatible adapter — it
would silently lose explicit prompt caching, adaptive thinking, and the 1M
context window.

**Smoke test** (verify providers end to end):

```powershell
npm run smoke
```

It loads the root `.env`, sends one trivial structured request through every
configured provider, validates the reply, prices it, and — if
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set — writes and reads back a
row in `llm_usage` to prove the accounting path. With no Supabase configured,
the accounting check is skipped (warned, not failed). With no provider key at
all, it exits with "No provider is configured".

---

## 8. Troubleshooting

### 8.1 `next build` fails / Turbopack refuses to build (WASM bindings)

The native SWC binary `@next/swc-win32-x64-msvc` is an optional dependency that
can silently fail to install. Check `Test-Path
node_modules\@next\swc-win32-x64-msvc`; if missing:

```powershell
npm install @next/swc-win32-x64-msvc@^16.3.2 --workspace @ai-edu/web
```

### 8.2 `tsc -b` succeeds but there is no `dist/`

Stale `*.tsbuildinfo` files (they survive repo copies; `apps/api` ships one in
this copy). TypeScript reads them, concludes everything is already built, and
emits nothing. Delete them all and force a rebuild:

```powershell
Get-ChildItem -Recurse -Filter *.tsbuildinfo |
  Where-Object { $_.FullName -notmatch 'node_modules' } | Remove-Item
npx turbo run build --force
```

Use `--force` after any repo move so Turborepo doesn't replay the stale cache.

### 8.3 Docker / `npm run db:start` issues

- **Disk space:** Docker's data disk lives on `C:`
  (`AppData\Local\Docker\wsl\disk\docker_data.vhdx`) even when the repo is
  elsewhere. The first `db:start` pulls a few GB there. `C:` is a 238 GB drive
  that historically ran close to full — check free space first; filling it is
  what forced this repo off `C:` once already.
- **Port conflicts on 54321–54327:** the ports are fixed in
  `supabase/config.toml`. If another Supabase project is running, stop it first
  (`npm run db:stop` here, or `supabase stop` in the other project).
- **`npx supabase` doesn't work on Windows:** the npm wrapper has no win32-x64
  binary. Use the vendored `.tools/supabase.exe` (§4.1) — the `db:*` scripts
  already do.

### 8.4 `.tools/supabase.exe` missing

`.tools/` is gitignored, so it won't be there after a fresh clone. Download
`supabase_windows_amd64.tar.gz` from the [supabase/cli GitHub
releases](https://github.com/supabase/cli/releases) (v2.115.0) and extract
`supabase.exe` into `.tools\` — see §4.1 for the exact commands.

### 8.5 Web shows "Supabase is not configured"

The two `NEXT_PUBLIC_SUPABASE_*` variables aren't visible to `next dev`.
Remember: Next.js reads `.env` files from `apps/web/` only — the repo-root
`.env` is loaded by the API and the smoke script, but **not** by Next.js. Put
the values in `apps/web/.env.local` (§3) and restart the dev server.

### 8.6 `npm run smoke` says "No provider is configured"

No LLM key is set. Put at least one key (recommended: `ANTHROPIC_API_KEY`) in
the root `.env` — the smoke script loads it via `--env-file-if-exists=.env`.

### 8.7 Which key goes where

- Root `.env` — everything: provider keys, server-side Supabase keys, budget.
- `apps/web/.env.local` — only the two `NEXT_PUBLIC_SUPABASE_*` values.
- The **service-role key never goes anywhere `NEXT_PUBLIC_`-prefixed** — it
  bypasses RLS. The browser gets the anon key, which is safe because every
  table is RLS-gated.

---

## 9. Project structure

```
AI-Education/
├── apps/
│   ├── web/            Next.js 16 (App Router) + React 19 — rendering only
│   │                   (ask + projects UI; Monaco editor, sandboxed practice frames)
│   └── api/            Fastify 5 — orchestration, SSE, auth, budgets, attachments (:3001)
├── packages/
│   ├── llm/            provider-agnostic LLM layer — model registry + 2 adapters
│   ├── core/           portable domain logic — interview, agents, generation, pacing
│   ├── api-client/     typed SDK + SSE streaming (what the web app talks through)
│   └── runners/        browser sandboxes (P3, not built yet)
├── supabase/
│   ├── config.toml     local stack config (ports, auth, seed)
│   └── migrations/     0001_init.sql (13 tables, RLS forced), 0002_hardening.sql
├── scripts/
│   └── smoke-providers.mjs   the P0 provider smoke test (npm run smoke)
├── .tools/             vendored supabase.exe (gitignored — see §4.1)
├── turbo.json          Turborepo pipeline + env-var cache keys
├── CONTEXT.md          orientation, invariants, and gotchas for contributors
└── setup.md            this file
```

Conventions that matter during setup and first runs:

- `apps/web` never calls `fetch` directly — all API traffic goes through
  `@ai-edu/api-client` (that rule is what will let a React Native app reuse the
  whole layer).
- `packages/core` and `packages/api-client` must stay portable to React Native:
  lint bans Node builtins and vendor SDKs there, and `core` compiles without
  the DOM lib — `document`/`window` are *type errors* in it.
- The service-role Supabase key is for `apps/api` only; the browser gets the
  anon key, which is safe because RLS gates every table.
- Zod schemas in `packages/core/src/schemas/` are the single source of truth;
  the DB enums in `supabase/migrations/0001_init.sql` mirror them.
