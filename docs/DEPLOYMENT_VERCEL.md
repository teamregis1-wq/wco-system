# Deploying WCO Atlas on Vercel (Services) with Supabase

One Vercel project serves the whole site on one domain: the Next.js **frontend** and the FastAPI
**backend** run as two Vercel Services. The LSTM **retraining worker** runs as a separate,
long-lived process. Data lives in **Supabase** PostgreSQL/PostGIS.

```
Browser ──► https://<project>.vercel.app
              ├─ /api/*  ──► service "backend"  (FastAPI, Python ≥3.12, NumPy inference, NO PyTorch)
              │                 │  reads/writes data, QUEUES retraining jobs, reports status
              │                 ▼
              │          Supabase PostgreSQL + PostGIS ◄── Transaction pooler :6543
              │                 ▲
              │                 │  Session pooler :5432 (advisory lock, long transactions)
              │          retraining worker  (python -m scripts.retrain_worker, PyTorch)
              │            polls queued jobs → trains → evaluates → stores + activates model
              └─ /*      ──► service "frontend" (Next.js)
```

## 1. `vercel.json` (repository root)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "services": {
    "backend":  { "root": "backend",  "framework": "fastapi", "entrypoint": "app.main:app" },
    "frontend": { "root": "frontend", "framework": "nextjs" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)",     "destination": { "service": "frontend" } }
  ]
}
```

- **Service names / roots:** `backend` → `backend/` (FastAPI app object `app` in `backend/app/main.py`);
  `frontend` → `frontend/` (Next.js 14). The old `frontend/vercel.json` is removed; its
  `framework` now lives in the service entry.
- Validated against `https://openapi.vercel.sh/vercel.json` (0 errors) and run locally with `vercel dev --local`.

## 2. Public routes

| Public path | Service | Reaches FastAPI as |
|---|---|---|
| `/api/v1/...` (all API endpoints) | backend | `/api/v1/...`, **unchanged** (Vercel forwards the original path; there is no `/api/api` problem) |
| `/api/v1/health`, `/api/v1/health/db` | backend | liveness / readiness (no credentials in the output) |
| `/api/docs`, `/api/openapi.json` | backend | Swagger UI / schema |
| everything else (`/`, `/map`, `/dashboard`, …) | frontend | — |

`/health` without `/api` is served by the frontend (404) on Vercel; use `/api/v1/health`. Privileged
operations (training, user management, writes) still require an authenticated admin/researcher token.

## 3. Service bindings: none needed

Bindings are only for **server-side** code in one service calling another over Vercel's internal
network. In this app every API call is made by **browser** code (all pages are client components; there
are no Next.js route handlers or server actions calling FastAPI), and browser code cannot use bindings
anyway. The browser calls same-origin `/api/v1`, routed by the rewrite above. The worker talks to
Supabase directly, not to the API.

The frontend's API base is `NEXT_PUBLIC_API_BASE` if set, otherwise **`/api/v1`** (see `frontend/lib/api.ts`).
It is inlined at build time.

## 4. Platform constraints and how the code handles them

| Constraint (Vercel docs, Nov 2026) | Consequence | What the code does |
|---|---|---|
| Python runtime **3.12+** | The old 3.11 pin is irrelevant on Vercel | Test suite passes on 3.11 **and** 3.12 |
| Python bundle ≤ **500 MB** uncompressed | PyTorch on Linux exceeds it | API inference is a NumPy LSTM forward pass (verified equal to PyTorch); `requirements.txt` has no PyTorch (~270 MB installed on macOS) |
| Functions on Fluid compute, ≤ 300 s (Hobby), frozen after the response | Background threads are not a reliable place to train | API runs with `RETRAIN_EXECUTOR=worker` (auto-detected on Vercel): it only **queues** jobs in PostgreSQL |
| Read-only filesystem except temp | Local model cache cannot be written next to the code | Cache moves to the temp dir on Vercel; the database holds the durable model |
| Many short-lived instances | Connection counts multiply | Transaction pooler (6543) with prepared statements disabled; small per-instance pool |
| Direct DB host is IPv6-only | Unreachable from Vercel | Use Supabase pooler hosts |

## 5. The retraining worker

**Why it's needed.** Automatic retraining has two halves. *Queueing* happens inside the API on every
committed data change (durable, in PostgreSQL). *Training* needs PyTorch, 10–60 s of CPU, a session
database connection for the advisory lock, and must not be cut off mid-run. A serverless function can't
guarantee that, so a separate persistent process does the training. Without a running worker, jobs stay
**pending** (safely) and the Admin panel says "Retraining worker: offline". Retraining is never
silently replaced by manual-only training.

What the worker does every `WORKER_POLL_SECONDS` (5 s):
1. Heartbeat to `retraining_workers`.
2. If the pending job's debounce has elapsed, claim it atomically (pending → training) under a PostgreSQL advisory lock.
3. Validate data → train → evaluate → store the version (weights, scaler, metrics) and activate it in one transaction.
4. On a transient failure, mark the job failed and re-queue it with back-off (up to `RETRAIN_MAX_ATTEMPTS`). The previous model keeps serving. Jobs orphaned by a crash are failed and re-queued on the next start.

