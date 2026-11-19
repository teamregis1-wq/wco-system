"""LSTM training pipeline: data validation → chronological split → training → evaluation.

Everything in this module is a pure function of the observations passed in
(no database access), so it is deterministic for a given dataset + seed and
straightforward to unit-test.

Methodology (see docs/ML_TRAINING_AND_EVALUATION.md for the full write-up)
-------------------------------------------------------------------------
* Each establishment is its own weekly time series. Series are split into
  *contiguous runs* of exactly-7-day steps; a missing week, a duplicate week,
  an irregular interval, or an invalid value breaks a run. Input windows
  never span a break, and never mix establishments.
* Split is CHRONOLOGICAL on calendar dates, counted back from the latest
  record (all establishments share the same cut-off dates):

      ... train targets ... | val (early stopping) | test (held-out evaluation)
                            ^val_start             ^test_start          ^last week

* The min-max scaler is fitted on TRAINING-PERIOD values only, so nothing
  from the validation or test weeks leaks into normalisation.
* Seeds (Python, NumPy, PyTorch, DataLoader shuffling) are fixed.
* Evaluation on the held-out test weeks:
    - one-step (1-week-ahead) metrics, the model always sees true history;
    - rolling-origin, recursive 13-week backtest, the model feeds its own
      predictions back in, exactly as the forecast API does;
    - naive baselines on exactly the same samples.
"""
from __future__ import annotations

import hashlib
import io
import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterable

import numpy as np

from app.core.constants import MAX_WEEKLY_LITERS

# These four MUST match the bundled weights and notebooks/lstm_training.ipynb.
SEQUENCE_LENGTH = 12    # LSTM input window: 12 weeks of history
FORECAST_HORIZON = 13   # 13 weeks ≈ 3 months, produced recursively
HIDDEN_SIZE = 64
NUM_LAYERS = 2

MIN_TRAIN_SAMPLES = 32


class DataValidationError(ValueError):
    """The dataset cannot support a sound training run. Carries the report."""

    def __init__(self, message: str, report: dict | None = None):
        super().__init__(message)
        self.report = report or {}


@dataclass(frozen=True)
class TrainingConfig:
    seq_len: int = SEQUENCE_LENGTH
    horizon: int = FORECAST_HORIZON
    hidden_size: int = HIDDEN_SIZE
    num_layers: int = NUM_LAYERS
    learning_rate: float = 1e-3
    batch_size: int = 32
    max_epochs: int = 80
    patience: int = 8
    min_delta: float = 1e-5
    val_weeks: int = 6
    test_weeks: int = 16
    seed: int = 42

    @classmethod
    def from_settings(cls, s) -> "TrainingConfig":
        return cls(
            max_epochs=s.ml_max_epochs,
            patience=s.ml_patience,
            val_weeks=s.ml_val_weeks,
            test_weeks=s.ml_test_weeks,
            seed=s.ml_random_seed,
        )

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Observation:
    establishment_id: int
    week_date: date
    quantity_liters: float


@dataclass
class Segment:
    """A contiguous run of weekly observations for one establishment."""
    establishment_id: int
    dates: list[date]
    values: np.ndarray  # liters, float64


@dataclass
class TrainingResult:
    state_dict: dict
    scaler_min: float
    scaler_max: float
    metrics: dict
    data_report: dict
    fingerprint: str
    hyperparams: dict
    dataset_records: int
    dataset_establishments: int
    train_samples: int
    val_samples: int
    test_samples: int
    data_cutoff: date
    history: list[dict] = field(default_factory=list)


# ── Model definition (shared by training and inference) ───────────────────────

def build_model(hidden_size: int = HIDDEN_SIZE, num_layers: int = NUM_LAYERS):
    import torch  # noqa: F401  (imported lazily: torch is slow to import)
    from torch import nn

    class WCOLSTM(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(1, hidden_size, num_layers, batch_first=True)
            self.fc = nn.Linear(hidden_size, 1)

        def forward(self, x):
            out, _ = self.lstm(x)
            return self.fc(out[:, -1, :])

    return WCOLSTM()


def serialize_state_dict(state_dict: dict) -> bytes:
    import torch
    buf = io.BytesIO()
    torch.save(state_dict, buf)
    return buf.getvalue()


def deserialize_state_dict(data: bytes) -> dict:
    import torch
    # weights_only=True: refuse arbitrary pickled objects in the blob.
    return torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)


