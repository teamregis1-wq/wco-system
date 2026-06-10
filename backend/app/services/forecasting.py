"""Forecasting service — inference and in-backend LSTM training.

The model definition here MUST match the training logic exactly
(same SEQUENCE_LENGTH, HIDDEN_SIZE, NUM_LAYERS).

Training runs in a FastAPI BackgroundTask so it never blocks the API.
Status is tracked in a module-level dict (_training_state).
"""
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import ForecastPoint, ForecastResponse

ARTIFACT_DIR   = Path(__file__).parent / "model_artifacts"
WEIGHTS_PATH   = ARTIFACT_DIR / "lstm_wco.pt"
SCALER_PATH    = ARTIFACT_DIR / "scaler.npz"

SEQUENCE_LENGTH = 12
HIDDEN_SIZE     = 64
NUM_LAYERS      = 2

# ── Training state ─────────────────────────────────────────────────────────────

_training_lock  = threading.Lock()
_training_state: dict = {
    "status":      "idle",   # idle | training | done | failed
    "metrics":     None,
    "error":       None,
    "started_at":  None,
    "finished_at": None,
}


def get_training_status() -> dict:
    with _training_lock:
        return dict(_training_state)


def _set_state(**kwargs: object) -> None:
    with _training_lock:
        _training_state.update(kwargs)


# ── Model definition (shared by training + inference) ─────────────────────────

def _build_model(torch, nn):
    class WCOLSTM(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(1, HIDDEN_SIZE, NUM_LAYERS, batch_first=True)
            self.fc   = nn.Linear(HIDDEN_SIZE, 1)

        def forward(self, x):
            out, _ = self.lstm(x)
            return self.fc(out[:, -1, :])

    return WCOLSTM()


# ── In-backend training ────────────────────────────────────────────────────────

def train_lstm(
    db_factory,
    user_email: str = "system",
    user_id: int | None = None,
) -> None:
    """Full training run called from a BackgroundTask.
    Creates its own DB session so the request session is safe to close.
    """
    _set_state(
        status="training",
        metrics=None,
        error=None,
        started_at=datetime.now(timezone.utc).isoformat(),
        finished_at=None,
    )

    db: Session = db_factory()
    try:
        from app.core.audit import log_action
        log_action(db, user_email, user_id, "create", "lstm_training",
                   details="Training started")
        db.commit()

        import torch
        from torch import nn
        from torch.utils.data import DataLoader, TensorDataset
        from itertools import groupby
        from operator import attrgetter

        # ── Load & group data ──────────────────────────────────────────────────
        rows = list(db.scalars(
            select(WCOGenerationRecord)
            .order_by(WCOGenerationRecord.establishment_id,
                      WCOGenerationRecord.week_date)
        ).all())

        if not rows:
            raise ValueError("No WCO records found. Add data in Establishments first.")

        all_vals = np.array([r.quantity_liters for r in rows], dtype=np.float32)
        data_min, data_max = float(all_vals.min()), float(all_vals.max())
        span = (data_max - data_min) or 1.0

        X_list, y_list = [], []
        rows.sort(key=attrgetter("establishment_id", "week_date"))
        for _, grp in groupby(rows, key=attrgetter("establishment_id")):
            series = np.array([r.quantity_liters for r in grp], dtype=np.float32)
            if len(series) <= SEQUENCE_LENGTH:
                continue
            scaled = (series - data_min) / span
            for i in range(len(scaled) - SEQUENCE_LENGTH):
                X_list.append(scaled[i:i + SEQUENCE_LENGTH])
                y_list.append(scaled[i + SEQUENCE_LENGTH])

        if not X_list:
            raise ValueError(
                f"Each establishment needs > {SEQUENCE_LENGTH} weeks of data. "
                "Add more WCO records first."
            )

        X = np.array(X_list, dtype=np.float32)[..., None]  # (N, seq, 1)
        y = np.array(y_list, dtype=np.float32)[..., None]  # (N, 1)

        n   = len(X)
        idx = int(n * 0.8)
        X_train, y_train = X[:idx], y[:idx]
        X_val,   y_val   = X[idx:], y[idx:]

        train_dl = DataLoader(TensorDataset(torch.tensor(X_train), torch.tensor(y_train)),
                              batch_size=32, shuffle=True)
        val_dl   = DataLoader(TensorDataset(torch.tensor(X_val),   torch.tensor(y_val)),
                              batch_size=128)

        # ── Model ─────────────────────────────────────────────────────────────
        device    = torch.device("cpu")
        model     = _build_model(torch, nn).to(device)
        criterion = nn.MSELoss()
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)

        # ── Training with early stopping ───────────────────────────────────────
        EPOCHS, PATIENCE = 80, 8
        best_val, patience_left = float("inf"), PATIENCE
        best_state, epoch_run   = None, 0

        for epoch in range(1, EPOCHS + 1):
            epoch_run = epoch
            model.train()
            for xb, yb in train_dl:
                xb, yb = xb.to(device), yb.to(device)
                optimizer.zero_grad()
                criterion(model(xb), yb).backward()
                optimizer.step()

            model.eval()
            with torch.no_grad():
                vloss = float(np.mean([
                    criterion(model(xb.to(device)), yb.to(device)).item()
                    for xb, yb in val_dl
                ]))

            if vloss < best_val - 1e-5:
                best_val      = vloss
                best_state    = {k: v.cpu().clone() for k, v in model.state_dict().items()}
                patience_left = PATIENCE
            else:
                patience_left -= 1
                if patience_left == 0:
                    break

        model.load_state_dict(best_state)

        # ── Metrics ────────────────────────────────────────────────────────────
        model.eval()
        with torch.no_grad():
            pred_sc = model(torch.tensor(X_val).to(device)).cpu().numpy().ravel()
        true_sc = y_val.ravel()

        pred_l = pred_sc * span + data_min
        true_l = true_sc * span + data_min

        mae  = float(np.mean(np.abs(pred_l - true_l)))
        rmse = float(np.sqrt(np.mean((pred_l - true_l) ** 2)))
        ss_r = float(np.sum((pred_l - true_l) ** 2))
        ss_t = float(np.sum((true_l - true_l.mean()) ** 2))
        r2   = float(1 - ss_r / ss_t) if ss_t > 0 else 0.0
        mape = float(np.mean(np.abs((pred_l - true_l) / (np.abs(true_l) + 1e-8))) * 100)

        # ── Save artifacts ─────────────────────────────────────────────────────
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        torch.save(best_state, WEIGHTS_PATH)
        np.savez(str(SCALER_PATH), min=data_min, max=data_max)

        metrics = {
            "mae":              round(mae,  3),
            "rmse":             round(rmse, 3),
            "r2":               round(r2,   4),
            "mape":             round(mape, 2),
            "training_samples": int(idx),
            "val_samples":      int(n - idx),
            "epochs_run":       epoch_run,
        }
        log_action(db, user_email, user_id, "update", "lstm_training",
                   details=f"Done — MAE={metrics['mae']}L R²={metrics['r2']} MAPE={metrics['mape']}% ({epoch_run} epochs)")
        db.commit()

        _set_state(
            status="done",
            metrics=metrics,
            error=None,
            finished_at=datetime.now(timezone.utc).isoformat(),
        )

    except Exception as exc:
        try:
            from app.core.audit import log_action
            log_action(db, user_email, user_id, "delete", "lstm_training",
                       details=f"Failed — {exc}")
            db.commit()
        except Exception:
            pass
        _set_state(
            status="failed",
            metrics=None,
            error=str(exc),
            finished_at=datetime.now(timezone.utc).isoformat(),
        )
    finally:
        db.close()


