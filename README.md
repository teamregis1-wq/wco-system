# WCO Atlas

Waste Cooking Oil Predictive Mapping System for **Batangas City** — spatial hotspot
analysis, three-month generation forecasting, and road-accurate collection routing.

A private system: every page requires an account.

---

## Quick start

Two terminals. The backend must be running before the frontend can load data.

```bash
# Terminal 1 — backend  (http://localhost:8000)
cd backend
./venv/bin/uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend (http://localhost:3000)
cd frontend
npm run dev
```

Then open <http://localhost:3000> and sign in with an account created by
`python -m scripts.create_admin` (see below). No credentials are published in this repository.

API documentation is served at <http://localhost:8000/docs>; readiness (database, PostGIS,
migrations) at <http://localhost:8000/health/db>.

**Documentation:** [System audit](docs/SYSTEM_AUDIT.md) ·
[Supabase setup & backups](docs/SUPABASE_SETUP.md) ·
[ML training & evaluation](docs/ML_TRAINING_AND_EVALUATION.md) ·
[Adviser demo checklist](docs/ADVISER_DEMO_CHECKLIST.md)

---

## Repository layout

```
wco-system/
├── backend/                     FastAPI · SQLAlchemy · PostGIS
│   ├── app/                       application code only
│   │   ├── core/                  config, database engine, security, cache, audit
│   │   ├── models/                SQLAlchemy tables
│   │   ├── routers/               HTTP endpoints, one file per resource
│   │   ├── schemas/               Pydantic request/response shapes + validation
│   │   ├── services/              training.py (pipeline) · retraining.py (automatic jobs)
│   │   │   │                      model_store.py (versioned models) · forecasting.py (inference)
│   │   │   └── model_artifacts/   bundled pre-audit model + local cache of trained versions
│   │   └── main.py                app entry point, middleware, router registration
│   ├── alembic/versions/          database migrations, applied in order
│   ├── data/                      demo establishment catalog, archived export CSV
│   ├── scripts/                   operational scripts (check_db, load_demo_data, create_admin, …)
│   ├── tests/                     pytest suite (SQLite; PostGIS tests opt-in)
│   └── requirements.txt
│
├── frontend/                    Next.js 14 (App Router) · TypeScript · Leaflet
│   ├── app/                       one folder per page/route
│   │   ├── page.tsx               landing page (public)
│   │   ├── map/                   hotspot map + KDE heatmap
│   │   ├── dashboard/             city-wide analytics
│   │   ├── establishments/        registry, WCO records, CSV import/export
│   │   ├── routes/                collection route planner
│   │   └── admin/                 user management, audit log
│   ├── components/                shared UI (map, charts, navbar, auth popover)
│   └── lib/                       auth context, CSV parsing/validation, fonts
│
├── docs/                        audit, Supabase, ML, demo checklist
└── notebooks/                   LSTM training exploration (mirrors the backend method)
```

**Where to change things**

| To change… | Edit |
|---|---|
| An API endpoint | `backend/app/routers/<resource>.py` |
| A database table | `backend/app/models/` + a new Alembic migration |
| Request validation | `backend/app/schemas/schemas.py` |
| Hotspot / KDE maths | `backend/app/routers/gis.py` |
| Forecasting model / training | `backend/app/services/training.py` (+ `forecasting.py` for inference) |
| Automatic retraining | `backend/app/services/retraining.py` |
| Route optimisation | `backend/app/routers/analysis.py` |
| A page's UI | `frontend/app/<page>/page.tsx` |
| The map | `frontend/components/WCOMap.tsx` |
| CSV import rules | `frontend/lib/csv.ts` |

---

## Setup from scratch

### Backend

```bash
cd backend
python3.11 -m venv venv
./venv/bin/pip install -r requirements.txt
```

Create `backend/.env` from the template (never committed):

```bash
cp .env.example .env     # set DATABASE_URL, JWT_SECRET (required), CORS_ORIGINS
```

