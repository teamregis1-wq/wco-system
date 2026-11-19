# Supabase Setup, Recovery, Backup and Migration

This guide covers three situations: the old project is **paused**, its ownership must be
**transferred**, or you need a **new** project. In every case: check first, back up before
changing anything, and never run a destructive script against data you want to keep.

> Nothing in this repository was run against your Supabase project during the audit: no
> credentials were available. Every command below is for you to run.

## 1. Check the existing project first

Do not create a new database until you know the old one is gone.

1. Sign in at <https://supabase.com/dashboard> with the account that created the project and open it.
2. Read the banner on the project page:
   - **"Paused"** — free-plan projects are paused after a period of inactivity. Click **Restore project**
     and wait until the status is *Healthy* (this can take several minutes). The dashboard tells you
     how long a paused project remains restorable; restore it before that deadline.
   - **Not listed** — you may be signed in with a different account, or the project belongs to an
     organisation you are not a member of. Ask the owner to invite you
     (*Organization → Team*), or to transfer the project (§1.1).
   - **Healthy** — go straight to §3.
3. Confirm the data is there: *Table Editor → `wco_generation_records`* (expect ~6,240 rows if the
   bundled synthetic dataset was loaded).

### 1.1 Transferring ownership
The current owner can move the project into an organisation you own:
*Project Settings → General → Transfer project*. Both people must be owners of the target
organisation, and the plan may differ between organisations. A transfer keeps the database,
connection strings and data; you only need to update `DATABASE_URL` if the password is reset.

### 1.2 Creating a new project (only if the old one cannot be recovered)
1. *New project* → pick the region closest to the Philippines (e.g. Singapore, `ap-southeast-1`).
2. Save the database password in a password manager. You cannot view it again; you can only reset it.
3. Enable PostGIS: *Database → Extensions → postgis → Enable* (or SQL editor:
   `CREATE EXTENSION IF NOT EXISTS postgis;`).
4. Continue with §3, then load data (§5).

## 2. Connection string (Psycopg 3)

*Project Settings → Database → Connection string → **Session pooler***. Use the **Session pooler**
(port **5432**):

- The *direct* host is IPv6-only and fails on many home and campus networks.
- The *Transaction pooler* (port 6543) is **not supported**: the retraining scheduler uses session-level
  advisory locks, and SQLAlchemy/Psycopg rely on session state.

Put it in `backend/.env` (copy `backend/.env.example`; the file is gitignored):

```
DATABASE_URL=postgresql+psycopg://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
JWT_SECRET=<output of: python -c "import secrets; print(secrets.token_hex(32))">
CORS_ORIGINS=http://localhost:3000
```

- `postgresql://…` (as copied from Supabase) also works; the app rewrites it to `postgresql+psycopg://`.
- Percent-encode special characters in the password: `@`→`%40`, `#`→`%23`, `/`→`%2F`, `%`→`%25`.
  (Alembic used to crash on `%` in the URL; that is fixed.)
- Never commit `.env`, and never paste the connection string into issues, chat or screenshots. The
  app only ever logs it with the password masked.

### Required and optional environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Session-pooler URL |
| `JWT_SECRET` | yes | ≥ 32 random characters; the backend refuses to start without it |
| `CORS_ORIGINS` | yes in production | Comma-separated frontend origins (localhost and/or the Vercel URL) |
| `DEFAULT_DATA_SOURCE` | no (`unspecified`) | Set to `synthetic` for the defense deployment |
| `AUTO_RETRAIN_ENABLED`, `RETRAIN_DEBOUNCE_SECONDS`, `RETRAIN_POLL_SECONDS` | no | Automatic retraining (see ML doc) |
| `ML_*`, `MODEL_ARTIFACT_DIR` | no | Training configuration / local model cache |
| `OSRM_BASE_URL`, `OSRM_TIMEOUT_SECONDS`, `ROUTE_AVG_SPEED_KMH` | no | Routing |
| `ALLOW_PUBLIC_REGISTRATION` | no (`true`) | Self-registration (always creates *viewer* accounts) |
| Frontend: `NEXT_PUBLIC_API_BASE` | yes | e.g. `http://localhost:8000/api/v1` |

## 3. Verify connectivity (read-only)

```bash
cd backend
./venv/bin/python -m scripts.check_db
```

The doctor never writes and never prints the password. It reports connectivity, the PostGIS version
(with a spatial round-trip), the migration revision against the code's head, row counts, RLS status,
data that would block the new constraints, geometry/lat-lng consistency, and a PostGIS cross-check
of the Gi\* neighbour counts. Exit code 0 means everything passed.

With the API running, `GET http://localhost:8000/health/db` returns the same summary (HTTP 503 if
the database is unreachable, PostGIS is missing, or migrations are behind).

Common errors:

| Symptom | Cause |
|---|---|
| `OperationalError` / timeout | project paused, wrong host, or IPv6-only direct host → use the Session pooler |
| `password authentication failed` | wrong password, or the user is not `postgres.<project-ref>` on the pooler |
| `Tenant or user not found` | wrong project ref in the pooler user name |
| startup log: "schema is at … but code expects …" | run migrations (§4) |

