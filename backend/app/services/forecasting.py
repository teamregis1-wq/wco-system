"""Forecasting service — inference with the active LSTM model.

Training lives in ``app.services.training`` (pure pipeline) and
``app.services.retraining`` (jobs, scheduling, activation). The model
definition, sequence length, and recursive forecasting function are shared
with training, so inference is exactly what the backtest evaluated.

Input window rule: the model reads the most recent SEQUENCE_LENGTH (12)
weekly values of an establishment. Up to 2 consecutive missing weeks are
linearly interpolated for the input (and reported as a warning); a longer
gap, an irregular interval, or a duplicate week makes the input ill-defined,
so the API declines to forecast (HTTP 422 with an explanation) rather than
guess. Training never uses interpolated values.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import ForecastPoint, ForecastResponse
from app.services.model_store import LoadedModel, get_active_model
from app.services.retraining import get_training_status  # noqa: F401  (re-export)
from app.services.training import FORECAST_HORIZON, SEQUENCE_LENGTH, recursive_forecast

# Backward-compatible names (the old module exposed these).
MIN_HISTORY_WEEKS = max(SEQUENCE_LENGTH, settings.ml_min_history_weeks)


class InsufficientHistoryError(ValueError):
    pass


MAX_INTERPOLATED_GAP_WEEKS = 2   # inference only; training never uses filled values


def trailing_window(rows: list[tuple[date, float]], min_weeks: int = MIN_HISTORY_WEEKS,
                    warnings: list[str] | None = None):
    """Return (last SEQUENCE_LENGTH weekly values, origin date) for inference.

    Walks back from the latest record over exactly-weekly steps. A short gap
    (at most MAX_INTERPOLATED_GAP_WEEKS missing weeks) is filled by linear
    interpolation — for the forecast INPUT only — and reported in `warnings`.
    A longer gap, an irregular interval, or a duplicate week ends the run.
    Raises InsufficientHistoryError with a human-readable reason when the
    usable run is shorter than `min_weeks`.
    """
    if not rows:
        raise InsufficientHistoryError(
            "This establishment has no WCO records yet. Add at least "
            f"{min_weeks} consecutive weekly records to enable forecasting.")
    filled: list[tuple[date, float]] = [rows[-1]]   # newest first
    break_reason = None
    interpolated: list[date] = []
    i = len(rows) - 1
    while i > 0 and len(filled) < max(min_weeks, SEQUENCE_LENGTH):
        (d0, v0), (d1, v1) = rows[i - 1], rows[i]
        delta = (d1 - d0).days
        if delta == 7:
            filled.append((d0, v0))
        elif delta % 7 == 0 and 0 < delta // 7 - 1 <= MAX_INTERPOLATED_GAP_WEEKS:
            k = delta // 7
            for j in range(k - 1, 0, -1):            # missing weeks, newest first
                filled.append((d0 + timedelta(weeks=j), v0 + (v1 - v0) * j / k))
                interpolated.append(d0 + timedelta(weeks=j))
            filled.append((d0, v0))
        else:
            if delta == 0:
                break_reason = f"duplicate record for week {d1}"
            elif delta % 7 == 0:
                break_reason = f"{delta // 7 - 1} missing week(s) between {d0} and {d1}"
            else:
                break_reason = f"irregular {delta}-day interval between {d0} and {d1}"
            break
        i -= 1
    run = list(reversed(filled))
    if len(run) < min_weeks:
        msg = (f"Forecasting needs at least {min_weeks} consecutive weekly records; "
               f"the most recent consecutive run has {len(run)} (ending {rows[-1][0]}).")
        if break_reason:
            msg += f" The run is broken by {break_reason}."
        raise InsufficientHistoryError(msg)
    window = run[-SEQUENCE_LENGTH:]
    used = [d for d in interpolated if d >= window[0][0]]
    if used and warnings is not None:
        warnings.append(
            f"{len(used)} missing week(s) in the 12-week input ({', '.join(map(str, sorted(used)))}) "
            "were linearly interpolated for this forecast only.")
    values = np.array([v for _, v in window], dtype=np.float64)
    return values, rows[-1][0]


def _staleness_warning(origin: date) -> list[str]:
    lag = (date.today() - origin).days
    if lag > 14:
        return [f"Latest record is from {origin} ({lag} days ago); the forecast starts after "
                "that week, so some 'forecast' weeks may already be in the past."]
    return []


def _points(lm: LoadedModel, origin: date, scaled_preds: np.ndarray) -> list[ForecastPoint]:
    liters = np.maximum(scaled_preds * lm.span + lm.scaler_min, 0.0)
    return [ForecastPoint(week_date=origin + timedelta(weeks=i), predicted_liters=round(float(v), 2))
            for i, v in enumerate(liters, start=1)]


def generate_forecast(
    db: Session, *, establishment_id: int, horizon_weeks: int = FORECAST_HORIZON,
) -> ForecastResponse:
    lm = get_active_model(db)
    rows = [(r[0], float(r[1])) for r in db.execute(
        select(WCOGenerationRecord.week_date, WCOGenerationRecord.quantity_liters)
        .where(WCOGenerationRecord.establishment_id == establishment_id)
        .order_by(WCOGenerationRecord.week_date)
    ).all()]
    warnings: list[str] = []
    values, origin = trailing_window(rows, warnings=warnings)
    window = ((values - lm.scaler_min) / lm.span)[None, :]
    preds = recursive_forecast(lm.model, window, horizon_weeks)[0]
    return ForecastResponse(
        establishment_id=establishment_id,
        model_version=lm.version,
        points=_points(lm, origin, preds),
        forecast_origin=origin,
        horizon_weeks=horizon_weeks,
        trained_at=lm.trained_at,
        warnings=warnings + _staleness_warning(origin),
    )


def aggregate_forecast(db: Session, horizon_weeks: int = FORECAST_HORIZON) -> dict:
    """Sum of per-establishment forecasts by calendar week (batched inference).

    Returns {"points": [...], "included": n, "skipped": {id: reason}, "model_version": v}.
    """
    lm = get_active_model(db)
    rows = db.execute(
        select(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date,
               WCOGenerationRecord.quantity_liters)
        .join(Establishment, Establishment.id == WCOGenerationRecord.establishment_id)
        .where(Establishment.is_active.is_(True))
        .order_by(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date)
    ).all()
    series: dict[int, list[tuple[date, float]]] = defaultdict(list)
    for eid, d, q in rows:
        series[eid].append((d, float(q)))

    ids, windows, origins, skipped = [], [], [], {}
    for eid, s in series.items():
        try:
            values, origin = trailing_window(s)
        except InsufficientHistoryError as e:
            skipped[eid] = str(e)
            continue
        ids.append(eid)
        windows.append((values - lm.scaler_min) / lm.span)
        origins.append(origin)

    totals: dict[date, float] = defaultdict(float)
    counts: dict[date, int] = defaultdict(int)
    if windows:
        preds = recursive_forecast(lm.model, np.asarray(windows), horizon_weeks)
        for origin, row in zip(origins, preds):
            for p in _points(lm, origin, row):
                totals[p.week_date] += p.predicted_liters
                counts[p.week_date] += 1
    return {
        "points": [{"week_date": str(d), "total_predicted_liters": round(totals[d], 1),
                    "establishment_count": counts[d]} for d in sorted(totals)],
        "included": len(ids),
        "skipped": skipped,
        "model_version": lm.version,
    }
