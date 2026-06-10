"""
Biodiesel Yield Optimization endpoints.

Architecture:
  - A polynomial regression model (degree-2, full interaction terms) is
    trained on the SimulationRun rows in the database (your CHEMCAD data).
  - The model is cached in memory after the first request so it doesn't
    retrain on every call.
  - Three endpoints:
      GET  /biodiesel/surface   — full RSM grid for the 3D Plotly surface
      POST /biodiesel/predict   — predict yield for one parameter combination
      GET  /biodiesel/optimum   — best parameter combination from the model

Replace the 27 synthetic rows with your real CHEMCAD data by running:
  python -m app.import_chemcad  (script provided separately)
The model retrains automatically on the next request.
"""
from functools import lru_cache
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.analysis import SimulationRun, OptimizationResult
from app.schemas.schemas import SimulationRunCreate, SimulationRunOut

router = APIRouter(prefix="/biodiesel", tags=["biodiesel"])


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    temperature_c: float       # 40 – 70
    molar_ratio: float         # 1 – 12
    catalyst_loading_pct: float  # 0.5 – 3.0


class PredictResponse(BaseModel):
    predicted_yield_pct: float
    confidence: str            # 'interpolation' | 'extrapolation'


class OptimumResponse(BaseModel):
    optimal_temp_c: float
    optimal_molar_ratio: float
    optimal_catalyst_pct: float
    max_yield_pct: float
    model_type: str


# ── RSM polynomial model ──────────────────────────────────────────────────────

class RSMModel:
    """Degree-2 polynomial regression (Response Surface Methodology).

    Features for 3 inputs x1, x2, x3:
      1, x1, x2, x3,
      x1², x2², x3²,
      x1·x2, x1·x3, x2·x3
    — the standard second-order RSM model used in Box-Behnken designs.
    """

    def __init__(self):
        self.coef_: np.ndarray | None = None
        self.x_min_: np.ndarray | None = None
        self.x_max_: np.ndarray | None = None

    def _features(self, X: np.ndarray) -> np.ndarray:
        x1, x2, x3 = X[:, 0], X[:, 1], X[:, 2]
        return np.column_stack([
            np.ones(len(X)),
            x1, x2, x3,
            x1**2, x2**2, x3**2,
            x1*x2, x1*x3, x2*x3,
        ])

    def fit(self, X: np.ndarray, y: np.ndarray) -> None:
        self.x_min_ = X.min(axis=0)
        self.x_max_ = X.max(axis=0)
        # Normalize inputs to [-1, 1] (standard for RSM)
        span = self.x_max_ - self.x_min_
        span[span == 0] = 1.0
        X_norm = 2 * (X - self.x_min_) / span - 1
        F = self._features(X_norm)
        # Ordinary least squares: β = (FᵀF)⁻¹Fᵀy
        self.coef_ = np.linalg.lstsq(F, y, rcond=None)[0]

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.coef_ is None:
            raise RuntimeError("Model not fitted yet.")
        span = self.x_max_ - self.x_min_
        span[span == 0] = 1.0
        X_norm = 2 * (X - self.x_min_) / span - 1
        return self._features(X_norm) @ self.coef_

    def is_interpolation(self, x: np.ndarray) -> bool:
        """True if point is within the training data bounding box."""
        return bool(np.all(x >= self.x_min_) and np.all(x <= self.x_max_))

    def find_optimum(self, steps: int = 50) -> tuple[float, float, float, float]:
        """Grid search over the trained input space for maximum yield."""
        t_vals  = np.linspace(self.x_min_[0], self.x_max_[0], steps)
        r_vals  = np.linspace(self.x_min_[1], self.x_max_[1], steps)
        c_vals  = np.linspace(self.x_min_[2], self.x_max_[2], steps)
        grid    = np.array([[t, r, c]
                            for t in t_vals
                            for r in r_vals
                            for c in c_vals])
        preds   = self.predict(grid)
        best    = int(np.argmax(preds))
        t, r, c = grid[best]
        return float(t), float(r), float(c), float(preds[best])


# Cache: one model per database state (cleared when new data is imported).
_cached_model: RSMModel | None = None


def get_rsm_model(db: Session) -> RSMModel:
    global _cached_model
    if _cached_model is not None:
        return _cached_model

    rows = db.scalars(select(SimulationRun)).all()
    if len(rows) < 6:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Need at least 6 simulation runs to fit the RSM model; "
                f"found {len(rows)}. Import your CHEMCAD data first."
            ),
        )

    X = np.array([[r.temperature_c, r.molar_ratio, r.catalyst_loading_pct]
                  for r in rows], dtype=float)
    y = np.array([r.yield_pct for r in rows], dtype=float)

    model = RSMModel()
    model.fit(X, y)
    _cached_model = model
    return model


def invalidate_model_cache():
    """Call this after importing new CHEMCAD data."""
    global _cached_model
    _cached_model = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/surface")
