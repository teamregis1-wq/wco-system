# Forecasting Model: Training, Evaluation and Automatic Retraining

Implementation: `backend/app/services/training.py` (pipeline), `retraining.py` (jobs and scheduling),
`model_store.py` (persistence), `lstm_numpy.py` (inference), `forecasting.py` (forecast API),
`scripts/retrain_worker.py` (worker process). The Colab notebook mirrors the same method.

## 1. Model

| Item | Value |
|---|---|
| Architecture | LSTM, input size 1, 2 layers × 64 hidden units → Linear(64→1) |
| Input | the 12 most recent weekly quantities of **one** establishment, min–max scaled |
| Output | next week's quantity; 13 weeks are produced **recursively** (each prediction is fed back as input) |
| Loss / optimiser | MSE / Adam (lr 1e-3), batch 32, ≤ 80 epochs, early stopping (patience 8) on the validation period |
| Seed | 42 (Python, NumPy, PyTorch, DataLoader shuffling) — same data + seed → identical weights (tested) |
| Training / inference | trained with PyTorch (worker); served by a NumPy implementation of the same forward pass, which matches PyTorch to ~1e-7 (tested). Evaluation uses the NumPy path, so the reported numbers come from exactly the deployed code. Weights are stored as NPZ |
| Unit of all errors | **liters of WCO per establishment per week** (L/establishment-week) |

The 12-week input and 13-week horizon were kept unchanged.

## 2. Data preparation and validation

Before every training run the dataset is validated and the report is stored on the job (`data_report`):

- **Establishment-level separation:** each establishment is its own series. Training uses active establishments only.
- **Contiguity:** a series is split into runs of exactly 7-day steps. A **missing week**, an
  **irregular interval** (not a multiple of 7 days), or an **invalid value** (negative, non-finite,
  > 10,000 L) breaks the run. No input window spans a break.
- **Duplicates:** a series with two values for the same week is excluded (the database now prevents this).
- **Insufficient history:** an establishment whose longest run is < 13 weeks contributes no windows and is listed with the reason.
- A **dataset fingerprint** (SHA-256 of the exact training rows) is stored with each model version.

## 3. Chronological split (and why the old one was wrong)

Split points are **calendar weeks**, counted back from the latest record and shared by all establishments.
A window's *target week* decides its set:

```
 ...training targets...   | 6 validation weeks      | 16 test weeks (held out)  |
                          ^ early stopping only     ^ evaluation only           ^ latest week
```

- Inputs may reach back into earlier periods. That is history the model would have at forecast time.
- The **min–max scaler is fitted on training-period values only**.
- Validation weeks are used only to choose the stopping epoch; reported metrics use only the test weeks.

**Before the audit**, windows were ordered by establishment and split 80/20, so "validation" was
the *complete history of the last ~24 establishments*. The scaler was also fitted on all values
(the bundled `scaler.npz` min/max equal the global min/max of all 6,240 records). Those metrics
measured fit to unseen *establishments* with leaked scaling, not forecasting of *future weeks*.
Earlier reported scores (e.g. "R² ≈ 0.92") should not be cited as forecast accuracy.

## 4. Evaluation design

**One-step (1-week-ahead).** For each test week, the model gets the 12 *true* preceding weeks and
predicts that week. This measures single-step skill; errors cannot compound.

**Rolling-origin recursive backtest (13 weeks).** For every establishment and every *origin* week
whose next 13 weeks all lie in the test period, the model forecasts 13 weeks recursively from the 12
true weeks ending at the origin, feeding back its own predictions exactly as `/forecast` does
(the same function is used). With 16 test weeks there are 16 − 13 + 1 = **4 origins**. This measures what the
product delivers: a 3-month forecast with compounding error. Per-horizon errors (h = 1…13) and a
city-total aggregate (sum over establishments per week) are also reported. The model is trained once
(not re-fitted at each origin); origins move forward through held-out weeks only.

**Baselines** (same samples):

- naive: next week = last observed week
- seasonal naive: value 13 weeks earlier (matches the assumed quarterly cycle)
- 12-week moving average

A model is only useful if it beats these.

### Metric definitions and interpretation

