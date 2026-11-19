"""Forecast-model lifecycle tables: retraining jobs and trained model versions.

These make automatic batch retraining observable and durable:

* ``model_training_jobs`` — one row per (manual or automatic) retraining job,
  with its state machine  pending → training → completed | failed,
  timestamps, dataset size, validation results, and any error.
* ``model_versions`` — every successfully trained model, including its
  weights and scaler. Exactly one row may be active. Storing weights in the
  database means a retrained model survives backend restarts and redeploys
  on hosts with an ephemeral filesystem (Render, Railway, etc.).

The existing ``forecast_runs`` table is left untouched (it was never written
by the application); these tables supersede it.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, LargeBinary, String, Text, text,
)
from sqlalchemy.orm import Mapped, deferred, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


JOB_PENDING = "pending"
JOB_TRAINING = "training"
JOB_COMPLETED = "completed"
JOB_FAILED = "failed"
JOB_STATUSES = (JOB_PENDING, JOB_TRAINING, JOB_COMPLETED, JOB_FAILED)


class ModelTrainingJob(Base):
    __tablename__ = "model_training_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    # 'automatic' (data change) | 'manual' (POST /forecast/train) | 'retry'
    trigger: Mapped[str] = mapped_column(String(20))
    # 1 for a normal job; incremented when a transiently failed job is retried.
    attempt: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
    # Human-readable description of what caused the job, e.g. "wco_record.create".
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # How many data changes were coalesced into this job by the debounce window.
    change_count: Mapped[int] = mapped_column(Integer, default=1)
    requested_by_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    requested_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # Timestamp of the most recent coalesced change; the debounce window is
    # measured from here, so a burst of edits produces one training run.
    last_change_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Outcome
    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    activated: Mapped[bool] = mapped_column(Boolean, default=False)
    dataset_records: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dataset_establishments: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dataset_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    train_samples: Mapped[int | None] = mapped_column(Integer, nullable=True)
    val_samples: Mapped[int | None] = mapped_column(Integer, nullable=True)
    test_samples: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Full evaluation report (one-step + rolling-origin multi-step + baselines).
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Data-validation report (duplicates, gaps, irregular spacing, exclusions).
    data_report: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        # At most ONE pending job at any time: concurrent data changes (even
        # from different backend workers) coalesce into the same row.
        Index(
            "uq_model_training_jobs_single_pending", "status", unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )


class ModelVersion(Base):
    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[str] = mapped_column(String(64), unique=True)
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_training_jobs.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Architecture + training hyperparameters (sequence length, horizon, seed, ...).
    hyperparams: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Min-max scaler fitted on the TRAINING period only.
    scaler_min: Mapped[float] = mapped_column(Float)
    scaler_max: Mapped[float] = mapped_column(Float)
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    dataset_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    data_cutoff_date: Mapped[str | None] = mapped_column(String(10), nullable=True)

    # Serialized PyTorch state_dict. Deferred so listing versions never pulls blobs.
    weights: Mapped[bytes] = deferred(mapped_column(LargeBinary, nullable=False))
    weights_sha256: Mapped[str] = mapped_column(String(64))

    __table_args__ = (
        Index(
            "uq_model_versions_single_active", "is_active", unique=True,
            postgresql_where=text("is_active"),
            sqlite_where=text("is_active = 1"),
        ),
    )


class RetrainingWorker(Base):
    """Heartbeat of each retraining worker process (scripts/retrain_worker.py).

    Lets the API and dashboard report whether queued jobs will be picked up.
    """
    __tablename__ = "retraining_workers"

    worker_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    # idle | training | stopped
    state: Mapped[str] = mapped_column(String(20), default="idle")
    current_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
