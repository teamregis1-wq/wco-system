# Adviser Recheck — Demo Checklist (Monday, 23 November 2026)

Use this as a run sheet. Steps marked **(check)** have an expected result; if it differs, use the
fallback listed for that step.

## A. The day before (≈ 45 minutes)

1. **Get the code**
   ```bash
   cd wco-system && git fetch && git checkout audit/recheck-fixes-2026-11
   ```
2. **Backend environment** (Python 3.11)
   ```bash
   cd backend
   python3.11 -m venv venv              # skip if venv exists
   ./venv/bin/pip install -r requirements-dev.txt
   cp .env.example .env                 # then fill DATABASE_URL, JWT_SECRET, CORS_ORIGINS
   ```
   For the demo also set `DEFAULT_DATA_SOURCE=synthetic`. Optionally set `RETRAIN_DEBOUNCE_SECONDS=10`
   so automatic retraining starts sooner while you present.
3. **Supabase is reachable** **(check)**: `./venv/bin/python -m scripts.check_db` connects and shows PostGIS.
   If the project is paused → SUPABASE_SETUP.md §1.
4. **Back up** (SUPABASE_SETUP.md §4.1): `pg_dump …` and `python -m scripts.export_csv --out data/wco_backup_YYYYMMDD.csv`.
5. **Migrate** **(check)**: `./venv/bin/alembic upgrade head`, then re-run `check_db`; it should show "schema at head".
6. **Rotate the old dev passwords / create your admin**:
   `./venv/bin/python -m scripts.create_admin --email <you>` (hidden password prompt).
7. **Data**
   - Existing synthetic rows: `./venv/bin/python -m scripts.label_data_source --source synthetic --commit`
   - Bring series up to last week, so forecasts point into the future:
     `./venv/bin/python -m scripts.load_demo_data --extend-existing` (dry run) → add `--commit`
   - Empty database instead: `./venv/bin/python -m scripts.load_demo_data --commit`
8. **Tests** **(check)**: `./venv/bin/python -m pytest` should report 173 passed, 4 skipped.
9. **Frontend**: `cd ../frontend && npm ci && cp .env.local.example .env.local` (set `NEXT_PUBLIC_API_BASE`), then `npm run build`.
10. **Dry run the whole script below once.** Train one model in advance (Admin → Retrain now) so a
    validated model is active before the meeting.

## B. Start-up on the day

```bash
# Terminal 1
cd backend && ./venv/bin/uvicorn app.main:app --port 8000      # single worker
# Terminal 2
cd frontend && npm run dev                                      # http://localhost:3000
```
**(check)** <http://localhost:8000/health/db> shows `"ready": true` and a PostGIS version.

## C. Demonstration script (≈ 15 minutes)

| # | Do | Expected | Say |
|---|---|---|---|
| 1 | Open <http://localhost:3000>, sign in with your admin account | The sign-in box shows no example passwords | "Public registration can only create read-only viewer accounts; admins assign roles." |
| 2 | **Dashboard** | Amber notice: "100 % of WCO records are SYNTHETIC". KPI cards, weekly trend, 3-month aggregate forecast, model version | "All quantities are generated for demonstration and labelled synthetic in the database." |
| 3 | **Admin → LSTM Forecast Model** | Active model version, trained time, *data through* date; two tables: 1-week-ahead and 13-week backtest vs. naive, seasonal-naive, moving average | "Metrics are on held-out *future* weeks with a chronological split; the scaler is fitted on training weeks only. The LSTM beats every baseline, but on synthetic data this validates the pipeline, not real-world accuracy." |
| 4 | **Establishments** → pick one → **WCO Records** → add the next week's record. The start date is pre-filled with the next date in that series (same weekday as existing records; the archived data uses Wednesdays). Keep it, enter liters, Save | Toast "WCO record added", then a blue badge: "Forecast model retraining scheduled (1 change queued)" | "The change is committed first; only then is retraining scheduled." |
| 5 | Within the debounce window, edit another record's liters and delete one record | Badge shows 2–3 changes queued, still one job | "Rapid edits are coalesced into one batch retraining job." |
| 6 | Switch to **Admin → LSTM** (or watch the badge) | Status goes *Retraining scheduled* → *Training in progress…* → *Training complete — lstm-…-jN activated*. Recent jobs table shows trigger `automatic`, change count, finished time | "This is automatic **batch** retraining: the model is retrained from scratch on the full dataset. It is not online learning. A failed run never replaces the working model." |
| 7 | **Map** → click an establishment marker | Forecast chart; caption "Recursive 13-week forecast from the week of … · model lstm-…-jN" | "Forecasts now come from the new version; the 13 weeks are produced recursively." |
| 8 | Try to add a duplicate week, or a negative quantity | Error message, no badge | "Duplicates and invalid values are rejected by the API and by database constraints." |
| 9 | Map → hotspots / heat map | Gi\* colours, KDE overlay | "Gi\* includes each site in its own neighbourhood; we report FDR-adjusted significance. On this synthetic data no hotspot is significant after correction — expected, because the generator has no spatial clustering." (ML doc §9) |
| 10 | **Routes** → select 6–10 establishments → Compute | Ordered stops, road geometry, "nearest-neighbour heuristic … not guaranteed optimal" | "Distances come from OSRM road routing; if OSRM fails we fall back to straight-line distances and the page says so." |
| 11 | (Optional) Sign in as a viewer account | No edit buttons; route history not saved | Role-based access is enforced by the API, not only hidden in the UI. |

## D. Fallbacks

| Problem | What to do |
|---|---|
| Supabase unreachable / paused | Restore it in the dashboard (SUPABASE_SETUP.md §1). `/health/db` shows the cause. Have screenshots of steps 2–7 as a backup. |
| Training slow | Normal on a laptop is 10–20 s for 6,240 records. The status panel shows progress; the old model keeps serving meanwhile. |
| Training failed | The panel shows the error and that the previous model is still active, which is the intended rollback behaviour. Common cause: too little history (< ~35 weeks). |
| Forecast says "needs 12 consecutive weekly records" | That establishment has a gap of > 2 weeks or too little data; pick another or fill the gap. |
| Forecast warning "may already be in the past" | Data end long ago; run `load_demo_data --extend-existing --commit` beforehand. |
| OSRM down | The route still computes with straight-line distances and a warning. |
| Port in use | `--port 8001` and update `NEXT_PUBLIC_API_BASE`. |

## E. Likely questions

- **"Is the model learning continuously?"** No. It is automatically *retrained in batch* when data change; weights are never updated incrementally.
- **"How do you know it is accurate?"** Held-out chronological test weeks, a 13-week rolling-origin backtest, and comparison with naive baselines (ML doc §5). Synthetic data cannot establish real-world accuracy; the system is ready for observed data.
- **"Why is R² so high?"** Most variance is between establishments (10–130 L). Naive also scores ≈ 0.96, which is why we compare MAE against baselines.
- **"What if two people edit at once?"** One pending job; atomic claim; advisory lock; unique (establishment, week) constraint.
- **"What happens after a restart?"** Pending jobs are re-armed; an interrupted job is marked failed; the active model is loaded from the database.
- **"Are these real businesses?"** Locations are approximate placements near landmarks; quantities are synthetic; consent is recorded as *not given*. No business data or participation is claimed.

## F. Manual UI checks still to do (not automated in the audit)

The audit verified the production build, types, API contract and a live HTTP run, but **not** the pages in
a browser. During the dry run, confirm:

- every page loads without console errors
- the admin LSTM panel updates while training
- the badge appears in the WCO Records dialog
- map popups show the forecast caption
- route warnings render
- a viewer cannot see edit/delete controls
