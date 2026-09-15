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

Then open <http://localhost:3000>. Development sign-in: `admin@wco.local` / `admin12345`.

API documentation is served at <http://localhost:8000/docs>.

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
│   │   ├── services/              forecasting (LSTM training and inference)
│   │   │   └── model_artifacts/   trained weights + scaler
│   │   └── main.py                app entry point, middleware, router registration
│   ├── alembic/versions/          database migrations, applied in order
│   ├── data/                      seed and export CSVs
│   ├── scripts/                   one-off operational scripts (not imported by the app)
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
└── notebooks/                   LSTM training exploration
```

**Where to change things**

| To change… | Edit |
|---|---|
| An API endpoint | `backend/app/routers/<resource>.py` |
| A database table | `backend/app/models/` + a new Alembic migration |
| Request validation | `backend/app/schemas/schemas.py` |
| Hotspot / KDE maths | `backend/app/routers/gis.py` |
| Forecasting model | `backend/app/services/forecasting.py` |
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

Create `backend/.env` (never committed):

```
DATABASE_URL=postgresql+psycopg://<user>:<password>@<host>:5432/postgres
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
```

> Use Supabase's **Session pooler** connection string, not the direct one. The direct
> host is IPv6-only and fails on networks without IPv6. With the pooler the user is
> `postgres.<project-ref>`, and the scheme must be `postgresql+psycopg://` — plain
> `postgresql://` looks for the psycopg2 driver, which is not installed.
> Percent-encode any special characters in the password (e.g. `@` → `%40`).

Then create the schema and load data:

```bash
./venv/bin/python -c "from sqlalchemy import create_engine, text; \
  from dotenv import dotenv_values; \
  create_engine(dotenv_values('.env')['DATABASE_URL']).connect().execute(text('CREATE EXTENSION IF NOT EXISTS postgis'))"
./venv/bin/alembic upgrade head
./venv/bin/python -m scripts.import_real_establishments   # see "Seeding" below
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local     # then set NEXT_PUBLIC_API_BASE
```

---

## Seeding

Two scripts populate the database. **They are not interchangeable:**

| Script | Coordinates | Use for |
|---|---|---|
| `scripts/import_real_establishments.py` | **Real, verified** locations of actual Batangas City establishments | Demos, presentations, anything shown to others |
| `scripts/seed.py` | Randomly scattered around a centre point — some land in the bay | Throwaway local testing only |

```bash
cd backend
./venv/bin/python -m scripts.import_real_establishments
```

Both wipe and regenerate the data tables, so never run either against production data.
`import_real_establishments.py` also creates the development accounts
(`admin@wco.local`, `researcher@wco.local`) if they don't already exist, and leaves
existing user accounts untouched.

---

## Common tasks

```bash
cd backend

# apply new migrations
./venv/bin/alembic upgrade head

# create a migration after changing a model
./venv/bin/alembic revision --autogenerate -m "describe the change"

# export all WCO records to data/wco_export.csv
./venv/bin/python -m scripts.export_csv
```

Retrain the forecasting model from the running app: **Dashboard → Train Model**, or
`POST /api/v1/forecast/train`. Training writes to `app/services/model_artifacts/`
and records MAE, RMSE, R², and MAPE.

---

## Deployment

- **Frontend** deploys to Vercel from `main`. Root Directory must be set to `frontend`
  in project settings, and `NEXT_PUBLIC_API_BASE` set in environment variables.
- **Backend** has a `Procfile` ready for Railway or Render. Set `DATABASE_URL` and add
  the deployed frontend's origin to `CORS_ORIGINS`.

---

## Notes

- `backend/.env` and `frontend/.env.local` hold credentials and are gitignored. Never commit them.
- Row Level Security is enabled on all application tables via migration. The app connects
  as the table owner and bypasses it; RLS only blocks Supabase's auto-generated REST API.
- Roles are `admin` (full access), `researcher` (read and edit), and `viewer` (read only).