def recursive_forecast(model, windows_scaled: np.ndarray, horizon: int) -> np.ndarray:
    """Recursive multi-step forecast in SCALED units.

    windows_scaled: (n, seq_len) — the most recent seq_len observations.
    Returns (n, horizon). Step k uses predictions 1..k-1 as inputs, exactly
    like the production forecast endpoint (both call this function).
    """
    import torch
    window = torch.tensor(np.asarray(windows_scaled, dtype=np.float32)).unsqueeze(-1)
    seq_len = window.shape[1]
    out = np.empty((window.shape[0], horizon), dtype=np.float64)
    model.eval()
    with torch.no_grad():
        for k in range(horizon):
            yhat = model(window[:, -seq_len:, :])           # (n, 1)
            out[:, k] = yhat[:, 0].numpy()
            window = torch.cat([window, yhat.unsqueeze(-1)], dim=1)
    return out


# ── Data validation and segmentation ──────────────────────────────────────────

def segment_series(
    observations: Iterable[Observation], seq_len: int = SEQUENCE_LENGTH,
) -> tuple[list[Segment], dict]:
    """Group by establishment, validate, and split into contiguous weekly runs.

    Detects duplicate weeks, invalid (negative / non-finite / implausibly
    large) values, missing weeks, irregular intervals, and insufficient
    history. Returns (segments usable for training, data report).
    """
    by_estab: dict[int, list[Observation]] = defaultdict(list)
    total = 0
    for o in observations:
        by_estab[o.establishment_id].append(o)
        total += 1

    report = {
        "records_total": total,
        "establishments_total": len(by_estab),
        "duplicate_weeks": 0,
        "invalid_values": 0,
        "missing_weeks": 0,
        "irregular_intervals": 0,
        "segments_used": 0,
        "short_segments_ignored": 0,
        "establishments_eligible": 0,
        "excluded_establishments": [],      # [{establishment_id, reason}]
        "establishments_with_gaps": [],     # ids (capped)
        "min_consecutive_weeks_required": seq_len + 1,
    }
    segments: list[Segment] = []

    for estab_id in sorted(by_estab):
        obs = sorted(by_estab[estab_id], key=lambda o: o.week_date)

        dates_seen: set[date] = set()
        dup = 0
        for o in obs:
            if o.week_date in dates_seen:
                dup += 1
            dates_seen.add(o.week_date)
        if dup:
            # Ambiguous series (two totals for one week): exclude rather than guess.
            report["duplicate_weeks"] += dup
            report["excluded_establishments"].append(
                {"establishment_id": estab_id, "reason": f"{dup} duplicate week(s)"})
            continue

        runs: list[list[Observation]] = []
        current: list[Observation] = []
        had_gap = False
        for o in obs:
            v = o.quantity_liters
            if v is None or not math.isfinite(v) or v < 0 or v > MAX_WEEKLY_LITERS:
                report["invalid_values"] += 1
                had_gap = True
                if current:
                    runs.append(current)
                current = []
                continue
            if current:
                delta = (o.week_date - current[-1].week_date).days
                if delta != 7:
                    had_gap = True
                    if delta % 7 == 0:
                        report["missing_weeks"] += delta // 7 - 1
                    else:
                        report["irregular_intervals"] += 1
                    runs.append(current)
                    current = []
            current.append(o)
        if current:
            runs.append(current)

        if had_gap and len(report["establishments_with_gaps"]) < 50:
            report["establishments_with_gaps"].append(estab_id)

        usable = 0
        for run in runs:
            if len(run) >= seq_len + 1:
                segments.append(Segment(
                    establishment_id=estab_id,
                    dates=[o.week_date for o in run],
                    values=np.array([o.quantity_liters for o in run], dtype=np.float64),
                ))
                usable += 1
            else:
                report["short_segments_ignored"] += 1
        if usable:
            report["establishments_eligible"] += 1
        else:
            longest = max((len(r) for r in runs), default=0)
            report["excluded_establishments"].append({
                "establishment_id": estab_id,
                "reason": f"insufficient history: longest run of consecutive weeks is "
                          f"{longest}, need at least {seq_len + 1}",
            })

    report["segments_used"] = len(segments)
    # Keep the report small enough to store as JSON.
    report["excluded_establishments"] = report["excluded_establishments"][:100]
    return segments, report


