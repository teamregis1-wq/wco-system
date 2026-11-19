"""Model artifact persistence and the in-memory active-model cache.

Durability model
----------------
* The DATABASE (table ``model_versions``) is the source of truth: it holds
  every trained version's weights, scaler, and metrics, and marks exactly one
  row active. This survives backend restarts and redeploys even on hosts with
  an ephemeral filesystem.
* The local directory (``MODEL_ARTIFACT_DIR``, default
  ``app/services/model_artifacts``) is only a cache: ``versions/<version>/``.
  Files are written to a temporary name and atomically renamed, and their
  SHA-256 is checked against the database before use, so a partially written
  or corrupted file is never loaded — it is re-fetched from the database.
* The bundled ``lstm_wco.pt`` + ``scaler.npz`` (trained before this audit)
  are used only when the database has no active version yet.
* Each worker process keeps one loaded model in memory and swaps it in a
  single assignment after it has been fully loaded and verified.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.ml import ModelVersion
from app.services.training import (
    HIDDEN_SIZE, NUM_LAYERS, build_model, deserialize_state_dict,
)

logger = logging.getLogger("wco.ml")

ARTIFACT_DIR = (Path(settings.model_artifact_dir) if settings.model_artifact_dir
                else Path(__file__).parent / "model_artifacts")
LEGACY_WEIGHTS_PATH = ARTIFACT_DIR / "lstm_wco.pt"
LEGACY_SCALER_PATH = ARTIFACT_DIR / "scaler.npz"
BUNDLED_VERSION = "lstm-v1-bundled"


class ModelIntegrityError(RuntimeError):
    """Stored weights do not match their recorded checksum."""


@dataclass
class LoadedModel:
    version: str
    model: object
    scaler_min: float
    scaler_max: float
    source: str                      # 'database' | 'local-cache' | 'bundled'
    trained_at: datetime | None = None
    metrics: dict | None = None
    hyperparams: dict | None = field(default=None)

    @property
    def span(self) -> float:
        return (self.scaler_max - self.scaler_min) or 1.0


_cache: LoadedModel | None = None
_cache_lock = threading.Lock()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── Atomic local writes ───────────────────────────────────────────────────────

def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via temp file + fsync + rename, so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def version_dir(version: str) -> Path:
    if "/" in version or "\\" in version or version.startswith("."):
        raise ValueError(f"unsafe model version string: {version!r}")
    return ARTIFACT_DIR / "versions" / version


def write_local_cache(version: str, weights: bytes, metadata: dict) -> None:
    """Best-effort local copy of a version (the database copy is authoritative)."""
    d = version_dir(version)
    atomic_write_bytes(d / "lstm_wco.pt", weights)
    atomic_write_bytes(d / "metadata.json",
                       json.dumps(metadata, indent=2, default=str).encode())


def _read_local_cache(version: str, expected_sha: str) -> bytes | None:
    p = version_dir(version) / "lstm_wco.pt"
    try:
        data = p.read_bytes()
    except (FileNotFoundError, OSError):
        return None
    if sha256_hex(data) != expected_sha:
        logger.warning("Local model cache for %s failed checksum; ignoring it.", version)
        return None
    return data


# ── Loading ───────────────────────────────────────────────────────────────────

def _instantiate(state_dict: dict, hyperparams: dict | None):
    hp = hyperparams or {}
    model = build_model(hp.get("hidden_size", HIDDEN_SIZE), hp.get("num_layers", NUM_LAYERS))
    model.load_state_dict(state_dict, strict=True)
    model.eval()
    return model


def _load_bundled() -> LoadedModel:
    global _cache
    if _cache is not None and _cache.version == BUNDLED_VERSION:
        return _cache
    if not LEGACY_WEIGHTS_PATH.exists() or not LEGACY_SCALER_PATH.exists():
        raise FileNotFoundError(
            "No trained model is available. Train one from Admin → Forecasting "
            "(POST /api/v1/forecast/train).")
    state = deserialize_state_dict(LEGACY_WEIGHTS_PATH.read_bytes())
    scaler = np.load(str(LEGACY_SCALER_PATH))
    loaded = LoadedModel(
        version=BUNDLED_VERSION,
        model=_instantiate(state, None),
        scaler_min=float(scaler["min"]),
        scaler_max=float(scaler["max"]),
        source="bundled",
    )
    _cache = loaded
    return loaded


def get_active_model(db: Session) -> LoadedModel:
    """Return the active model, loading it at most once per worker per version."""
    global _cache
    row = db.execute(
        select(ModelVersion.id, ModelVersion.version, ModelVersion.scaler_min,
               ModelVersion.scaler_max, ModelVersion.created_at, ModelVersion.metrics,
               ModelVersion.hyperparams, ModelVersion.weights_sha256)
        .where(ModelVersion.is_active.is_(True))
    ).first()
    if row is None:
        with _cache_lock:
            return _load_bundled()

    cached = _cache
    if cached is not None and cached.version == row.version:
        return cached

    with _cache_lock:
        cached = _cache
        if cached is not None and cached.version == row.version:
            return cached
        data = _read_local_cache(row.version, row.weights_sha256)
        source = "local-cache"
        if data is None:
            data = db.scalar(select(ModelVersion.weights).where(ModelVersion.id == row.id))
            if data is None or sha256_hex(data) != row.weights_sha256:
                raise ModelIntegrityError(
                    f"Stored weights for model {row.version} failed the checksum check.")
            source = "database"
            try:
                write_local_cache(row.version, data, {
                    "version": row.version, "scaler_min": row.scaler_min,
                    "scaler_max": row.scaler_max, "weights_sha256": row.weights_sha256,
                })
            except OSError:
                logger.warning("Could not write local model cache (read-only filesystem?)")
        loaded = LoadedModel(
            version=row.version,
            model=_instantiate(deserialize_state_dict(data), row.hyperparams),
            scaler_min=row.scaler_min,
            scaler_max=row.scaler_max,
            source=source,
            trained_at=row.created_at,
            metrics=row.metrics,
            hyperparams=row.hyperparams,
        )
        _cache = loaded   # single assignment: readers see old or new, never partial
        return loaded


def invalidate_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = None


def activate_version(db: Session, mv: ModelVersion, when: datetime) -> None:
    """Make ``mv`` the single active version (caller commits).

    Deactivate first, then activate, so the partial unique index
    (at most one active row) is satisfied after each statement.
    """
    db.execute(update(ModelVersion).where(ModelVersion.is_active.is_(True),
                                          ModelVersion.id != mv.id)
               .values(is_active=False))
    db.flush()
    mv.is_active = True
    mv.activated_at = when
    db.flush()
