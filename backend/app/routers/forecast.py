"""Forecasting endpoints — inference + in-backend LSTM training."""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db, SessionLocal
from app.core.security import get_current_user, require_role
from app.models.establishment import Establishment
from app.schemas.schemas import ForecastResponse
from app.services.forecasting import generate_forecast, get_training_status, train_lstm

router = APIRouter(prefix="/forecast", tags=["forecast"])


@router.get("/training-status", dependencies=[Depends(get_current_user)])
def training_status():
    """Current state of the LSTM training job."""
    return get_training_status()


@router.post("/train")
def trigger_training(
    background_tasks: BackgroundTasks,
    current_user=Depends(require_role("admin", "researcher")),
):
    """Start LSTM training in the background. Returns immediately."""
    state = get_training_status()
    if state["status"] == "training":
        raise HTTPException(status_code=409, detail="Training already in progress.")
    background_tasks.add_task(train_lstm, SessionLocal, current_user.email, current_user.id)
    return {"status": "training_started"}


@router.get("/{establishment_id}", response_model=ForecastResponse)
def forecast_for_establishment(
    establishment_id: int,
    horizon_weeks: int = 12,
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
        raise HTTPException(
            status_code=503,
            detail="No trained model found. Train the LSTM first (Admin → Forecasting).",
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