| Metric | Unit | Meaning |
|---|---|---|
| MAE | L/establishment-week | average absolute error; "typically off by this many liters" |
| RMSE | L/establishment-week | like MAE but penalises large errors; RMSE ≥ MAE always |
| R² | unitless | share of the variance of held-out weekly values explained. Here it is **dominated by differences in level between establishments** (10–130 L), so even naive scores ≈ 0.96. **Do not read R² alone; compare it with the baselines.** |
| MAPE | % | mean absolute error relative to the actual value; computed over weeks with actual > 0 (undefined at 0) |

## 5. Results (measured 2026-11-19, seed 42, default configuration)

**A. Archived dataset** `backend/data/wco_export.csv` (120 synthetic series × 52 weeks, 2025-05-28 → 2026-05-20).
Windows: train 2,160 / validation 720 / test 1,920; stopped at epoch 28 (best 20); ~12 s on a laptop CPU.

| One-step, held-out test weeks | MAE (L) | RMSE (L) | R² | MAPE |
|---|---|---|---|---|
| **LSTM** | **2.73** | **3.54** | **0.983** | **5.6 %** |
| Seasonal naive (t−13) | 3.79 | 4.84 | 0.968 | 7.4 % |
| Naive (last week) | 4.15 | 5.40 | 0.960 | 8.5 % |
| 12-week moving average | 6.99 | 8.38 | 0.904 | 14.4 % |

| 13-week recursive backtest (4 origins, 480 forecasts, 6,240 points) | MAE (L) | RMSE (L) | R² | MAPE |
|---|---|---|---|---|
| **LSTM** | **3.01** | **3.86** | **0.980** | **5.8 %** |
| Seasonal naive (t−13) | 3.77 | 4.82 | 0.968 | 7.1 % |
| 12-week moving average | 6.38 | 7.77 | 0.917 | 12.4 % |
| Naive (last week) | 9.78 | 12.46 | 0.787 | 17.3 % |

- LSTM MAE by horizon stays between 2.74 L and 3.23 L (2.87 L at h=1, peak at h=5, 3.04 L at h=13). Naive peaks at 16.8 L (h=6),
  half a cycle away, and falls back to 3.8 L at h=13. That is the signature of the 13-week cycle.
- City-total weekly forecast: LSTM MAE 92.9 L/week (MAPE 1.3 %) vs naive 1,092.6 L/week (14.1 %).

**B. Demo dataset** produced by `scripts/load_demo_data.py` (same generator, ending 2026-11-09), from the
recorded live run: one-step MAE 2.69 L (R² 0.984, MAPE 5.5 %); 13-week backtest MAE 2.76 L vs
seasonal naive 3.73 L and naive 9.87 L.

### What these numbers do and do not show
- The synthetic generator is `base + trend·w + amp·sin(2πw/13) + Normal(0, (0.3·amp)²)`. Even a perfect
  model cannot predict the noise term. The expected MAE of the noise alone is ≈ 0.80·σ, or **≈ 2.3 L**
  averaged over the 60/40/20 type mix (σ = 2.4, 4.2, 1.8 L). The LSTM's 2.7 L means it has nearly
  recovered the generator's deterministic part.
- So the results show that **the pipeline, split and recursive forecasting work and beat simple
  baselines on data with a known pattern**. They do **not** show real-world accuracy for Batangas City:
  real WCO generation will be noisier, irregular and influenced by factors the generator lacks.
- Training successfully is not evidence of accuracy; only the held-out comparison is.

## 6. Inference rules

- The active model is loaded once per worker and swapped atomically when a new version is activated.
- An establishment needs **12 consecutive weekly records** (`ML_MIN_HISTORY_WEEKS`). Up to **2 missing
  weeks** inside the 12-week input are linearly interpolated *for the forecast only* and reported in
  `warnings`. Longer gaps, irregular intervals or duplicates → HTTP 422 with the exact reason. Training
  never uses interpolated values.
- The response includes `forecast_origin` (the last observed week). If data are stale, a warning says
  the "forecast" weeks may already be in the past.
