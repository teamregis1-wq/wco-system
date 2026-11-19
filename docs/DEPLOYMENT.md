# Deploying WCO Atlas — Vercel (frontend) + Railway (backend) + Supabase

```
Browser ──► https://<project>.vercel.app          Next.js frontend (Vercel, Root Directory = frontend)
   │
   └─ API calls ─► https://<backend>.up.railway.app/api/v1    FastAPI backend (Railway, Root Directory = backend)
                      │  reads/writes data, forecasts (NumPy), and RETRAINS the LSTM in-process (PyTorch CPU)
                      ▼
               Supabase PostgreSQL + PostGIS  (Session pooler :5432)
```

Both platforms deploy automatically from the GitHub branch they are connected to (normally `main`).
Database migrations are **never** run by a deployment — see §5.

## 1. Railway — backend

**Service settings**

| Setting | Value |
|---|---|
| Source | this GitHub repository, branch `main` |
| Root Directory | `backend` |
| Build | automatic (Python detected from `requirements.txt`; version from `runtime.txt`) |
| Start command | from `Procfile`: `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Healthcheck path | `/api/v1/health` |
| Networking | *Generate Domain* → `https://<backend>.up.railway.app` |
| Replicas | 1 (retraining is serialised by a PostgreSQL advisory lock anyway) |

`requirements.txt` installs the **CPU-only** PyTorch wheel on Linux (≈700 MB image), so automatic
retraining runs inside the API process — no separate worker is needed. The `worker` line in the
`Procfile` and `worker.Dockerfile` are only for the optional set-up in §6.

**Variables** (Railway → service → Variables)

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **Session pooler** string (port 5432), password percent-encoded |
| `JWT_SECRET` | 64 random hex characters: `python -c "import secrets; print(secrets.token_hex(32))"` — **the API refuses to start without it** |
| `CORS_ORIGINS` | `https://<project>.vercel.app` (add any custom domain, comma-separated). Needed only if the frontend calls Railway directly (§2, option A) |
| `DEFAULT_DATA_SOURCE` | `synthetic` for the defense dataset |
| `DB_SSLMODE` | `require` (default) |

Leave `RETRAIN_EXECUTOR` unset (= in-process on Railway). Supabase anon/service keys are not used.

## 2. Vercel — frontend

| Setting | Value |
|---|---|
| Root Directory | `frontend` (Framework preset: Next.js) |
| Production branch | `main` |

Choose **one** way for the browser to reach the backend (Settings → Environment Variables, Production
and Preview). Both are read at **build** time, so redeploy after changing them.

| Option | Vercel variable | Notes |
|---|---|---|
| **A. Direct** | `NEXT_PUBLIC_API_BASE=https://<backend>.up.railway.app/api/v1` | Simplest. Railway's `CORS_ORIGINS` must list the Vercel URL. |
| **B. Proxy** | `BACKEND_URL=https://<backend>.up.railway.app` and **no** `NEXT_PUBLIC_API_BASE` | Browser calls `/api/v1` on the Vercel site; `next.config.mjs` forwards it to Railway. No CORS set-up. |

## 3. Supabase

Database, PostGIS and backups: [SUPABASE_SETUP.md](SUPABASE_SETUP.md). The direct `db.<ref>` host is
IPv6-only; use the pooler host. The Transaction pooler (6543) also works (`prepare_threshold` is
disabled automatically) but the Session pooler is recommended for a long-running server.

## 4. Verify after a deploy

1. `https://<backend>.up.railway.app/api/v1/health` → `{"status":"ok"}`
2. `…/api/v1/health/db` → `"ready": true`, PostGIS version, `migrations_up_to_date: true`
3. Open the Vercel site, sign in, open the Dashboard (data loads).
4. Add a WCO record → the badge shows "retraining scheduled" → after the debounce (20 s) the model
   retrains in the Railway process (about a minute) → "Forecast model updated — lstm-…".
   Railway's logs show the training run.

If the browser console shows CORS errors, check option A's `CORS_ORIGINS`, or switch to option B.

## 5. Migrations

Deployments do not change the database schema. When a change adds an Alembic migration, back up and
run it yourself before (or right after) deploying: `cd backend && ./venv/bin/alembic upgrade head`
with `backend/.env` pointing at Supabase. `/api/v1/health/db` reports whether the schema is up to date.

## 6. Optional: a separate retraining worker

If the API should not train in its own process (for example to keep it small or on a serverless host),
set `RETRAIN_EXECUTOR=worker` on the API; it then only **queues** jobs. Run the worker anywhere with
`backend/.env` (Session pooler): `./venv/bin/python -m scripts.retrain_worker`, or as a container from
`backend/worker.Dockerfile`. Workers heartbeat to `retraining_workers`; the Admin panel shows whether
one is online. Jobs wait safely in PostgreSQL while no worker runs.

## 7. Local development

Two terminals: `./venv/bin/uvicorn app.main:app --reload --port 8000` in `backend/` (trains in-process),
and `npm run dev` in `frontend/` with `NEXT_PUBLIC_API_BASE=http://localhost:8000/api/v1` in
`frontend/.env.local`.