def dataset_fingerprint(segments: list[Segment]) -> str:
    """SHA-256 of the exact training data (for provenance/reproducibility)."""
    h = hashlib.sha256()
    for seg in sorted(segments, key=lambda s: (s.establishment_id, s.dates[0])):
        for d, v in zip(seg.dates, seg.values):
            h.update(f"{seg.establishment_id}|{d.isoformat()}|{v:.4f}\n".encode())
    return h.hexdigest()


# ── Metrics ───────────────────────────────────────────────────────────────────

def regression_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict:
    """MAE/RMSE in liters per week, R² (unitless), MAPE in percent.

    MAPE is computed over weeks with actual > 0 only (it is undefined at 0).
    """
    a = np.asarray(actual, dtype=np.float64).ravel()
    p = np.asarray(predicted, dtype=np.float64).ravel()
    if a.size == 0:
        return {"n": 0, "mae": None, "rmse": None, "r2": None, "mape": None}
    err = p - a
    mae = float(np.mean(np.abs(err)))
    rmse = float(np.sqrt(np.mean(err ** 2)))
    ss_res = float(np.sum(err ** 2))
    ss_tot = float(np.sum((a - a.mean()) ** 2))
    r2 = float(1.0 - ss_res / ss_tot) if ss_tot > 0 else None
    nz = a > 0
    mape = float(np.mean(np.abs(err[nz] / a[nz])) * 100.0) if nz.any() else None
    return {
        "n": int(a.size),
        "mae": round(mae, 3),
        "rmse": round(rmse, 3),
        "r2": round(r2, 4) if r2 is not None else None,
        "mape": round(mape, 2) if mape is not None else None,
    }


# ── Pipeline ──────────────────────────────────────────────────────────────────

