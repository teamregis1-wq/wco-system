# Forecasting Model: Training, Evaluation and Automatic Retraining

Implementation: `backend/app/services/training.py` (pipeline), `retraining.py` (jobs and scheduling),
`model_store.py` (persistence), `forecasting.py` (inference). The Colab notebook mirrors the same method.

## 1. Model

| Item | Value |
|---|---|
| Architecture | LSTM, input size 1, 2 layers × 64 hidden units → Linear(64→1) |
| Input | the 12 most recent weekly quantities of **one** establishment, min–max scaled |
| Output | next week's quantity; 13 weeks are produced **recursively** (each prediction is fed back as input) |
| Loss / optimiser | MSE / Adam (lr 1e-3), batch 32, ≤ 80 epochs, early stopping (patience 8) on the validation period |
| Seed | 42 (Python, NumPy, PyTorch, DataLoader shuffling) — same data + seed → identical weights (tested) |
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
- **Restarts:** pending jobs live in the database and are re-armed on startup. A job orphaned by a crash
  is marked failed ("interrupted"). Models survive restarts and ephemeral disks because the DB holds them.
- **Several workers:** at most one pending row (partial unique index); the claim is atomic; the
  PostgreSQL advisory lock prevents two trainings at once; every worker polls for queued jobs every
  `RETRAIN_POLL_SECONDS` (default 30 s), so a job queued by another worker or a script still runs.

**Limitations.** This is an in-process scheduler (threads in the API process), suitable for a thesis
demonstration, not a production-grade durable queue:

- an interrupted job is failed, not resumed
- training uses the API host's CPU and slows requests while it runs (~10–60 s here)
- advisory locks need a session connection (Supabase *Session* pooler, not the Transaction pooler)
- a worker that loses its DB connection mid-training releases the lock, so a second training could
  start; the single-active-version constraint keeps the result consistent

A production system would use a durable queue/worker (e.g. a separate worker process with a DB-backed
or Redis queue) and object storage for artifacts.

**Configuration:** `AUTO_RETRAIN_ENABLED`, `RETRAIN_DEBOUNCE_SECONDS`, `RETRAIN_POLL_SECONDS`,
`ML_RANDOM_SEED`, `ML_MAX_EPOCHS`, `ML_PATIENCE`, `ML_TEST_WEEKS` (≥ 13), `ML_VAL_WEEKS`,
`ML_MIN_HISTORY_WEEKS`, `MODEL_ARTIFACT_DIR`. A dataset needs roughly 12 + 1 + 6 + 16 = **35+ consecutive weeks** per
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

**Hotspot analysis: what the data shows.** The 120 demo sites span only ≈ 2.1 km × 4.9 km (median
nearest-neighbour distance 59 m). With the default 1,500 m band each site has ≈ 54 neighbours, nearly
half the city, so Gi\* compares each site with a near-global mean. On the demo data:

| Band | Mean neighbours | Hot spots p < 0.05 (unadjusted) | Hot spots FDR < 0.05 |
|---|---|---|---|
| 250 m | 8.7 | 8 | 0 |
| 500 m | 14.6 | 5 | 0 |
| 1,000 m | 28.4 | 5 | 0 |
| 1,500 m (default) | 54.5 | 0 | 0 |

No hot spot survives the multiple-testing correction at any band. That is the expected result, because the
synthetic volumes were generated without spatial clustering. The map's continuous colour scale still
shows relative z-scores. **Decision needed for the thesis:** justify a band (e.g. the distance at which
global Moran's I / incremental spatial autocorrelation peaks, or a k-nearest-neighbour rule ensuring
every site has neighbours), and report FDR-adjusted significance. `GET /gis/hotspots?band_m=500` lets you
show the sensitivity live.

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