# ── Inference ─────────────────────────────────────────────────────────────────

def _load_model():
    import torch
    from torch import nn
    if not WEIGHTS_PATH.exists():
        raise FileNotFoundError(WEIGHTS_PATH)
    model = _build_model(torch, nn)
    model.load_state_dict(torch.load(WEIGHTS_PATH, map_location="cpu"))
    model.eval()
    return model, torch


def _load_scaler():
    if not SCALER_PATH.exists():
        raise FileNotFoundError(SCALER_PATH)
    data = np.load(str(SCALER_PATH))
    return float(data["min"]), float(data["max"])


def generate_forecast(
    db: Session, *, establishment_id: int, horizon_weeks: int = 12
) -> ForecastResponse:
    model, torch = _load_model()
    data_min, data_max = _load_scaler()
    span = (data_max - data_min) or 1.0

    rows = list(db.scalars(
        select(WCOGenerationRecord)
        .where(WCOGenerationRecord.establishment_id == establishment_id)
        .order_by(WCOGenerationRecord.week_date)
    ).all())

    if len(rows) < SEQUENCE_LENGTH:
        raise ValueError(
            f"Need at least {SEQUENCE_LENGTH} weeks of history; got {len(rows)}."
        )

    last_date = rows[-1].week_date
    history   = np.array([r.quantity_liters for r in rows], dtype=np.float32)
    scaled    = (history - data_min) / span
    window    = scaled[-SEQUENCE_LENGTH:].tolist()

    preds: list[float] = []
    with torch.no_grad():
        for _ in range(horizon_weeks):
            x    = torch.tensor(window[-SEQUENCE_LENGTH:], dtype=torch.float32).view(1, SEQUENCE_LENGTH, 1)
            yhat = float(model(x).item())
            preds.append(yhat)
            window.append(yhat)

    points = [
        ForecastPoint(
            week_date=last_date + timedelta(weeks=i),
            predicted_liters=round(max(0.0, p * span + data_min), 2),
        )
        for i, p in enumerate(preds, start=1)
    ]

    return ForecastResponse(
        establishment_id=establishment_id,
        model_version="lstm-v1",
        points=points,
    )