Run as many workers as you like; only one trains at a time.

**Hosting options**

| Option | Good for | Notes |
|---|---|---|
| **A. A laptop or lab PC** running `./venv/bin/python -m scripts.retrain_worker` with `backend/.env` (Session pooler) | The Nov 23 recheck: zero setup, fully automatic while it runs | Must stay on and online during the demo |
| **B. Vercel Daemon** (public beta, all plans, **production deployments only**) from `backend/worker.Dockerfile` | Keeping everything in one Vercel project | Hobby quotas apply (Active CPU / memory); not available in preview deployments; `vercel dev` does not run daemons; image builds add deploy time. Snippet below, **not enabled by default** |
| **C. Any always-on container host** (Render/Railway background worker, a small VM) with the same Dockerfile | Final defense / long-term | Set `DATABASE_URL` (Session pooler) and `JWT_SECRET` |

Vercel Daemon configuration (add to `vercel.json` only if you choose option B):
```json
"daemons": {
  "retrain_worker": {
    "root": "backend",
    "entrypoint": "worker.Dockerfile",
    "instances": { "sin1": 1 },
    "resources": { "requests": { "memory": "2Gi" } },
    "terminationGracePeriodSeconds": 300
  }
}
```
For option B also set `WORKER_DATABASE_URL` (Session pooler) in Vercel, because `DATABASE_URL` there is the transaction pooler.

## 6. Environment variables

| Variable | Vercel (Production + Preview) | Local `backend/.env` | Worker |
|---|---|---|---|
| `DATABASE_URL` | Supabase **Transaction** pooler (`:6543`) | **Session** pooler (`:5432`) | Session pooler |
| `WORKER_DATABASE_URL` | Session pooler (only for a Vercel Daemon) | — | optional |
| `JWT_SECRET` | same 64-hex secret everywhere | same | same (required by settings) |
| `CORS_ORIGINS` | `https://<project>.vercel.app` (+ custom domain) | `http://localhost:3000` | — |
| `RETRAIN_EXECUTOR` | `worker` (also auto-detected) | unset (= in-process) or `worker` | set by the Dockerfile / script |
| `DEFAULT_DATA_SOURCE` | `synthetic` for the defense | `synthetic` | — |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `2` / `2` | defaults | defaults |
| `NEXT_PUBLIC_API_BASE` | **unset**, or `/api/v1` (delete any old value pointing to Railway/Render) | `http://localhost:8000/api/v1` in `frontend/.env.local` for two-terminal dev | — |

Supabase itself needs no app variables. PostGIS must be enabled and migrations applied (SUPABASE_SETUP.md).
Never set Supabase anon/service keys in the frontend; the app doesn't use them.

## 7. Deploy from GitHub (after you approve)

1. Review and merge the branch `audit/recheck-fixes-2026-11` (or open a PR first and use its Preview deployment).
2. Vercel → Project → **Settings → General → Root Directory**: change from `frontend` to the **repository
   root** (leave it empty). With `vercel.json` services at the root, Vercel detects both services.
3. **Settings → Environment Variables**: set the table above for *Production* and *Preview*; remove the
   old `NEXT_PUBLIC_API_BASE`.
4. **Settings → Functions → Region**: `sin1` (Singapore), the same region as Supabase.
5. Deploy (push to the production branch, or *Redeploy*). Migrations are **not** run by the deployment;
   run `alembic upgrade head` locally first (SUPABASE_SETUP.md §4).
6. Start a worker (option A, B or C).
7. Verify:
   - `https://<project>.vercel.app/api/v1/health` → `{"status":"ok"}`
   - `/api/v1/health/db` → `"ready": true`, PostGIS version, `migrations_up_to_date: true`
   - Sign in, then add a WCO record → the badge shows "retraining scheduled" → within ~25 s (debounce + poll)
     the worker trains → "Forecast model updated — lstm-…" → the Admin panel shows the new version.

## 8. Local development

- **Two terminals** (fastest): `uvicorn app.main:app --reload` in `backend/` (in-process retraining), and
  `npm run dev` in `frontend/` with `NEXT_PUBLIC_API_BASE=http://localhost:8000/api/v1` in `frontend/.env.local`.
- **Vercel Services locally** (closest to production): needs a Python **3.12** virtualenv at `backend/.venv`
  (Vercel's runtime package requires 3.12, and `vercel dev` prefers `.venv` over `venv`):
  ```bash
  python3.12 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt
  # comment out NEXT_PUBLIC_API_BASE in frontend/.env.local, export the backend env vars, then:
  npx vercel@latest dev --local --listen 127.0.0.1:3100
  # in another terminal (worker, with PyTorch):
  cd backend && ./venv/bin/python -m scripts.retrain_worker
  ```