- Aggregate forecast = sum of per-establishment forecasts by calendar week (batched). Skipped
  establishments are counted in the `X-Forecast-Skipped` header; `establishment_count` is given per week.
- Predictions are clipped at 0 L.

<a id="automatic-batch-retraining"></a>
## 7. Automatic batch retraining

**Terminology:** each run retrains the model *from scratch* on the full current dataset. This is
**automatic batch retraining**, not online/continual learning (weights are never updated incrementally).

**Who executes jobs (`RETRAIN_EXECUTOR`):**
- `worker` (deployed on Vercel; auto-detected there): the API only queues and coalesces jobs in
  PostgreSQL. A separate process, `python -m scripts.retrain_worker`, polls every 5 s, claims due jobs,
  trains, and activates models. Serverless functions are frozen after each response and the API bundle
  has no PyTorch, so training cannot run inside them reliably.
- `inprocess` (local development / one long-running server): the API process also executes jobs on an in-process timer.

Both modes use the same queue, claim, locks, retries and activation code. See
[DEPLOYMENT_VERCEL.md §5](DEPLOYMENT_VERCEL.md#5-the-retraining-worker) for hosting the worker.

```
WCO create / bulk import / edit / delete, establishment (de)activation
   │  (only after db.commit() succeeds; failed or rejected writes never trigger)
   ▼
upsert the single PENDING job  ── further changes within the debounce window
   │                              update the same row (change_count += 1)
   ▼ debounce elapsed (RETRAIN_DEBOUNCE_SECONDS, default 20 s since the LAST change)
claim: pending → TRAINING  (atomic UPDATE … WHERE status='pending';
   │                        process lock + PostgreSQL advisory lock)
   ▼
data validation → chronological split → train → held-out evaluation
   │
   ├─ success → store version (weights, scaler, metrics, fingerprint) in model_versions,
   │            deactivate old + activate new + mark job COMPLETED in ONE transaction
   │            → next forecast request in every worker loads the new version
   └─ failure → job FAILED with error + data report; previously active model untouched
```

- **Status:** `GET /api/v1/forecast/training-status` returns `status` (`idle | pending | training | completed | failed`),
  the active model (version, trained time, data cut-off, evaluation), the current/pending/last jobs
  (requested, started and finished times, trigger, change count, dataset size, errors), recent jobs,
  and the scheduler configuration. It is shown in **Admin → LSTM Forecast Model**, and as a badge in the WCO
  Records dialog after any edit.
- **Manual:** `POST /api/v1/forecast/train` (admin/researcher) → 202, or 409 if a job is training. A pending
  automatic job is folded into the manual one.
- **No partial models:** weights are stored in the database with a SHA-256. The local cache is written
  to a temp file, fsynced and atomically renamed, and is checksum-verified before use. Activation is one transaction.
- **Restarts and retries:** pending jobs live in the database. A job orphaned by a crashed process is marked
  failed ("interrupted") and **re-queued**. A transient failure (e.g. lost DB connection) is re-queued with
  back-off up to `RETRAIN_MAX_ATTEMPTS` (3). A data-validation rejection is not retried (more data is
  needed). Models survive restarts and ephemeral disks because the DB holds them.
- **Worker visibility:** each worker writes a heartbeat (`retraining_workers`). The status endpoint and
  Admin panel report "worker online/offline", so a job waiting for a stopped worker is visible, not silent.
- **Several workers:** at most one pending row (partial unique index); the claim is atomic; the
  PostgreSQL advisory lock prevents two trainings at once; every worker polls for queued jobs every
  `RETRAIN_POLL_SECONDS` (default 30 s), so a job queued by another worker or a script still runs.

**Limitations (stated honestly):**

- The queue is a PostgreSQL table polled by the worker. This is durable and adequate for this workload,
  but not a dedicated message broker.
- An interrupted job is re-run from the start, not resumed.
- **Retraining happens only while a worker is running.** If no worker runs, jobs wait (visible in the UI).
- Advisory locks need a session connection: the worker must use the Supabase *Session* pooler (5432).
- A worker that loses its DB connection mid-training releases the lock, so a second training could
  start. The single-active-version constraint keeps the result consistent.
- In `inprocess` mode, training competes with request handling for CPU.

**Configuration:** `AUTO_RETRAIN_ENABLED`, `RETRAIN_DEBOUNCE_SECONDS`, `RETRAIN_POLL_SECONDS`,
`ML_RANDOM_SEED`, `ML_MAX_EPOCHS`, `ML_PATIENCE`, `ML_TEST_WEEKS` (≥ 13), `ML_VAL_WEEKS`,
`ML_MIN_HISTORY_WEEKS`, `MODEL_ARTIFACT_DIR`, `RETRAIN_EXECUTOR`, `RETRAIN_MAX_ATTEMPTS`,
`WORKER_POLL_SECONDS`, `WORKER_HEARTBEAT_SECONDS`. A dataset needs roughly 12 + 1 + 6 + 16 = **35+ consecutive weeks** per
series for the default split; with less, the job fails with an explanatory message and the previous model stays active.

<a id="synthetic-data"></a>
## 8. Synthetic data: assumptions and provenance

**Quantities.** All WCO quantities in the bundled and demo datasets are **generated**, not measured.
The generator (`scripts/load_demo_data.py`, same profile as the legacy import script):

| Type | Count | Base level ~ Uniform (L/week) | Seasonal amplitude (L) | Trend (L/week per week) | Noise σ (L) |
|---|---|---|---|---|---|
| restaurant | 60 | 20–55 | 8 | 0.10 | 2.4 |
| fast_food | 40 | 40–80 | 14 | 0.18 | 4.2 |
| food_manufacturer | 20 | 70–120 | 6 | 0.25 | 1.8 |

The 13-week sine (quarterly cycle), the ranges, the trend and the noise are **illustrative assumptions**,
not estimates from Batangas City establishments. Each establishment's stream is seeded from
(`--seed`, `wco_code`), so series are reproducible. Extensions of existing series use seasonal continuation
`q(t) = q(t−13) + 13·trend + noise`. Volumes are not spatially structured, which matters for the hotspot
analysis (§9).

**Locations.** `data/demo_establishment_catalog.csv` holds 120 coordinates manually placed near publicly
known landmarks (SM City Batangas, the national highway, BatStateU Alangilan, the city hall, the port).
Many are evenly spaced offsets from those anchors. They are **approximate and not field-surveyed**, and
the listed business names were not verified to be at those points. The separate
`data/batangas_city_restaurants_seed.csv` (32 rows) is a manually compiled list from food-delivery and
mall directories; it is not used by the app.

**Presentation rules implemented:**
- every generated row has `data_source = 'synthetic'`
- `consent_given = false` (consent was never collected)
- the dashboard shows "N % of WCO records are SYNTHETIC"
- the demo loader uses generic names ("Fast-food outlet FF012 — Pallocan West") unless `--catalog-names` is given

If the live database still uses real business names next to synthetic volumes, say so explicitly when
presenting, or rename them.

**Present study period and leakage.** The demo loader ends the series at the **last completed week**,
so `/forecast` predicts the 13 weeks starting next week. Training and evaluation use no future information:
- the split is chronological
- the scaler uses training weeks only
- early stopping uses weeks *before* the test period
- every backtest input window ends at its forecast origin

Records for future weeks are rejected by the API.

**Existing data.** Don't relabel rows as `synthetic` (`scripts/label_data_source.py`) unless their origin
has been verified. On the new project all rows come from the loader and are already labelled.

**IDs.** Database ids are not stable across databases (the archived export uses 551–670). Use
`wco_code` to match establishments. The loader, the export, and the record importer never rely on archived ids.

## 9. Spatial analysis and routing (methods note)

**Gi\*.** Binary fixed-distance weights in metres (local equirectangular projection), **including the
focal site** (w<sub>ii</sub> = 1). The z-score is from Ord & Getis (1995), the p-value is two-sided normal,
and a Benjamini–Hochberg FDR-adjusted p-value is also reported. Categories:

- `high`: z ≥ 2.576
- `medium`: z ≥ 1.96
- `coldspot`: z ≤ −1.96
- `low`: *not significant*

Before the audit the code computed Gi (self excluded) with a degree-based band.

**Distance-band selection and sensitivity (demo dataset, 120 sites, measured 2026-11-19).**
The sites span only ≈ 2.1 km × 4.9 km (median nearest-neighbour distance 59 m). Global Moran's I
(binary weights, normality z-score) and Gi* counts by band:

| Weights | Mean (min) neighbours | Moran's I | z(I) | Gi* hot, p < .05 | Gi* hot, FDR < .05 | Gi* cold, p < .05 |
|---|---|---|---|---|---|---|
| 200 m | 7.1 (0, 1 isolated) | 0.092 | 2.20 | 6 | 0 | 5 |
| 400 m | 12.3 (2) | 0.060 | 2.03 | 6 | 0 | 6 |
| 500 m | 14.6 (2) | 0.043 | 1.67 | 5 | 0 | 6 |
| 750 m | 20.8 (7) | 0.013 | 0.84 | 3 | 0 | 3 |
| 1,000 m | 28.4 (7) | −0.028 | −0.98 | 5 | 0 | 2 |
| **1,500 m (current default)** | 54.5 (14) | −0.014 | −0.45 | 0 | 0 | 0 |
| 8 nearest neighbours | 8 | 0.101 | 2.65 | 11 | 0 | — |

How to read it:
- There is **weak positive global spatial autocorrelation at short ranges** (≈ 200–400 m, or 8 nearest
  neighbours; p ≈ 0.01–0.04). It plausibly comes from high-volume fast-food outlets clustered around the
  mall. It disappears at 1,500 m, where each site's "neighbourhood" is nearly half the city.
- **Recommended band: 400 m.** It's the largest band that keeps the Moran's I z-score significant, every
  site has ≥ 2 neighbours, and the mean is ≈ 12. 8 nearest neighbours is an equally defensible alternative.
  Set `GIS_BAND_M=400` (or query `?band_m=400`). The choice should be justified *before* looking at which
  sites become hot spots, and agreed with your adviser.
- **At no band does any individual Gi* hot spot survive the Benjamini–Hochberg correction.** With ~120
  simultaneous tests, the 5–11 "hot spots" at p < 0.05 are about what chance alone would produce (≈ 6).

**Interpreting "no significant hotspots".** This is a valid, reportable result, not a failure:
- **Wrong:** "Gi* found no hotspots, so WCO is evenly distributed." The test has limited power, and the
  map's colours still show relative z-scores.
- **Right:** "At the 400 m band, global Moran's I indicates weak clustering (I = 0.060, z = 2.03), but no
  establishment-level hot spot is significant after FDR correction. The colour scale shows relative Gi*
  z-scores, not confirmed clusters."
- Remember the synthetic volumes were generated **without** any spatial process, so spatial findings on
  this data describe the generator and the site layout, not Batangas City.
- KDE shows where generation potential is *concentrated* (density of sites weighted by volume). It does
  not test significance and should not be described as hotspot detection.

**Claims to avoid in the presentation:** "statistically significant hotspots" (unless FDR-significant),
"optimal routes", "accurate forecasts for Batangas City", "online/continuous learning", and anything
implying real establishments supplied the volumes or consented.

**KDE.** `scipy.stats.gaussian_kde` in projected metres, weighted by each site's mean weekly WCO,
Scott's rule. The grid shows **relative** density (normalised to 0–1), not L/km². `bandwidth_m` is
the kernel's actual standard deviation.

**PostGIS.** Geometry is stored as `POINT(lng lat)`, SRID 4326, with a GiST index. The statistics are
computed in Python from the same coordinates. `scripts/check_db.py` cross-checks the neighbour counts
against PostGIS `ST_DWithin(geography)`.

**Routing.** Stop order uses the **nearest-neighbour heuristic**, starting and ending at the depot, on
OSRM road distances. It is fast and usually reasonable but **not guaranteed optimal**; no optimality is
claimed. If OSRM is down, straight-line (haversine) distances are used and flagged. An individual
unroutable leg uses a straight-line estimate, flagged per leg (`distance_basis = mixed`). Durations
assume 30 km/h and exclude stop time. The public OSRM server has a fair-use policy and no SLA.
