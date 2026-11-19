"""Forecasting service — inference with the active LSTM model.

Training lives in ``app.services.training`` (pure pipeline) and
``app.services.retraining`` (jobs, scheduling, activation). The model
definition, sequence length, and recursive forecasting function are shared
with training, so inference is exactly what the backtest evaluated.

Input window rule: the model reads 12 weekly values — the 12 Monday-start
weeks ending at the establishment's latest record. Weeks need not be
consecutive. The records must span at least MIN_HISTORY_WEEKS (12) weeks and
at least MIN_OBSERVED_WEEKS (8) of those 12 weeks must have a record; missing
weeks are linearly interpolated from the neighbouring records (which may lie
before the window) for the forecast INPUT only, and reported in `warnings`.
A legacy record dated on another weekday counts toward its nearest Monday-start
week unless that week already has a Monday record. Training never uses
interpolated values.
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


MIN_OBSERVED_WEEKS = min(SEQUENCE_LENGTH, max(1, settings.ml_min_observed_weeks))


def _nearest_monday(d: date) -> date:
    """The Monday-start week a record mostly covers (Tue–Thu → back, Fri–Sun → ahead)."""
    off = d.weekday()
    return d - timedelta(days=off) if off <= 3 else d + timedelta(days=7 - off)


def trailing_window(rows: list[tuple[date, float]], min_weeks: int = MIN_HISTORY_WEEKS,
                    warnings: list[str] | None = None,
                    min_observed: int = MIN_OBSERVED_WEEKS):
    """Return (12 weekly input values, origin week) for inference.

    `rows` are (week_date, litres). See the module docstring for the rule.
    Raises InsufficientHistoryError with a human-readable reason when the
    history is too short or too sparse to forecast responsibly.
    """
    if not rows:
        raise InsufficientHistoryError(
            "This establishment has no WCO records yet. Forecasting needs records spanning "
            f"at least {min_weeks} weeks, with at least {min_observed} of the last "
            f"{SEQUENCE_LENGTH} weeks recorded.")

    # One value per Monday-start week; a Monday-dated record always wins.
    weekly: dict[date, float] = {d: v for d, v in rows if d.weekday() == 0}
    stray_used, stray_ignored = [], []
    for d, v in sorted((d, v) for d, v in rows if d.weekday() != 0):
        wk = _nearest_monday(d)
        if wk in weekly:
            stray_ignored.append(d)
        else:
            weekly[wk] = v
            stray_used.append(d)
    weeks = sorted(weekly)
    origin = weeks[-1]
    window_weeks = [origin - timedelta(weeks=SEQUENCE_LENGTH - 1 - i) for i in range(SEQUENCE_LENGTH)]
    span = (origin - weeks[0]).days // 7 + 1
    observed = sum(1 for w in window_weeks if w in weekly)

    if span < min_weeks:
        raise InsufficientHistoryError(
            f"Forecasting needs records spanning at least {min_weeks} weeks; this establishment's "
            f"records span {span} week(s) ({weeks[0]} to {origin}). With a shorter history the "
            "forecast error roughly doubles, so the system waits for more weeks.")
    if observed < min_observed:
        raise InsufficientHistoryError(
            f"Forecasting needs records in at least {min_observed} of the last {SEQUENCE_LENGTH} "
            f"weeks ({window_weeks[0]} to {origin}); this establishment has {observed}. "
            "Add the missing weekly records to enable forecasting.")

    # Interpolate missing weeks from all records (the left anchor may precede the window).
    x = np.array([w.toordinal() for w in weeks], dtype=np.float64)
    y = np.array([weekly[w] for w in weeks], dtype=np.float64)
    values = np.interp([w.toordinal() for w in window_weeks], x, y)

    if warnings is not None:
        missing = [w for w in window_weeks if w not in weekly]
        if missing:
            warnings.append(
                f"{len(missing)} of the {SEQUENCE_LENGTH} input weeks had no record "
                f"({', '.join(map(str, missing))}); they were estimated from neighbouring weeks "
                "for this forecast only.")
        if stray_ignored:
            warnings.append(
                f"Ignored {len(stray_ignored)} record(s) not dated on a Monday "
                f"({', '.join(map(str, stray_ignored))}) because that week already has a "
                "Monday record; edit or delete them.")
        if stray_used:
            warnings.append(
                f"{len(stray_used)} record(s) not dated on a Monday ({', '.join(map(str, stray_used))}) "
                "were counted toward their nearest Monday-start week.")
    return values, origin


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
