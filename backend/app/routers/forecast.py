"""Forecasting endpoints — inference, manual training, and retraining status."""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.establishment import Establishment
from app.schemas.schemas import AggregateForecastPoint, ForecastResponse
from app.services.forecasting import (
    InsufficientHistoryError, aggregate_forecast as _aggregate, generate_forecast,
)
from app.services.model_store import ModelIntegrityError
from app.services.retraining import (
    TrainingInProgressError, get_scheduler, get_training_status,
)
from app.services.training import FORECAST_HORIZON

logger = logging.getLogger("wco.forecast")

router = APIRouter(prefix="/forecast", tags=["forecast"])

_NO_MODEL = "No trained model found. Train the LSTM first (Admin → Forecasting)."


@router.get("/training-status", dependencies=[Depends(get_current_user)])
def training_status(db: Session = Depends(get_db)):
    """State of automatic/manual retraining and the active model's evaluation.

    ``status`` is one of: idle | pending | training | completed | failed.
    A failed job never replaces the active model.
    """
    return get_training_status(db)


@router.post("/train", status_code=202)
def trigger_training(current_user=Depends(require_role("admin", "researcher"))):
    """Queue a retraining job that starts without the debounce delay. Returns immediately.

    Any pending automatic job is folded into this one. With RETRAIN_EXECUTOR=worker
    (Vercel) the job runs in the retraining worker; otherwise in this server.
    """
    from app.core.config import settings
    try:
        job_id = get_scheduler().request_manual_training(current_user.email, current_user.id)
    except TrainingInProgressError:
        raise HTTPException(status_code=409, detail="Training already in progress.")
    if settings.effective_retrain_executor == "worker":
        return {"status": "queued", "job_id": job_id, "executor": "worker"}
    return {"status": "training_started", "job_id": job_id, "executor": "inprocess"}


@router.get("/aggregate", response_model=list[AggregateForecastPoint])
def aggregate_forecast(
    response: Response,
    horizon_weeks: int = Query(FORECAST_HORIZON, ge=1, le=52),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Aggregate forecasted WCO supply across all active establishments.

    Establishments whose records span < 12 weeks or that have records in fewer
    than 8 of the last 12 weeks are skipped; the
    counts are reported in the X-Forecast-Included / X-Forecast-Skipped headers.
    """
    try:
        result = _aggregate(db, horizon_weeks=horizon_weeks)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail=_NO_MODEL)
    except ModelIntegrityError as e:
        raise HTTPException(status_code=503, detail=str(e))
    response.headers["X-Forecast-Included"] = str(result["included"])
    response.headers["X-Forecast-Skipped"] = str(len(result["skipped"]))
    response.headers["X-Model-Version"] = result["model_version"]
    if result["skipped"]:
        logger.info("Aggregate forecast skipped %d establishment(s)", len(result["skipped"]))
    return result["points"]


@router.get("/{establishment_id}", response_model=ForecastResponse)
def forecast_for_establishment(
    establishment_id: int,
    horizon_weeks: int = Query(FORECAST_HORIZON, ge=1, le=52),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    estab = db.get(Establishment, establishment_id)
    if not estab:
        raise HTTPException(status_code=404, detail="Establishment not found")
    try:
        return generate_forecast(db, establishment_id=establishment_id,
                                 horizon_weeks=horizon_weeks)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail=_NO_MODEL)
    except ModelIntegrityError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except InsufficientHistoryError as e:
        raise HTTPException(status_code=422, detail=str(e))