def _seed_everything(seed: int) -> None:
    import torch
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def run_training_pipeline(
    observations: Iterable[Observation], cfg: TrainingConfig | None = None,
) -> TrainingResult:
    """Validate data, split chronologically, train, and evaluate. No DB access."""
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset

    cfg = cfg or TrainingConfig()
    observations = list(observations)
    segments, report = segment_series(observations, cfg.seq_len)
    if not segments:
        raise DataValidationError(
            f"No establishment has {cfg.seq_len + 1}+ consecutive weekly records. "
            "Add more WCO data before training.", report)

    # ── Chronological boundaries (calendar dates) ─────────────────────────────
    last_date = max(seg.dates[-1] for seg in segments)
    test_start = last_date - timedelta(weeks=cfg.test_weeks - 1)
    val_start = test_start - timedelta(weeks=cfg.val_weeks)
    report["split"] = {
        "train_targets_before": val_start.isoformat(),
        "validation_weeks": f"{val_start.isoformat()} .. {(test_start - timedelta(days=1)).isoformat()}",
        "test_weeks": f"{test_start.isoformat()} .. {last_date.isoformat()}",
        "val_weeks": cfg.val_weeks,
        "test_weeks_count": cfg.test_weeks,
    }

    # ── Scaler fitted on training-period values only ───────────────────────────
    train_vals = np.concatenate([
        seg.values[[d < val_start for d in seg.dates]] for seg in segments
    ])
    if train_vals.size == 0:
        raise DataValidationError(
            "No observations fall in the training period. The dataset needs more "
            f"weeks than the {cfg.val_weeks} validation + {cfg.test_weeks} test weeks.", report)
    scaler_min = float(train_vals.min())
    scaler_max = float(train_vals.max())
    span = (scaler_max - scaler_min) or 1.0

    def scale(x):
        return (np.asarray(x, dtype=np.float64) - scaler_min) / span

    def unscale(x):
        return np.asarray(x, dtype=np.float64) * span + scaler_min

    # ── Windows (never crossing a gap or an establishment boundary) ───────────
    buckets = {k: {"X": [], "y": [], "naive": [], "ma": [], "snaive": []}
               for k in ("train", "val", "test")}
    for seg in segments:
        sv = scale(seg.values)
        for i in range(cfg.seq_len, len(seg.values)):
            d = seg.dates[i]
            key = "train" if d < val_start else ("val" if d < test_start else "test")
            b = buckets[key]
            b["X"].append(sv[i - cfg.seq_len:i])
            b["y"].append(sv[i])
            b["naive"].append(seg.values[i - 1])
            b["ma"].append(seg.values[i - cfg.seq_len:i].mean())
            b["snaive"].append(seg.values[i - 13] if i - 13 >= 0 else np.nan)

    n_train, n_val, n_test = (len(buckets[k]["y"]) for k in ("train", "val", "test"))
    report["samples"] = {"train": n_train, "validation": n_val, "test": n_test}
    if n_train < MIN_TRAIN_SAMPLES or n_val == 0 or n_test == 0:
        need = cfg.seq_len + 1 + cfg.val_weeks + cfg.test_weeks
        raise DataValidationError(
            f"Not enough history for a chronological train/validation/test split "
            f"(train={n_train}, validation={n_val}, test={n_test} windows). Each series "
            f"needs roughly {need}+ consecutive weeks.", report)

    def arr(key, part):
        return np.asarray(buckets[key][part], dtype=np.float32)

    X_train, y_train = arr("train", "X")[..., None], arr("train", "y")[..., None]
    X_val, y_val = arr("val", "X")[..., None], arr("val", "y")[..., None]
    X_test, y_test = arr("test", "X")[..., None], arr("test", "y")

    # ── Train with early stopping on the validation period ─────────────────────
    _seed_everything(cfg.seed)
    gen = torch.Generator().manual_seed(cfg.seed)
    train_dl = DataLoader(TensorDataset(torch.tensor(X_train), torch.tensor(y_train)),
                          batch_size=cfg.batch_size, shuffle=True, generator=gen)
    model = build_model(cfg.hidden_size, cfg.num_layers)
    criterion = nn.MSELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg.learning_rate)
    Xv, yv = torch.tensor(X_val), torch.tensor(y_val)

    best_val, best_state, best_epoch = float("inf"), None, 0
    patience_left = cfg.patience
    history: list[dict] = []
    epoch = 0
    for epoch in range(1, cfg.max_epochs + 1):
        model.train()
        losses = []
        for xb, yb in train_dl:
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            losses.append(loss.item())
        model.eval()
        with torch.no_grad():
            vloss = float(criterion(model(Xv), yv).item())
        tloss = float(np.mean(losses))
        if not (math.isfinite(tloss) and math.isfinite(vloss)):
            raise RuntimeError(f"Training diverged at epoch {epoch} (non-finite loss).")
        history.append({"epoch": epoch, "train_mse": round(tloss, 6), "val_mse": round(vloss, 6)})
        if vloss < best_val - cfg.min_delta:
            best_val, best_epoch = vloss, epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            patience_left = cfg.patience
        else:
            patience_left -= 1
            if patience_left == 0:
                break

    if best_state is None:
        raise RuntimeError("Training produced no usable checkpoint.")
    model.load_state_dict(best_state)
    model.eval()

    # ── One-step (1-week-ahead) evaluation on held-out test weeks ──────────────
    with torch.no_grad():
        pred_test = unscale(model(torch.tensor(X_test)).numpy().ravel())
    true_test = unscale(y_test)
    pred_test = np.maximum(pred_test, 0.0)
    snaive = np.asarray(buckets["test"]["snaive"], dtype=np.float64)
    sn_mask = np.isfinite(snaive)
    one_step = {
        "description": "1-week-ahead predictions on held-out test weeks, using true history as input",
        "model": regression_metrics(true_test, pred_test),
        "naive_last_week": regression_metrics(true_test, buckets["test"]["naive"]),
        "moving_average_12": regression_metrics(true_test, buckets["test"]["ma"]),
        "seasonal_naive_13": regression_metrics(true_test[sn_mask], snaive[sn_mask]),
    }

    # ── Rolling-origin, recursive 13-week backtest ─────────────────────────────
    multi_step = _rolling_origin_backtest(model, segments, cfg, test_start, scale, unscale)

    metrics = {
        "units": {
            "mae": "liters per establishment-week",
            "rmse": "liters per establishment-week",
            "r2": "unitless (share of variance explained in held-out weeks)",
            "mape": "percent (weeks with actual > 0)",
        },
        "one_step": one_step,
        "multi_step": multi_step,
        "training": {
            "epochs_run": epoch,
            "best_epoch": best_epoch,
            "best_val_mse_scaled": round(best_val, 6),
        },
        # Flat keys kept for the existing dashboard/admin UI (= one-step model metrics).
        "mae": one_step["model"]["mae"],
        "rmse": one_step["model"]["rmse"],
        "r2": one_step["model"]["r2"],
        "mape": one_step["model"]["mape"],
        "training_samples": n_train,
        "val_samples": n_val,
        "test_samples": n_test,
        "epochs_run": epoch,
    }
    _assert_finite_metrics(metrics)

    hyperparams = cfg.as_dict()
    hyperparams.update({"architecture": "LSTM(1→64, 2 layers) + Linear(64→1)",
                        "loss": "MSE", "optimizer": "Adam", "scaler": "min-max (train period)"})
    eligible_ids = {s.establishment_id for s in segments}
    return TrainingResult(
        state_dict=best_state,
        scaler_min=scaler_min,
        scaler_max=scaler_max,
        metrics=metrics,
        data_report=report,
        fingerprint=dataset_fingerprint(segments),
        hyperparams=hyperparams,
        dataset_records=int(sum(len(s.values) for s in segments)),
        dataset_establishments=len(eligible_ids),
        train_samples=n_train,
        val_samples=n_val,
        test_samples=n_test,
        data_cutoff=last_date,
        history=history,
    )