> Use Supabase's **Session pooler** connection string (port 5432), not the direct one (IPv6-only)
> and not the Transaction pooler. `postgresql://` URLs are accepted and rewritten to the
> Psycopg 3 driver. Percent-encode special characters in the password (e.g. `@` → `%40`).
> `JWT_SECRET` is mandatory: `python -c "import secrets; print(secrets.token_hex(32))"`.
> Full guide: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

Then check the database, create the schema, an admin account, and demo data:

```bash
./venv/bin/python -m scripts.check_db          # read-only: connectivity, PostGIS, migrations
./venv/bin/alembic upgrade head                # back up first if the database has data
./venv/bin/python -m scripts.create_admin --email you@example.com --name "Your Name"
./venv/bin/python -m scripts.load_demo_data    # dry run; add --commit to insert
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local     # then set NEXT_PUBLIC_API_BASE
```

---

## Demo data (synthetic)

All WCO quantities shipped with this project are **synthetic** (generated), and are labelled
`data_source = synthetic` in the database and on the dashboard. Establishment coordinates are
approximate placements near public landmarks, not surveyed locations. Assumptions and seeds:
[docs/ML_TRAINING_AND_EVALUATION.md §8](docs/ML_TRAINING_AND_EVALUATION.md#synthetic-data).

| Script | What it does | Safe on real data? |
|---|---|---|
| `scripts/load_demo_data.py` | Inserts missing establishments and weeks only; never updates or deletes; dry run unless `--commit`; `--extend-existing` continues series to last week | **Yes** |
| `scripts/label_data_source.py` | Labels `unspecified` rows as `synthetic`/`observed` (dry run unless `--commit`) | Yes |
| `scripts/seed.py`, `scripts/import_real_establishments.py` | Legacy: **wipe** data tables and regenerate. Refuse to run without `--i-understand-this-deletes-data` plus typing the DB host | **No** |

---

## Common tasks

```bash
cd backend

# apply new migrations
./venv/bin/alembic upgrade head

# create a migration after changing a model
./venv/bin/alembic revision --autogenerate -m "describe the change"

# export all WCO records to data/wco_export_<date>.csv (never overwrites the archived file)
./venv/bin/python -m scripts.export_csv
```

```bash
# run the test suite (no database or network needed)
./venv/bin/pip install -r requirements-dev.txt
./venv/bin/python -m pytest
```

**Forecast model.** Adding, importing, editing or deleting WCO records schedules **automatic
batch retraining** after the change is committed. Bursts of edits are coalesced
(`RETRAIN_DEBOUNCE_SECONDS`, default 20 s). Each run retrains from scratch with a chronological split,
evaluates on held-out weeks against naive baselines, stores the version in the database, and activates it
only if training succeeds. Manual retraining: **Admin → Retrain now**, or `POST /api/v1/forecast/train`.
Status: **Admin → LSTM Forecast Model** or `GET /api/v1/forecast/training-status`.
Details and limitations: [docs/ML_TRAINING_AND_EVALUATION.md](docs/ML_TRAINING_AND_EVALUATION.md).

---

## Deployment

- **Frontend** deploys to Vercel from `main`. Root Directory must be set to `frontend`
  in project settings, and `NEXT_PUBLIC_API_BASE` set in environment variables.
- **Backend** has a `Procfile` ready for Railway or Render (one worker). Set `DATABASE_URL`,
  **`JWT_SECRET` (required — the API will not start without it)**, and add the deployed
  frontend's origin to `CORS_ORIGINS`. Run `alembic upgrade head` against the database before
  deploying new code. Trained models are stored in the database, so they survive redeploys.

---

## Notes

- `backend/.env` and `frontend/.env.local` hold credentials and are gitignored. Never commit them.
- Row Level Security is enabled on all application tables via migration. The app connects
  as the table owner and bypasses it; RLS only blocks Supabase's auto-generated REST API.
- Roles are `admin` (full access), `researcher` (read and edit), and `viewer` (read only).
  Public self-registration always creates viewers; admins create other accounts.