## 4. Back up, then migrate

### 4.1 Backup (always, before any migration)
Install PostgreSQL client tools with a major version ≥ the server's (`SHOW server_version;` in the SQL editor).
On macOS: `brew install libpq` and add its `bin` directory to your `PATH`.

```bash
# Full logical backup of the public schema (data + schema), custom format
pg_dump "postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres" \
  --schema=public --no-owner --no-privileges --format=custom \
  --file="wco_backup_$(date +%Y%m%d_%H%M).dump"

# Secondary, human-readable copy of the training data
cd backend && ./venv/bin/python -m scripts.export_csv --out "data/wco_backup_$(date +%Y%m%d).csv"
```

Keep the dump outside the repository. Do not rely on platform backups on the free plan.

Restore into an **empty** project if you ever need to:
`pg_restore --no-owner --no-privileges --dbname "<new-project-url>" wco_backup_….dump`
(enable PostGIS on the new project first).

### 4.2 Apply migrations
```bash
cd backend
./venv/bin/alembic current                 # where the database is now
./venv/bin/alembic upgrade head --sql | less   # preview the SQL without running it
./venv/bin/alembic upgrade head            # apply (transactional on PostgreSQL)
./venv/bin/python -m scripts.check_db      # confirm
```

The new migration `b7c8d9e0f1a2` is **additive**. It creates two tables (with RLS), adds
`data_source`/`updated_at` columns (existing rows get `unspecified`), and adds a unique constraint and
CHECK constraints. It **does not modify, delete or reseed** existing rows. If existing data would
violate a new constraint (e.g. a duplicate establishment-week), it aborts, changes nothing, and prints
SQL to inspect the offending rows. Resolve those manually after the backup, then re-run.

Rollback, if needed: `./venv/bin/alembic downgrade f2b3c4d5e6a7`. This drops the two new tables (and
any trained model versions stored in them) and the `data_source`/`updated_at` columns, so take a
backup first.

### 4.3 Label the existing synthetic data
Existing rows are `unspecified` after the migration. If they are the synthetic demo dataset:

```bash
./venv/bin/python -m scripts.label_data_source --source synthetic           # dry run
./venv/bin/python -m scripts.label_data_source --source synthetic --commit  # apply
```

Only `unspecified` rows are changed; quantities are untouched; one audit-log entry is written.

## 5. Loading demonstration data (new or empty project)

```bash
cd backend
./venv/bin/python -m scripts.create_admin --email <your-email> --name "<Your Name>"  # hidden password prompt
./venv/bin/python -m scripts.load_demo_data                # dry run: shows what would be inserted
./venv/bin/python -m scripts.load_demo_data --commit       # inserts missing rows only
```

The loader is additive: it never updates or deletes, skips establishments whose `wco_code` exists,
skips existing weeks, and labels everything synthetic. Use `--extend-existing` to continue existing
series weekly up to the last completed week, so forecasts point into the future rather than the past.
Details and assumptions: [ML_TRAINING_AND_EVALUATION.md](ML_TRAINING_AND_EVALUATION.md#synthetic-data).

The old `scripts/seed.py` and `scripts/import_real_establishments.py` **wipe tables**. They now refuse
to run without `--i-understand-this-deletes-data` plus typing the database host. Don't use them on the
real project.

## 6. Roles, RLS and access

- **RLS** is enabled on every application table (migrations `e1f2a3b4c5d6`, `f2b3c4d5e6a7`,
  `b7c8d9e0f1a2`) with **no policies**, so Supabase's auto-generated REST/GraphQL API returns nothing to
  the `anon` and `authenticated` roles. Keep it that way; the frontend talks only to FastAPI.
  Don't put the Supabase anon key or service-role key in the frontend.
- The FastAPI backend connects as `postgres` (the table owner) and therefore **bypasses RLS**.
  Authorization is enforced in the API (admin / researcher / viewer).
- Recommended hardening (optional; test on a copy first): create a least-privilege login role for the app:
  ```sql
  CREATE ROLE wco_app LOGIN PASSWORD '<strong-password>';
  GRANT USAGE ON SCHEMA public TO wco_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wco_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wco_app;
  -- RLS applies to non-owner roles, so give wco_app (and only wco_app) a permissive policy per table:
  DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys' LOOP
      EXECUTE format('CREATE POLICY wco_app_all ON public.%I FOR ALL TO wco_app USING (true) WITH CHECK (true)', t);
    END LOOP; END $$;
  ```
  Keep running migrations as `postgres`. New tables created by later migrations will need the same
  grant and policy. If the app role has no policy, RLS silently returns zero rows to it.

## 7. Running the PostGIS integration tests (optional, throwaway database only)

```bash
TEST_DATABASE_URL="postgresql+psycopg://…throwaway…" ./venv/bin/python -m pytest tests/test_postgres_integration.py
```

They run migrations, insert test rows, and check PostGIS distances, CHECK constraints, RLS and
the advisory lock. They refuse to run if the target already has establishments or WCO records.
**Never point them at the production project.**
