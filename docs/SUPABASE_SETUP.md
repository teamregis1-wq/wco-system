# Supabase Setup — New Project for WCO Atlas

This guide sets up a **new, empty** Supabase project and connects the existing application to it,
using the existing Alembic migrations. Nothing here touches the old `hotspotapp` project.

> Credentials go only in `backend/.env` (gitignored) and in Vercel's environment-variable settings.
> Never paste them into code, docs, issues or screenshots.

## 0. Before you start

- Python **3.11 or 3.12** with the backend virtualenv (`backend/venv`, or `backend/.venv` with 3.12).
  The worker and the tests need `requirements-dev.txt`, which includes PyTorch.
- In the Supabase dashboard, use a strong database password (not a variation of an old one). Reset it under
  *Project Settings → Database → Reset database password* if it was ever shared in chat or email.

## 1. Create the project

1. Sign in with the thesis Google account → **New project**.
2. Region: Singapore (`ap-southeast-1`) is the closest to Batangas City. The WCO Atlas project was created in
   **Sydney (`ap-southeast-2`)**, which works fine. Either way, set Vercel Functions to the matching region
   (`syd1` for Sydney, `sin1` for Singapore) to keep API → database latency low.
3. Save the database password in a password manager.

## 2. Enable PostGIS (before running migrations)

*Database → Extensions → search "postgis" → Enable*. Supabase installs it in the `extensions` schema,
which is on the default `search_path`, so the app's geometry columns and `ST_*` functions resolve
without changes. (SQL editor alternative: `CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;`.)
`scripts/check_db.py` verifies that the `geometry` type resolves.

## 3. Get the connection strings

Click **Connect** at the top of the project page:

| Use | String | Port | Where |
|---|---|---|---|
| Local API, migrations, scripts, tests, **retraining worker** | **Session pooler** | 5432 | `backend/.env` → `DATABASE_URL` (worker on Vercel: `WORKER_DATABASE_URL`) |
| **Vercel API functions** (serverless) | **Transaction pooler** | 6543 | Vercel env → `DATABASE_URL` |

Format: `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:<port>/postgres`
(the WCO Atlas project uses `aws-0-ap-southeast-2…`; the Session and Transaction poolers share that host
and differ only in the port: 5432 vs 6543).

- The **direct** host `db.<project-ref>.supabase.co` is **IPv6-only** (no IPv4 address). Vercel functions and many
  networks cannot reach it, so use the pooler strings above.
- `postgresql://` is fine; the app rewrites it to the Psycopg 3 driver. Percent-encode special characters in the password.
- SSL: the app adds `sslmode=require` for non-local hosts automatically.
- On port 6543 the app disables Psycopg's prepared statements (required by transaction pooling) automatically.

Create `backend/.env` from `backend/.env.example` and set `DATABASE_URL` (Session pooler), `JWT_SECRET`
(`python -c "import secrets; print(secrets.token_hex(32))"`) and `CORS_ORIGINS`.

## 4. Initialise the database (in this order)

```bash
cd backend
./venv/bin/python -m scripts.check_db      # read-only: connects, PostGIS ok, schema "at None" (empty)
./venv/bin/alembic upgrade head            # creates all tables, constraints, indexes, RLS (8 migrations)
./venv/bin/python -m scripts.check_db      # expect: "schema at head (c9d0e1f2a3b4)", RLS on all tables
```

Migrations never run automatically: not on API startup, not on Vercel deployments. Run them yourself
from a trusted machine after each pull that adds a migration (`alembic current` shows the state).
The migration chain is linear: `c3103997e4f0 → a33177c2efed → 48824bcdd3da → 9c43835c3d40 → e1f2a3b4c5d6
→ f2b3c4d5e6a7 → b7c8d9e0f1a2 → c9d0e1f2a3b4`.

## 5. Create the first administrator

```bash
./venv/bin/python -m scripts.create_admin --email <thesis-account-email> --name "<Name>"
```

The password is read with a hidden prompt (12+ characters) and is never printed or stored in plain text.
Further accounts: sign in as admin → Admin → **+ Add user**. Public self-registration only creates viewers.

## 6. Load the synthetic demonstration dataset

```bash
./venv/bin/python -m scripts.load_demo_data            # dry run: 120 establishments, 6,240 records
./venv/bin/python -m scripts.load_demo_data --commit   # insert
```

- 120 establishments (60 restaurants, 40 fast food, 20 food manufacturers) × **52 consecutive weeks
  ending at the last completed week**, so forecasts start from the present study period.
- Every row is `data_source = synthetic`, `consent_given = false`, with **generic names**
  ("Fast-food outlet FF012 — Pallocan West"), approximate landmark-based coordinates, and a fixed seed (42).
- Additive and idempotent: re-running inserts nothing. Existing rows are never changed. Duplicate
  establishment-weeks are impossible (unique constraint).
