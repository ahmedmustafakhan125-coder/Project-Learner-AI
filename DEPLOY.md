# DEPLOY.md

Production deployment: **Next.js web app on Vercel**, **Fastify API and the Python
security gateway on a Linux VPS**, **Postgres on Supabase cloud**.

Read [CONTEXT.md](CONTEXT.md) before changing anything — it carries the
invariants this guide assumes. [setup.md](setup.md) covers local development;
this file covers production only.

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
```

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
  relying on remote caching.
- Rate limiting is per-process and in memory. It is correct for a single API
  instance; running several behind a load balancer needs a shared store.
- `npm test` runs 285 tests with no network, keys, or database, and is the
  fastest post-deploy sanity check on the VPS build.
