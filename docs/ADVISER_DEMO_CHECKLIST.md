# Adviser Recheck — Demo Checklist (Monday, 23 November 2026)

Use this as a run sheet. Steps marked **(check)** have an expected result; if it differs, use the
fallback listed for that step.

## A. The day before (≈ 45 minutes)

1. **Code:** `git checkout audit/recheck-fixes-2026-11` (or `main` after merging).
2. **Backend environment:** `cd backend && ./venv/bin/pip install -r requirements-dev.txt`, then create
   `backend/.env` from `.env.example`: Session-pooler `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`,
   `DEFAULT_DATA_SOURCE=synthetic`. Optionally `RETRAIN_DEBOUNCE_SECONDS=10` so retraining starts sooner live.
3. **New Supabase project initialised** (SUPABASE_SETUP.md §2–6): PostGIS enabled → `alembic upgrade head`
   → `python -m scripts.check_db` (**check:** "schema at head", PostGIS version, RLS ok) → `create_admin`
   → `load_demo_data --commit` (120 establishments × 52 weeks ending last week).
4. **First model (check):** `./venv/bin/python -m scripts.retrain_worker --once` → the Admin panel shows an
   active `lstm-…` version with held-out metrics.
5. **Tests (check):** `./venv/bin/python -m pytest` → 191 passed. Optionally also against Supabase
   (SUPABASE_SETUP.md §8).
6. **Vercel (if presenting the deployed site):** deployed per DEPLOYMENT_VERCEL.md §7; **check**
   `https://<project>.vercel.app/api/v1/health/db` → `"ready": true`.
7. **Dry run the whole script below once**, including step 6, with the worker running.

## B. Start-up on the day

Keep the **retraining worker** running for the whole demo. It's what makes retraining automatic on the
deployed site:
```bash
cd backend && ./venv/bin/python -m scripts.retrain_worker      # leave this terminal open
```
Then open the deployed site, or run locally:
```bash
cd backend && ./venv/bin/uvicorn app.main:app --port 8000       # local alternative
cd frontend && npm run dev                                       # with NEXT_PUBLIC_API_BASE=http://localhost:8000/api/v1
```
**(check)** Admin → LSTM panel says **"Retraining worker: online"** (only shown in worker mode, e.g. on Vercel).
Shortly before the meeting, run `load_demo_data --extend-existing --commit` if a week has passed since loading.

## C. Demonstration script (≈ 15 minutes)

| # | Do | Expected | Say |
|---|---|---|---|
| 1 | Open <http://localhost:3000>, sign in with your admin account | The sign-in box shows no example passwords | "Public registration can only create read-only viewer accounts; admins assign roles." |
| 2 | **Dashboard** | Amber notice: "100 % of WCO records are SYNTHETIC". KPI cards, weekly trend, 3-month aggregate forecast, model version | "All quantities are generated for demonstration and labelled synthetic in the database." |
| 3 | **Admin → LSTM Forecast Model** | Active model version, trained time, *data through* date; two tables: 1-week-ahead and 13-week backtest vs. naive, seasonal-naive, moving average | "Metrics are on held-out *future* weeks with a chronological split; the scaler is fitted on training weeks only. The LSTM beats every baseline, but on synthetic data this validates the pipeline, not real-world accuracy." |
| 4 | **Establishments** → pick one → **WCO Records** → add the next week's record. The start date is pre-filled with the next date in that series (same weekday as existing records; the archived data uses Wednesdays). Keep it, enter liters, Save | Toast "WCO record added", then a blue badge: "Forecast model retraining scheduled (1 change queued)" | "The change is committed first; only then is retraining scheduled." |
| 5 | Within the debounce window, edit another record's liters and delete one record | Badge shows 2–3 changes queued, still one job | "Rapid edits are coalesced into one batch retraining job." |
| 6 | Switch to **Admin → LSTM** (or watch the badge) | Status goes *Retraining scheduled* → *Training in progress…* → *Training complete — lstm-…-jN activated* (≈ debounce + 5 s poll + 10–20 s training). Recent jobs show trigger `automatic`, change count, finished time | "This is automatic **batch** retraining. The web app queues the job durably in PostgreSQL; a separate worker process retrains the model from scratch and activates it. It is not online learning. A failed run is retried and never replaces the working model." |
| 7 | **Map** → click an establishment marker | Forecast chart; caption "Recursive 13-week forecast from the week of … · model lstm-…-jN" | "Forecasts now come from the new version; the 13 weeks are produced recursively." |
| 8 | Try to add a duplicate week, or a negative quantity | Error message, no badge | "Duplicates and invalid values are rejected by the API and by database constraints." |
| 9 | Map → hotspots / heat map | Gi\* colours, KDE overlay | "Gi\* includes each site in its own neighbourhood. We chose the distance band with a sensitivity analysis; global Moran's I shows weak clustering at short range, but no establishment-level hot spot is significant after FDR correction. The colours are relative z-scores; KDE shows concentration, not significance." (ML doc §9) |
| 10 | **Routes** → select 6–10 establishments → Compute | Ordered stops, road geometry, "nearest-neighbour heuristic … not guaranteed optimal" | "Distances come from OSRM road routing; if OSRM fails we fall back to straight-line distances and the page says so." |
| 11 | (Optional) Sign in as a viewer account | No edit buttons; route history not saved | Role-based access is enforced by the API, not only hidden in the UI. |

