# DEPLOY.md

Local development and production operations for Project Learner.

The repository is an npm-workspaces monorepo: a Next.js web app, a Fastify API,
portable domain packages, a Supabase database, and a separate Python security
gateway. [README.md](README.md) explains the architecture and the eight
invariants that must be preserved when changing the system.

The deployment shape is **Next.js on Vercel**, **Fastify and the Python security
gateway on a Linux VPS**, and **Postgres on Supabase cloud**. The local setup
uses the same application processes with Supabase running in Docker.

---

## Contents

- [Local development](#local-development)
- [Production deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

---

# Local development

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | `>=20.11.0` | Use a current LTS release. |
| npm | `11.10.0` | Install from the repository root; npm workspaces are used. |
| Docker Desktop | Running | Required for the local Supabase stack. |
| Python | 3.11+ | Required only for the security gateway repository. |
| Git | Any recent version | |

The Supabase CLI is vendored at `.tools/supabase.exe` and is gitignored. On
Windows, Docker stores its data on `C:` even when this repository is elsewhere;
the first database start can consume several GB.

## Quick start

```powershell
git clone <repository-url>
cd Project-Learner-AI
npm install
copy .env.example .env
# Install the Supabase CLI into .tools; see Database below.
npm run db:start
# Copy the printed keys into .env and apps\web\.env.local.
npm run dev
```

The web app runs at `http://localhost:3000` and the API at
`http://localhost:3001`. Start the security gateway before asking questions;
model-bound routes fail closed when screening is unavailable.

## Environment

The API reads the repository-root `.env`. Next.js does not, so create
`apps/web/.env.local` with the browser-visible values:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key printed by npm run db:start>
```

The root `.env` should contain the local Supabase values and at least one
provider key:

```env
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_ANON_KEY=<anon key>
ANTHROPIC_API_KEY=<optional>
OPENAI_API_KEY=<optional>
GEMINI_API_KEY=<optional>
OPENROUTER_API_KEY=<optional>
DEEPSEEK_API_KEY=<optional>
MOONSHOT_API_KEY=<optional>
SECURITY_GATEWAY_URL=http://127.0.0.1:8000
SECURITY_GATEWAY_TIMEOUT_MS=15000
DAILY_USD_BUDGET_PER_USER=2
PORT=3001
WEB_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Provider keys are individually optional; models without a configured vendor
key are hidden from the picker. The service-role key bypasses RLS and belongs
only in the API environment, never in a `NEXT_PUBLIC_*` variable or browser
bundle. Public values are inlined at build time, so restart the web app after
changing them.

## Database

Fetch the CLI once on Windows if `.tools\supabase.exe` is missing:

```powershell
mkdir .tools
cd .tools
curl -LO https://github.com/supabase/cli/releases/download/v2.115.0/supabase_windows_amd64.tar.gz
tar -xzf supabase_windows_amd64.tar.gz
del supabase_windows_amd64.tar.gz
cd ..
```

Start, stop, or reset the local stack with:

```powershell
npm run db:start
npm run db:stop
npm run db:reset   # destroys local data and reapplies every migration
```

The migrations in `supabase/migrations/` are applied in filename order. There
are currently 10 migrations, covering the schema, forced RLS, step progress,
finished-project artifacts, follow-ups, the project tutor, and step timing.
For a non-destructive update, use:

```powershell
.\.tools\supabase.exe migration list --local
.\.tools\supabase.exe migration up --local
```

Useful local services are Supabase API on `54321`, Postgres on `54322`, Studio
on `http://127.0.0.1:54323`, and the mail viewer on `http://127.0.0.1:54324`.
Local email confirmation is disabled, so any test address works in the UI.

## Security gateway

The gateway runs from the separate `llm-security-gateway-final` repository:

```bash
uvicorn app.main:app --reload --port 8000
```

Set `SECURITY_GATEWAY_URL=http://127.0.0.1:8000` in the root `.env`. Questions,
interview answers, tutor turns, project generation prompts, and attachment text
are screened before reaching a model. If the gateway is down, read-only routes
continue to work but model-bound routes refuse by design.

## Local verification

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke             # requires configured provider keys
npm run test:containment --workspace @ai-edu/web
```

The containment suite requires a production build and an installed Chrome or
Edge browser. `npm run dev` and `npm run build` automatically vendor Monaco and
Pyodide into `apps/web/public/` from installed packages.

---

# Production deployment

Production deployment: **Next.js web app on Vercel**, **Fastify API and the Python
security gateway on a Linux VPS**, **Postgres on Supabase cloud**.

---

## Why the API is not on Vercel

This is architectural, not a configuration gap. `apps/api` is a long-lived
Fastify process:

- `apps/api/src/server.ts` calls `app.listen()` and sets `connectionTimeout: 0`,
  deliberately, so a slow fan-out is never cut short.
- `apps/api/src/routes/agents.ts` writes Server-Sent Events straight to the raw
  socket and holds the connection open while four agents stream.
- Rate limiting is in-memory. Across serverless instances it would count nothing.

Vercel runs functions, not servers. The web app deploys there cleanly; the API
needs a host that runs a Node process.

```
VPS   nginx :443 ──► api.example.com   → Fastify   127.0.0.1:3001
                     gateway NOT exposed           127.0.0.1:8000
Vercel              app.example.com    → Next.js
Supabase cloud                         → Postgres + auth
```

**The gateway binds to loopback only.** It has no authentication of its own, so
anything that can reach it can spend your CPU on spaCy. Only the API talks to
it, and that is a local hop.

---

## 1. Supabase

Create a cloud project. Apply the migrations **in order** — `0001` through
`0006` — via the SQL editor or `supabase db push`. Order matters: `0003` makes
the attempt-insert policy `RESTRICTIVE`, which only behaves correctly on top of
the permissive owner policy `0001` creates.

From **Settings → API**, take:

| Value | Goes to |
|---|---|
| Project URL | VPS and Vercel |
| `anon` key | Vercel (browser). Safe — RLS gates every table. |
| `service_role` key | **VPS only.** Bypasses RLS. Never `NEXT_PUBLIC_`, never in the browser. |

---

## 2. VPS prerequisites

```bash
sudo apt update && sudo apt install -y nginx git python3-venv python3-pip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo adduser --system --group --home /srv/ai-edu deploy
```

`package.json` requires Node `>=20.11.0`. The gateway loads spaCy and Presidio
models — budget **1.5–2 GB RAM** for it alone.

---

## 3. The API

```bash
sudo -u deploy -H bash
cd /srv/ai-edu
git clone <repo-url> app && cd app
npm install                                  # workspace root only
npx turbo run build --filter=@ai-edu/api
```

`npm install` must run at the repo root: `apps/api` depends on the workspace
packages `@ai-edu/core` and `@ai-edu/llm`.

Create `/srv/ai-edu/app/.env`, then `chmod 600` it:

```bash
NODE_ENV=production
PORT=3001
WEB_ORIGIN=https://app.example.com          # exact Vercel origin, see §6
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
ANTHROPIC_API_KEY=<key>                     # at least one provider key
SECURITY_GATEWAY_URL=http://127.0.0.1:8000
SECURITY_GATEWAY_TIMEOUT_MS=15000
DAILY_USD_BUDGET_PER_USER=2
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are the only hard requirements —
the process refuses to start without them (`apps/api/src/env.ts`). Provider keys
are individually optional; a model appears in the picker only when its vendor's
key is present.

`/etc/systemd/system/ai-edu-api.service`:

```ini
[Unit]
Description=AI Education API
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/ai-edu/app
EnvironmentFile=/srv/ai-edu/app/.env
ExecStart=/usr/bin/node apps/api/dist/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`ExecStart` calls node directly rather than `npm start`, because that script
loads `../../.env` itself and systemd is already supplying the environment.

---

## 4. The security gateway

From the `llm-security-gateway-final` repository:

```bash
cd /srv/ai-edu
git clone <gateway-repo-url> gateway && cd gateway
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m spacy download en_core_web_lg   # if not vendored
.venv/bin/python -m app.detectors.semantic_detector # trains the classifier once
```

`/etc/systemd/system/ai-edu-gateway.service`:

```ini
[Unit]
Description=LLM Security Gateway
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/ai-edu/gateway
ExecStart=/srv/ai-edu/gateway/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`--host 127.0.0.1` is deliberate. Do not publish this port.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-edu-gateway ai-edu-api
curl 127.0.0.1:8000/health
curl 127.0.0.1:3001/health          # {"ok":true}
```

---

## 5. nginx

The SSE directives are not optional. The fan-out holds one connection open
while four agents stream; default buffering collects the whole response and
delivers it in a single lump at the end, which looks exactly like the feature
being broken.

```nginx
server {
  listen 80;
  server_name api.example.com;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Server-Sent Events.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

`X-Forwarded-For` is required. The API sets `trustProxy: true`, and rate
limiting falls back to `request.ip` for unauthenticated routes — without the
header every visitor shares one bucket.

The SSE route already sends `X-Accel-Buffering: no`, which nginx honours, but
`proxy_read_timeout` still applies and will cut a long stream regardless.

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com
```

---

## 6. The web app on Vercel

Import the repository. It is an npm-workspaces monorepo, so:

| Setting | Value |
|---|---|
| Framework | Next.js (auto-detected) |
| Root Directory | `apps/web` — **tick "Include files outside the root directory"** |
| Install Command | `npm install --prefix ../..` |
| Build Command | `npm run build` (leave default) |

Leave the build command alone: `npm run build` fires `prebuild`, which runs
`apps/web/scripts/vendor-assets.mjs` and copies Monaco and the Pyodide runtime
out of `node_modules` into `public/`. Those ~27 MB are gitignored on purpose, so
they are rebuilt on every deploy and cannot drift from `package.json`. **If that
script does not run, the code editor and the Python sandbox silently never
load.**

Environment variables:

```
NEXT_PUBLIC_SUPABASE_URL       = https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY  = <anon key>
NEXT_PUBLIC_API_URL            = https://api.example.com
NEXT_PUBLIC_APP_ORIGIN         = https://app.example.com
```

`NEXT_PUBLIC_APP_ORIGIN` is the origin of this site itself, and it is a security
control rather than a convenience. The `/sandbox` route builds its CSP from it
and names it as the target of every `postMessage` the sandbox sends back. Unset,
the route rebuilds the origin from the request's `Host` header — which a proxy
forwarding `$host` unvalidated lets a caller choose, putting their origin into
the sandbox's `script-src` and `connect-src`. The route logs a warning on every
boot that falls back, so check the deploy log if you are unsure.

`NEXT_PUBLIC_*` values are **inlined at build time**. Set them before the first
build; changing them later does nothing until you redeploy.

Then close the loop: set `WEB_ORIGIN` in `/srv/ai-edu/app/.env` to the final
Vercel origin and `sudo systemctl restart ai-edu-api`. CORS accepts exactly one
origin.

---

## 7. Verify

```bash
curl https://api.example.com/health                       # {"ok":true}
curl -I https://app.example.com | grep -i content-security # nonce-... present
```

In the browser: sign up, ask a question, watch four agents stream in parallel.
Open a project, edit a file, run a checkpoint.

---

## Failure modes, and what each looks like

| Symptom | Cause |
|---|---|
| Site loads, lists models, **refuses every question** with 422 | Gateway down or unreachable. Model-bound routes fail **closed** by design — an unscreened prompt never reaches a model. Check `curl 127.0.0.1:8000/health` first, always. |
| Browser CORS error on `/api/agents/ask` | `WEB_ORIGIN` does not exactly match the Vercel origin. Scheme and host must both match. |
| Answers arrive in one lump at the end instead of streaming | nginx buffering, or `proxy_read_timeout` too low. |
| Pages render correctly but **nothing is interactive** | `apps/web/proxy.ts` is not running. It mints the per-request CSP nonce; without it Next's inline hydration scripts are refused and React never hydrates. No error appears — the page just looks fine and does nothing. `app/layout.tsx` sets `force-dynamic` for the same reason; removing it reintroduces the bug. |
| Code editor stuck on "Loading editor…", Python checkpoints hang | `vendor-assets.mjs` did not run during the Vercel build. Both libraries default to a CDN and the app CSP lists none. |
| Login does nothing | `NEXT_PUBLIC_SUPABASE_*` missing at build time, or set after the build with no redeploy. |
| Deploy log warns `NEXT_PUBLIC_APP_ORIGIN is not set` | The sandbox is deriving its own CSP from the `Host` header. Set the variable and redeploy — see the environment list above. |
| API will not start | `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` missing. It fails loudly at boot on purpose. |

---

## Updating

```bash
cd /srv/ai-edu/app && git pull
npm install
npx turbo run build --filter=@ai-edu/api --force
sudo systemctl restart ai-edu-api
```

Vercel redeploys from git automatically. New migrations must be applied to
Supabase separately, in order, before restarting the API.

---

## Notes

- `turbo.json`'s `globalEnv` does not list `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` or
  `SECURITY_GATEWAY_URL`. Turbo's cache key will not change when those change,
  so a cached build can be replayed with stale values baked in. Add them before
  relying on remote caching. `NEXT_PUBLIC_APP_ORIGIN` is listed, because
  replaying a cached build with the wrong one baked in is a security regression
  rather than a stale string.
- Rate limiting is per-process and in memory. It is correct for a single API
  instance; running several behind a load balancer needs a shared store.
- `npm test` runs 285 tests with no network, keys, or database, and is the
  fastest post-deploy sanity check on the VPS build.