def _rolling_origin_backtest(model, segments, cfg, test_start, scale, unscale) -> dict:
    """Recursive H-step forecasts from every origin whose targets are all held out.

    Origin = the last observed week before the forecast. For each series and
    each origin j with dates[j+1] >= test_start and j+H within the run, the
    model forecasts H weeks recursively from the 12 weeks ending at j.
    """
    H, L = cfg.horizon, cfg.seq_len
    windows, actual, naive, snaive, ma, origin_dates = [], [], [], [], [], []
    for seg in segments:
        v = seg.values
        for j in range(L - 1, len(v) - H):
            if seg.dates[j + 1] < test_start:
                continue
            windows.append(scale(v[j - L + 1:j + 1]))
            actual.append(v[j + 1:j + 1 + H])
            naive.append(np.repeat(v[j], H))
            ma.append(np.repeat(v[j - L + 1:j + 1].mean(), H))
            snaive.append(np.array([v[j + h - 13] if j + h - 13 >= 0 else np.nan
                                    for h in range(1, H + 1)]))
            origin_dates.append(seg.dates[j])

    if not windows:
        return {"description": "not enough held-out weeks for a full horizon", "origins": 0}

    pred = np.maximum(unscale(recursive_forecast(model, np.asarray(windows), H)), 0.0)
    actual = np.asarray(actual)
    naive, ma, snaive = np.asarray(naive), np.asarray(ma), np.asarray(snaive)
    sn_mask = np.isfinite(snaive)

    per_horizon = []
    for h in range(H):
        m = regression_metrics(actual[:, h], pred[:, h])
        per_horizon.append({"h": h + 1, "mae": m["mae"], "rmse": m["rmse"], "mape": m["mape"],
                            "naive_mae": regression_metrics(actual[:, h], naive[:, h])["mae"]})

    # City-level aggregate: sum establishments sharing an origin date.
    by_origin: dict[date, list[int]] = defaultdict(list)
    for idx, d in enumerate(origin_dates):
        by_origin[d].append(idx)
    agg_true, agg_pred, agg_naive = [], [], []
    for d in sorted(by_origin):
        ids = by_origin[d]
        agg_true.append(actual[ids].sum(axis=0))
        agg_pred.append(pred[ids].sum(axis=0))
        agg_naive.append(naive[ids].sum(axis=0))

    return {
        "description": (f"Rolling-origin backtest: recursive {H}-week forecasts from every origin "
                        f"whose {H} target weeks are all held-out test weeks"),
        "horizon_weeks": H,
        "origins": len(by_origin),
        "origin_dates": [d.isoformat() for d in sorted(by_origin)],
        "forecasts": int(len(windows)),
        "model": regression_metrics(actual, pred),
        "naive_last_week": regression_metrics(actual, naive),
        "moving_average_12": regression_metrics(actual, ma),
        "seasonal_naive_13": regression_metrics(actual[sn_mask], snaive[sn_mask]),
        "per_horizon": per_horizon,
        "aggregate_city_total": {
            "description": "Sum over establishments per forecast week (liters per week, city total)",
            "model": regression_metrics(np.asarray(agg_true), np.asarray(agg_pred)),
            "naive_last_week": regression_metrics(np.asarray(agg_true), np.asarray(agg_naive)),
        },
    }


def _assert_finite_metrics(metrics: dict) -> None:
    for key in ("mae", "rmse", "mape"):
        v = metrics.get(key)
        if v is None or not math.isfinite(v):
            raise RuntimeError(f"Evaluation produced an invalid {key}: {v!r}")