## D. Fallbacks

| Problem | What to do |
|---|---|
| Supabase unreachable | `/api/v1/health/db` shows the cause. Check the pooler URL and that the project isn't paused. Keep screenshots of steps 2–7 as a backup. |
| Badge stays at "retraining scheduled" | The worker isn't running: start `python -m scripts.retrain_worker`. The queued job runs immediately. |
| Training slow | Normal on a laptop is 10–20 s for 6,240 records. The status panel shows progress; the old model keeps serving meanwhile. |
| Training failed | The panel shows the error and that the previous model is still active, which is the intended rollback behaviour. Common cause: too little history (< ~35 weeks). |
| Forecast says it needs records "spanning at least 12 weeks" or "in at least 8 of the last 12 weeks" | That establishment is too new or has more than 4 missing weeks recently; pick another or add the missing weeks. Up to 4 missing weeks are filled in automatically (shown as a warning). |
| Forecast warning "may already be in the past" | Data end long ago; run `load_demo_data --extend-existing --commit` beforehand. |
| OSRM down | The route still computes with straight-line distances and a warning. |
| Port in use | `--port 8001` and update `NEXT_PUBLIC_API_BASE`. |

## E. Likely questions

- **"Is the model learning continuously?"** No. It is automatically *retrained in batch* when data change; weights are never updated incrementally.
- **"How do you know it is accurate?"** Held-out chronological test weeks, a 13-week rolling-origin backtest, and comparison with naive baselines (ML doc §5). Synthetic data cannot establish real-world accuracy; the system is ready for observed data.
- **"Why is R² so high?"** Most variance is between establishments (10–130 L). Naive also scores ≈ 0.96, which is why we compare MAE against baselines.
- **"What if two people edit at once?"** One pending job; atomic claim; advisory lock; unique (establishment, week) constraint.
- **"What happens after a restart?"** Pending jobs stay in the database; an interrupted job is marked failed and re-queued; the active model is loaded from the database.
- **"Why a separate worker?"** The website runs as serverless functions that stop after each response and can't include PyTorch. Training is long-running work, so a persistent worker does it while the site queues and reports it.
- **"Are these real businesses?"** Locations are approximate placements near landmarks; quantities are synthetic; consent is recorded as *not given*. No business data or participation is claimed.

## F. Manual UI checks still to do (not automated in the audit)

Automated headless-Chrome runs (via `vercel dev`) covered login, map forecast, dashboard, admin panel,
record entry → retraining badge → worker → new model, route planning, and viewer restrictions. Still
confirm on the **deployed** site during the dry run:

- every page loads without console errors
- the admin LSTM panel updates while training
- the badge appears in the WCO Records dialog
- map popups show the forecast caption
- route warnings render
- a viewer cannot see edit/delete controls
