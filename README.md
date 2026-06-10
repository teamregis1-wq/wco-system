# WCO Predictive Mapping System — Starter Scaffold

AI-enabled predictive mapping for waste cooking oil (WCO) generation and biodiesel
production modeling in Lipa City, Batangas.

This is a **working starter scaffold**, not the finished system. It boots, authenticates,
serves an interactive map of seeded establishments with hotspot coloring, and has a
forecast endpoint ready to load your trained LSTM. Your job over the next ~14 weeks is
to flesh out each module. The hard parts (real KDE/Gi*, OSMnx routing, the trained model)
are marked with `TODO` in the code.

---

## What's in the box

```
wco-system/
├── backend/                  FastAPI + SQLAlchemy + PostGIS
│   ├── app/
│   │   ├── core/             config, database, security (JWT, bcrypt)
│   │   ├── models/           all 12 database tables
│   │   ├── routers/          auth, establishments, forecast, gis, analysis
│   │   ├── schemas/          Pydantic request/response shapes
│   │   ├── services/         forecasting (loads your trained LSTM)
│   │   ├── seed.py           generates 120 establishments + 52 weeks of data
│   │   └── main.py           app entry point
│   ├── alembic/              database migrations
│   ├── requirements.txt
│   └── .env.example
├── frontend/                 Next.js 14 + React-Leaflet + Recharts
│   ├── app/                  pages (login + mapping)
│   ├── components/           WCOMap, ForecastChart
│   ├── lib/api.ts            typed API client
│   └── .env.local.example
└── notebooks/
    └── lstm_training.ipynb   train the LSTM in Google Colab, export weights
```

---

## Prerequisites (macOS)

Install these once. If you have Homebrew, the first block covers everything.

```bash
# Homebrew (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install python@3.11 node git
# GDAL/GEOS/PROJ — needed later for OSMnx (routing) and geospatial libs.
# Installing now saves pain during the GIS sprint.
brew install gdal geos proj spatialindex
```

You also need a free **Supabase** account (supabase.com) for the PostgreSQL + PostGIS
database. Everything else runs locally.

---

## Setup — do these in order

### 1. Create the Supabase database

1. Create a new project at supabase.com (free tier is fine).
2. In the project's SQL Editor, run:
   ```sql
   create extension if not exists postgis;
   ```
3. Go to Project Settings → Database → Connection string → **URI**. Copy it.
   It looks like `postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres`.

### 2. Backend

```bash
cd backend
python3.11 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

cp .env.example .env
```

Now edit `.env`:
- Set `DATABASE_URL` to your Supabase URI, but **change the scheme** from
  `postgresql://` to `postgresql+psycopg://` so SQLAlchemy uses the psycopg 3 driver.
- Generate a real `JWT_SECRET`:
  ```bash
  python -c "import secrets; print(secrets.token_hex(32))"
  ```

Create the database tables and seed them:

```bash
# Generate the first migration from the models, then apply it
alembic revision --autogenerate -m "initial schema"
alembic upgrade head

# Fill the database with 120 establishments + ~6,240 WCO records
python -m app.seed
```

Start the API:

```bash
uvicorn app.main:app --reload
```

Open **http://localhost:8000/docs** — you should see interactive API docs.
Hit `/health` first to confirm it's alive. Then try `POST /api/v1/auth/login`
with `admin@wco.local` / `admin12345`.

### 3. Frontend

In a **new terminal** (leave the backend running):

```bash
cd frontend
npm install
cp .env.local.example .env.local   # default points at localhost:8000
npm run dev
```

Open **http://localhost:3000**. Log in with `admin@wco.local` / `admin12345`.
You'll see the Lipa City map with color-coded hotspots from your seeded data.

### 4. Train the LSTM (when you're ready — forecasting sprint)

1. Export the seeded data to CSV (run in `backend/` with the venv active):
   ```bash
   python -c "
   from app.core.database import SessionLocal
   from app.models.wco import WCOGenerationRecord
   from sqlalchemy import select
   import pandas as pd
   db = SessionLocal()
   rows = db.scalars(select(WCOGenerationRecord)).all()
   pd.DataFrame([{'establishment_id': r.establishment_id, 'week_date': r.week_date, 'quantity_liters': r.quantity_liters} for r in rows]).to_csv('wco_export.csv', index=False)
   print('wrote wco_export.csv')
   "
   ```
2. Open `notebooks/lstm_training.ipynb` in Google Colab (File → Upload notebook).
3. Set the runtime to GPU (Runtime → Change runtime type → GPU).
4. Run all cells, upload `wco_export.csv` when prompted.
5. Download `lstm_wco.pt` and `scaler.npz`, drop them into
   `backend/app/services/model_artifacts/`.
6. Restart the backend. The forecast dropdown on the map page now works.

> The model class in the notebook and in `app/services/forecasting.py` must stay
> identical. If you change `HIDDEN_SIZE` etc. in one, change it in both.

---

## The build plan (your ~14 weeks)

| Weeks | Focus | What to build |
|------|-------|---------------|
| 1–2 | Foundation | This scaffold running; learn FastAPI + Next.js against the real schema |
| 3–4 | Data + biodiesel | Establishment/WCO data entry UI, CSV import, biodiesel dashboard (easy, pulled forward) |
| 5–6 | Forecasting | Train LSTM in Colab (runs in background while you build UI) |
| 7–9 | GIS + hotspots | Real KDE (scipy) + Local Gi* (PySAL); upgrade `gis.py` |
| 10–11 | Routing | OSMnx road import + NetworkX Dijkstra; fill in `analysis.py` route stub |
| 12 | Integration | Wire forecast → hotspot → route flow; reporting/export |
| 13–14 | Deploy + defense | Ship, screenshots, demo script, dry runs |

**Safety valve:** the project plan's own risk register allows an ARIMA fallback if the
LSTM underperforms. A working simple model beats a broken sophisticated one at a defense.
The `ForecastRun.model_type` column already supports `'arima'`.

---

## Deployment (week 13)

- **Frontend → Vercel.** Connect the GitHub repo, set `NEXT_PUBLIC_API_BASE` env var to
  your backend URL. Auto-deploys on push.
- **Backend → Railway or Render** (NOT Vercel). Vercel's serverless functions time out
  and choke on PyTorch/OSMnx/SciPy. Railway/Render run a persistent container with no
  timeout. Add a `Procfile` with:
  `web: uvicorn app.main:app --host 0.0.0.0 --port $PORT`
  and set your env vars (`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS` = your Vercel URL).
- **Database → Supabase** stays as-is (it's already managed and cloud-hosted).

---

## Common gotchas

- **`alembic upgrade` fails with "type geometry does not exist"** → you forgot to run
  `create extension postgis;` in Supabase (step 1.2).
- **Login works in /docs but frontend login fails** → CORS. Make sure
  `CORS_ORIGINS=http://localhost:3000` is in the backend `.env`.
- **Map is blank** → check the browser console; usually the backend isn't running or
  `NEXT_PUBLIC_API_BASE` is wrong in `.env.local`.
- **Forecast returns 503** → expected until you add the trained model files (step 4).
- **OSMnx install errors during the GIS sprint** → that's why we `brew install gdal geos proj`
  up front. If it still fails, `pip install osmnx` after `brew install` usually resolves it.

---

## Default credentials (development only)

| Email | Password | Role |
|-------|----------|------|
| admin@wco.local | admin12345 | admin |
| researcher@wco.local | research12345 | researcher |

Change these before any public deployment.