def get_surface(
    steps: int = 20,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Returns a grid of predicted yields for the 3D Plotly surface.

    The frontend renders two 2D slices fixed at the optimal third parameter:
      - Yield vs Temperature vs Molar Ratio  (at optimal catalyst)
      - Yield vs Temperature vs Catalyst     (at optimal molar ratio)

    Response shape:
      {
        "temp_ratio": { "x": [...], "y": [...], "z": [[...]] },
        "temp_catalyst": { "x": [...], "y": [...], "z": [[...]] },
        "optimum": { ... },
        "actual_runs": [ { temp, ratio, catalyst, yield } ... ]
      }
    """
    model = get_rsm_model(db)
    opt_t, opt_r, opt_c, opt_y = model.find_optimum()

    t_vals = np.linspace(model.x_min_[0], model.x_max_[0], steps)
    r_vals = np.linspace(model.x_min_[1], model.x_max_[1], steps)
    c_vals = np.linspace(model.x_min_[2], model.x_max_[2], steps)

    # Surface 1: temp vs ratio (catalyst fixed at optimum)
    z_tr = []
    for t in t_vals:
        row = []
        for r in r_vals:
            pred = float(model.predict(np.array([[t, r, opt_c]]))[0])
            row.append(round(min(max(pred, 0), 100), 2))
        z_tr.append(row)

    # Surface 2: temp vs catalyst (ratio fixed at optimum)
    z_tc = []
    for t in t_vals:
        row = []
        for c in c_vals:
            pred = float(model.predict(np.array([[t, opt_r, c]]))[0])
            row.append(round(min(max(pred, 0), 100), 2))
        z_tc.append(row)

    # Actual experimental runs (for scatter overlay on the surface)
    rows = db.scalars(select(SimulationRun)).all()
    actual = [
        {
            "id": r.id,
            "temperature_c": r.temperature_c,
            "molar_ratio": r.molar_ratio,
            "catalyst_loading_pct": r.catalyst_loading_pct,
            "yield_pct": r.yield_pct,
            "conversion_efficiency": r.conversion_efficiency,
            "notes": r.notes,
        }
        for r in rows
    ]

    return {
        "temp_ratio": {
            "x": t_vals.tolist(),
            "y": r_vals.tolist(),
            "z": z_tr,
            "x_label": "Temperature (°C)",
            "y_label": "Molar Ratio",
            "fixed_label": f"Catalyst = {opt_c:.2f}%",
        },
        "temp_catalyst": {
            "x": t_vals.tolist(),
            "y": c_vals.tolist(),
            "z": z_tc,
            "x_label": "Temperature (°C)",
            "y_label": "Catalyst Loading (%)",
            "fixed_label": f"Molar Ratio = {opt_r:.1f}",
        },
        "optimum": {
            "temperature_c": round(opt_t, 2),
            "molar_ratio": round(opt_r, 2),
            "catalyst_loading_pct": round(opt_c, 3),
            "max_yield_pct": round(opt_y, 2),
        },
        "actual_runs": actual,
    }


@router.post("/predict", response_model=PredictResponse)
def predict_yield(
    payload: PredictRequest,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Real-time yield prediction for one parameter combination."""
    model = get_rsm_model(db)
    x = np.array([[
        payload.temperature_c,
        payload.molar_ratio,
        payload.catalyst_loading_pct,
    ]])
    pred = float(model.predict(x)[0])
    pred = round(min(max(pred, 0.0), 100.0), 2)
    confidence = (
        "interpolation"
        if model.is_interpolation(x[0])
        else "extrapolation"
    )
    return PredictResponse(predicted_yield_pct=pred, confidence=confidence)


@router.get("/optimum", response_model=OptimumResponse)
def get_optimum(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Best parameter combination from the RSM model."""
    model = get_rsm_model(db)
    opt_t, opt_r, opt_c, opt_y = model.find_optimum()

    # Persist to optimization_results table
    db.add(OptimizationResult(
        optimal_temp_c=round(opt_t, 2),
        optimal_molar_ratio=round(opt_r, 2),
        optimal_catalyst_pct=round(opt_c, 3),
        max_yield_pct=round(opt_y, 2),
    ))
    db.commit()

    return OptimumResponse(
        optimal_temp_c=round(opt_t, 2),
        optimal_molar_ratio=round(opt_r, 2),
        optimal_catalyst_pct=round(opt_c, 3),
        max_yield_pct=round(opt_y, 2),
        model_type="RSM Polynomial Degree-2 (Box-Behnken)",
    )


# ── Simulation run CRUD ───────────────────────────────────────────────────────

@router.post("/simulations", response_model=SimulationRunOut, status_code=201)
def create_simulation(
    payload: SimulationRunCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    """Add a new CHEMCAD / experimental run. Clears the RSM cache so the
    model retrains on the next surface request."""
    run = SimulationRun(**payload.model_dump())
    db.add(run)
    log_action(db, current_user.email, current_user.id, "create", "simulation_run",
               details=f"T={payload.temperature_c}°C R={payload.molar_ratio} C={payload.catalyst_loading_pct}% Y={payload.yield_pct}%")
    db.commit()
    db.refresh(run)
    invalidate_model_cache()
    return run


@router.delete("/simulations/{run_id}", status_code=204)
def delete_simulation(
    run_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Simulation run not found")
    log_action(db, current_user.email, current_user.id, "delete", "simulation_run", run_id)
    db.delete(run)
    db.commit()
    invalidate_model_cache()