- It queues one retraining job. Run the worker (§7) to train the first model.
- Later, to bring the series up to date before a presentation, run
  `./venv/bin/python -m scripts.load_demo_data --extend-existing --commit`.
- Ids in the new database will not match the old one or `data/wco_export.csv`. Nothing relies on them;
  `wco_code` is the stable key.
- **Do not** import the old project's records or `data/batangas_city_restaurants_seed.csv` without first
  reviewing where they came from. Don't run `label_data_source` on rows whose origin you haven't verified.

## 7. Train the first model (retraining worker)

```bash
./venv/bin/python -m scripts.retrain_worker --once      # process the queued job, then exit
# or keep it running so every data change is retrained automatically:
./venv/bin/python -m scripts.retrain_worker
```

`/api/v1/forecast/training-status` (Admin → LSTM panel) then shows the active version, held-out
metrics, and the worker heartbeat. Hosting options for a permanent worker: [DEPLOYMENT_VERCEL.md §5](DEPLOYMENT_VERCEL.md#5-the-retraining-worker).

## 8. Verify against real PostgreSQL/PostGIS

```bash
# Non-destructive checks of the real public schema (read-only or rolled back):
TEST_DATABASE_URL="<session-pooler-url>" TEST_TRANSACTION_POOLER_URL="<transaction-pooler-url>" \
  ./venv/bin/python -m pytest tests/test_postgres_integration.py

# Whole suite (auth, CRUD, imports, jobs, locking, versions, GIS, forecasts, routes) on real PostGIS,
# isolated in a throwaway schema "wco_test" that is created and dropped by the run:
TEST_DATABASE_URL="<session-pooler-url>" ./venv/bin/python -m pytest
```

The full-suite run creates its tables in the `wco_test` schema, truncates them between tests, uses a
separate advisory-lock key, and drops the schema at the end. `public` is protected three ways:
- every statement is explicitly qualified with `wco_test`
- the test connections' `search_path` excludes `public`
- a tripwire compares `public`'s tables and row counts before and after the run, and fails if anything changed

Even so, run it before loading data you care about, or after a backup.

## 9. Backups

Take one before any migration on a database that has data you care about:

```bash
pg_dump "<session-pooler-url>" --schema=public --no-owner --no-privileges --format=custom \
  --file="wco_backup_$(date +%Y%m%d_%H%M).dump"
./venv/bin/python -m scripts.export_csv            # dated CSV of all WCO records
```

You need `pg_dump` with a major version ≥ the server's (macOS: `brew install libpq`). Restore into an
empty project with `pg_restore --no-owner --no-privileges --dbname "<url>" <file>.dump` (enable PostGIS first).
Rollback of the newest migration: `alembic downgrade b7c8d9e0f1a2` (drops `retraining_workers` and the retry
counter). Back up first.

## 10. Access control and limits

- RLS is enabled on every application table with no policies, so Supabase's auto-generated REST API
  exposes nothing to the anon key. The frontend only talks to FastAPI; don't put Supabase keys in the frontend.
- The API connects as `postgres` (bypasses RLS); authorization is enforced by the API roles. Optional
  hardening: a least-privilege login role for the app (test on a copy first; keep running migrations as `postgres`):
  ```sql
  CREATE ROLE wco_app LOGIN PASSWORD '<strong-password>';
  GRANT USAGE ON SCHEMA public TO wco_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wco_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wco_app;
  -- RLS applies to non-owner roles, so give wco_app (only) a permissive policy per table:
  DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys' LOOP
      EXECUTE format('CREATE POLICY wco_app_all ON public.%I FOR ALL TO wco_app USING (true) WITH CHECK (true)', t);
    END LOOP; END $$;
  ```
  Tables added by later migrations need the same grant and policy; without a policy RLS returns zero rows to that role.
- **Connection budget.** Each API instance keeps ≤ `DB_POOL_SIZE + DB_MAX_OVERFLOW` (3 + 2) connections to
  the pooler, and the worker uses about 2. The Supabase free tier allows hundreds of pooler *client*
  connections (transaction mode multiplexes them onto a small server pool). If you see "too many clients",
  lower `DB_POOL_SIZE` on Vercel to 1–2.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `OperationalError`, timeout | Using the IPv6-only direct host, or the project is paused → use the pooler string |
| `password authentication failed` | Wrong password, or the user isn't `postgres.<project-ref>` on the pooler |
| `Tenant or user not found` | Wrong project ref in the pooler user name |
| `type "geometry" does not exist` | PostGIS not enabled (§2) |
| `prepared statement … already exists` | Transaction pooler used without the app's settings (old code or another client) — use port 5432 for scripts |
| Startup log "schema is at … but code expects …" | Run `alembic upgrade head` |
