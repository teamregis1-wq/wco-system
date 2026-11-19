"""Automatic batch retraining of the LSTM forecasting model.

Workflow
--------
    WCO data created / imported / edited / deleted
      → database commit succeeds (the router calls notify_data_changed AFTER commit)
      → a single *pending* job row is created or updated (coalescing)
      → debounce window: further changes extend the window, they do not add jobs
      → job claimed (pending → training) under a process lock + PostgreSQL advisory lock
      → data validation → chronological split → training → held-out evaluation
      → success: new model version stored in the DB and atomically activated
        failure: job marked failed, the previously active model keeps serving
      → forecasts served from the new active version

This is **automatic batch retraining**: every run retrains the model from
scratch on the full current dataset. It is NOT online / incremental learning.

Limitations (deliberate, for a thesis demonstration)
---------------------------------------------------
* The scheduler is in-process (threading.Timer), not a durable job queue.
  Pending jobs are stored in the database, so a restart re-arms them on
  startup, but a job interrupted mid-training is marked failed (and the
  previous model stays active) rather than resumed.
* With several backend workers, each worker may arm a timer; the single
  pending-job row, the atomic pending→training claim, and the PostgreSQL
  advisory lock guarantee that only one worker trains at a time.
* Session-level advisory locks require a *session* connection (Supabase
  Session pooler on port 5432 or a direct connection) — not the
  Transaction pooler (port 6543).
* Training runs on the API host's CPU (~10–60 s for the bundled dataset)
  and competes with request handling while it runs.
"""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import desc, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.establishment import Establishment
from app.models.ml import (
    JOB_COMPLETED, JOB_FAILED, JOB_PENDING, JOB_TRAINING, ModelTrainingJob, ModelVersion,
)
from app.models.wco import WCOGenerationRecord
from app.services import model_store
from app.services.training import (
    DataValidationError, Observation, TrainingConfig, run_training_pipeline,
    serialize_state_dict,
)

logger = logging.getLogger("wco.retraining")

# Arbitrary 64-bit key for pg_try_advisory_lock ("WCO LSTM" in hex-ish).
ADVISORY_LOCK_KEY = 0x5743_4F4C_5354_4D01


class TrainingInProgressError(RuntimeError):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite returns naive datetimes; treat them as UTC.
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── Data loading ──────────────────────────────────────────────────────────────

def load_observations(db: Session) -> list[Observation]:
    """All WCO records of ACTIVE establishments (soft-deleted ones are excluded)."""
    rows = db.execute(
        select(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date,
               WCOGenerationRecord.quantity_liters)
        .join(Establishment, Establishment.id == WCOGenerationRecord.establishment_id)
        .where(Establishment.is_active.is_(True))
        .order_by(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date)
    ).all()
    return [Observation(r[0], r[1], float(r[2])) for r in rows]


# ── Job bookkeeping ───────────────────────────────────────────────────────────

def upsert_pending_job(
    db: Session, *, trigger: str, reason: str,
    user_email: str | None = None, user_id: int | None = None,
) -> int:
    """Create the single pending job, or coalesce into the existing one."""
    for _ in range(3):
        now = utcnow()
        job = db.scalar(
            select(ModelTrainingJob).where(ModelTrainingJob.status == JOB_PENDING)
            .with_for_update()
        )
        if job is not None:
            job.change_count = (job.change_count or 0) + 1
            job.last_change_at = now
            job.reason = reason[:255]
            if trigger == "manual":
                job.trigger = "manual"
                job.requested_by_email, job.requested_by_id = user_email, user_id
        else:
            job = ModelTrainingJob(
                status=JOB_PENDING, trigger=trigger, reason=reason[:255], change_count=1,
                requested_by_email=user_email, requested_by_id=user_id,
                requested_at=now, last_change_at=now, activated=False,
            )
            db.add(job)
        try:
            db.commit()
            return job.id
        except IntegrityError:
            # Another worker inserted the pending row at the same moment; retry as update.
            db.rollback()
    raise RuntimeError("Could not record the retraining request (concurrent updates).")


def _job_dict(job: ModelTrainingJob | None) -> dict | None:
    if job is None:
        return None
    return {
        "id": job.id,
        "status": job.status,
        "trigger": job.trigger,
        "reason": job.reason,
        "change_count": job.change_count,
        "requested_by": job.requested_by_email,
        "requested_at": _iso(job.requested_at),
        "last_change_at": _iso(job.last_change_at),
        "started_at": _iso(job.started_at),
        "finished_at": _iso(job.finished_at),
        "model_version": job.model_version,
        "activated": job.activated,
        "dataset_records": job.dataset_records,
        "dataset_establishments": job.dataset_establishments,
        "train_samples": job.train_samples,
        "val_samples": job.val_samples,
        "test_samples": job.test_samples,
        "error": job.error,
    }


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def get_training_status(db: Session) -> dict:
    """Snapshot of retraining state, shared by all workers (read from the DB)."""
    jobs = db.scalars(select(ModelTrainingJob).order_by(desc(ModelTrainingJob.id)).limit(10)).all()
    training = next((j for j in jobs if j.status == JOB_TRAINING), None)
    pending = next((j for j in jobs if j.status == JOB_PENDING), None)
    if pending is None:
        pending = db.scalar(select(ModelTrainingJob).where(ModelTrainingJob.status == JOB_PENDING))
    finished = next((j for j in jobs if j.status in (JOB_COMPLETED, JOB_FAILED)), None)

    active = db.execute(
        select(ModelVersion.version, ModelVersion.created_at, ModelVersion.activated_at,
               ModelVersion.metrics, ModelVersion.hyperparams, ModelVersion.dataset_fingerprint,
               ModelVersion.data_cutoff_date, ModelVersion.job_id)
        .where(ModelVersion.is_active.is_(True))
    ).first()

    if training is not None:
        status = JOB_TRAINING
    elif pending is not None:
        status = JOB_PENDING
    elif finished is not None:
        status = finished.status
    else:
        status = "idle"

    if active is not None:
        active_model = {
            "version": active.version,
            "source": "database",
            "trained_at": _iso(active.created_at),
            "activated_at": _iso(active.activated_at),
            "data_cutoff_date": active.data_cutoff_date,
            "dataset_fingerprint": active.dataset_fingerprint,
            "hyperparams": active.hyperparams,
            "evaluation": active.metrics,
            "job_id": active.job_id,
        }
    elif model_store.LEGACY_WEIGHTS_PATH.exists():
        active_model = {
            "version": model_store.BUNDLED_VERSION,
            "source": "bundled",
            "trained_at": None,
            "note": ("Bundled model trained before the audit (scaler fitted on all data; "
                     "no held-out evaluation on record). Retrain to replace it."),
            "evaluation": None,
        }
    else:
        active_model = None

    last = training or pending or finished
    metrics = (active_model or {}).get("evaluation")
    sched = get_scheduler()
    return {
        "status": status,                       # idle | pending | training | completed | failed
        "metrics": metrics,                     # evaluation of the ACTIVE model
        "error": finished.error if (status == JOB_FAILED and finished) else None,
        "started_at": _iso(last.started_at) if last else None,
        "finished_at": _iso(last.finished_at) if last else None,
        "model_version": active_model["version"] if active_model else None,
        "trained_at": active_model.get("trained_at") if active_model else None,
        "active_model": active_model,
        "current_job": _job_dict(training),
        "pending_job": _job_dict(pending),
        "last_finished_job": _job_dict(finished),
        "recent_jobs": [_job_dict(j) for j in jobs[:5]],
        "auto_retraining": {
            "enabled": sched.enabled,
            "debounce_seconds": sched.debounce_seconds,
            "mode": "automatic batch retraining (full retrain on the current dataset; not online learning)",
            "scheduler": "in-process timer; job state persisted in the database",
        },
    }


# ── Locks ─────────────────────────────────────────────────────────────────────

@contextmanager
def advisory_lock(engine):
    """Cluster-wide mutual exclusion on PostgreSQL; a no-op elsewhere (tests).

    Uses a session-level advisory lock on a dedicated connection, committed
    immediately so the connection is not left idle-in-transaction while the
    model trains. PostgreSQL releases the lock if the connection dies.
    """
    if engine.dialect.name != "postgresql":
        yield True
        return
    conn = engine.connect()
    try:
        got = bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"),
                                {"k": ADVISORY_LOCK_KEY}).scalar())
        conn.commit()
        try:
            yield got
        finally:
            if got:
                try:
                    conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": ADVISORY_LOCK_KEY})
                    conn.commit()
                except Exception:
                    # Never return a connection that may still hold the lock to the
                    # pool; discarding it closes the session and releases the lock.
                    logger.warning("Failed to release advisory lock cleanly", exc_info=True)
                    conn.invalidate()
    finally:
        conn.close()


# ── Job execution ─────────────────────────────────────────────────────────────

def run_training_job(session_factory, job_id: int, cfg: TrainingConfig | None = None) -> None:
    """Train, evaluate, store, and activate. Never raises; records failures on the job."""
    from app.core.audit import log_action

    cfg = cfg or TrainingConfig.from_settings(settings)
    report = None
    try:
        with session_factory() as db:
            job = db.get(ModelTrainingJob, job_id)
            log_action(db, job.requested_by_email or "system", job.requested_by_id,
                       "create", "lstm_training",
                       details=f"Job #{job_id} started ({job.trigger}: {job.reason})")
            db.commit()
            observations = load_observations(db)

        result = run_training_pipeline(observations, cfg)   # no DB session held
        report = result.data_report
        weights = serialize_state_dict(result.state_dict)
        sha = model_store.sha256_hex(weights)
        now = utcnow()
        version = f"lstm-{now.strftime('%Y%m%dT%H%M%SZ')}-j{job_id}"
        meta = {
            "version": version, "job_id": job_id, "created_at": now.isoformat(),
            "scaler_min": result.scaler_min, "scaler_max": result.scaler_max,
            "weights_sha256": sha, "hyperparams": result.hyperparams,
            "dataset_fingerprint": result.fingerprint,
            "data_cutoff_date": result.data_cutoff.isoformat(),
            "metrics": result.metrics,
        }
        try:
            model_store.write_local_cache(version, weights, meta)
        except OSError:
            logger.warning("Could not write local model cache; database copy is authoritative.")

        with session_factory() as db:
            mv = ModelVersion(
                version=version, job_id=job_id, created_at=now, is_active=False,
                hyperparams=result.hyperparams, scaler_min=result.scaler_min,
                scaler_max=result.scaler_max, metrics=result.metrics,
                dataset_fingerprint=result.fingerprint,
                data_cutoff_date=result.data_cutoff.isoformat(),
                weights=weights, weights_sha256=sha,
            )
            db.add(mv)
            db.flush()
            model_store.activate_version(db, mv, now)
            job = db.get(ModelTrainingJob, job_id)
            job.status = JOB_COMPLETED
            job.finished_at = utcnow()
            job.model_version = version
            job.activated = True
            job.metrics = result.metrics
            job.data_report = result.data_report
            job.dataset_records = result.dataset_records
            job.dataset_establishments = result.dataset_establishments
            job.dataset_fingerprint = result.fingerprint
            job.train_samples = result.train_samples
            job.val_samples = result.val_samples
            job.test_samples = result.test_samples
            m = result.metrics
            log_action(db, job.requested_by_email or "system", job.requested_by_id,
                       "update", "lstm_training",
                       details=(f"Job #{job_id} completed — activated {version}; held-out 1-week "
                                f"MAE={m['mae']} L, RMSE={m['rmse']} L, R²={m['r2']}, MAPE={m['mape']}% "
                                f"({m['epochs_run']} epochs)"))
            db.commit()   # activation and job completion commit atomically
        model_store.invalidate_cache()
        logger.info("Retraining job %s completed; active model is now %s", job_id, version)

    except Exception as exc:
        if isinstance(exc, DataValidationError):
            report = exc.report or report
            logger.warning("Retraining job %s rejected by data validation: %s", job_id, exc)
        else:
            logger.exception("Retraining job %s failed", job_id)
        try:
            with session_factory() as db:
                job = db.get(ModelTrainingJob, job_id)
                job.status = JOB_FAILED
                job.finished_at = utcnow()
                job.activated = False
                job.error = f"{type(exc).__name__}: {exc}"[:2000]
                job.data_report = report
                log_action(db, job.requested_by_email or "system", job.requested_by_id,
                           "update", "lstm_training",
                           details=f"Job #{job_id} FAILED — previous model kept active. {job.error[:300]}")
                db.commit()
        except Exception:
            logger.exception("Could not record failure of retraining job %s", job_id)


# ── Scheduler ─────────────────────────────────────────────────────────────────

class RetrainingScheduler:
    def __init__(self, session_factory, engine, *, enabled: bool, debounce_seconds: float,
                 job_runner=run_training_job, poll_seconds: float = 0.0):
        self._sf = session_factory
        self._engine = engine
        self.enabled = enabled
        self.debounce_seconds = float(debounce_seconds)
        # Safety net: periodically look for a pending job in the database, so a
        # job queued by another worker/process (or one whose timer was lost)
        # still runs. 0 disables polling.
        self.poll_seconds = float(poll_seconds)
        self._job_runner = job_runner
        self._timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()
        self._train_lock = threading.Lock()   # one training per process
        self._stopped = False
        self._stop_event = threading.Event()
        self._poller: threading.Thread | None = None

    # Public API ---------------------------------------------------------------

    def notify_data_changed(self, reason: str, user_email: str | None = None,
                            user_id: int | None = None) -> int | None:
        """Call AFTER a successful commit that changed training data."""
        if not self.enabled:
            return None
        with self._sf() as db:
            job_id = upsert_pending_job(db, trigger="automatic", reason=reason,
                                        user_email=user_email, user_id=user_id)
        self._schedule(self.debounce_seconds)
        return job_id

    def request_manual_training(self, user_email: str | None, user_id: int | None) -> int:
        with self._sf() as db:
            if db.scalar(select(ModelTrainingJob.id).where(ModelTrainingJob.status == JOB_TRAINING)):
                raise TrainingInProgressError("Training already in progress.")
            job_id = upsert_pending_job(db, trigger="manual", reason="manual request",
                                        user_email=user_email, user_id=user_id)
        self._schedule(0)
        return job_id

    def start(self) -> None:
        """Recover state after a restart: fail orphaned jobs, re-arm pending ones."""
        self._stopped = False
        try:
            with advisory_lock(self._engine) as no_one_training:
                if no_one_training:
                    with self._sf() as db:
                        n = db.execute(
                            update(ModelTrainingJob)
                            .where(ModelTrainingJob.status == JOB_TRAINING)
                            .values(status=JOB_FAILED, finished_at=utcnow(),
                                    error="Interrupted: the backend restarted while training. "
                                          "The previously active model was kept.")
                        ).rowcount
                        db.commit()
                        if n:
                            logger.warning("Marked %s interrupted training job(s) as failed", n)
            with self._sf() as db:
                pending = db.scalar(select(ModelTrainingJob)
                                    .where(ModelTrainingJob.status == JOB_PENDING))
            if pending is not None and (self.enabled or pending.trigger == "manual"):
                self._schedule(self._remaining_debounce(pending))
        except Exception:
            logger.exception("Retraining scheduler recovery failed (database unavailable?)")
        if self.poll_seconds > 0 and self._poller is None:
            self._stop_event.clear()
            self._poller = threading.Thread(target=self._poll_loop, name="retrain-poller", daemon=True)
            self._poller.start()

    def _poll_loop(self) -> None:
        while not self._stop_event.wait(self.poll_seconds):
            try:
                self._try_run(respect_debounce=True)
            except Exception:
                logger.exception("Retraining poll failed")

    def shutdown(self) -> None:
        self._stopped = True
        self._stop_event.set()
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def run_pending_now(self, respect_debounce: bool = False) -> int | None:
        """Synchronously claim and run the pending job (tests, CLI)."""
        return self._try_run(respect_debounce=respect_debounce)

    # Internals ----------------------------------------------------------------

    def _remaining_debounce(self, job: ModelTrainingJob) -> float:
        if job.trigger == "manual":
            return 0.0
        elapsed = (utcnow() - _aware(job.last_change_at)).total_seconds()
        return max(0.0, self.debounce_seconds - elapsed)

    def _schedule(self, delay: float) -> None:
        with self._timer_lock:
            if self._stopped:
                return
            if self._timer is not None:
                self._timer.cancel()
            t = threading.Timer(max(0.0, delay), self._on_timer)
            t.daemon = True
            self._timer = t
            t.start()

    def _on_timer(self) -> None:
        try:
            self._try_run(respect_debounce=True)
        except Exception:
            logger.exception("Retraining timer failed")

    def _try_run(self, respect_debounce: bool) -> int | None:
        # Cheap check first, so idle polling never takes the advisory lock.
        with self._sf() as db:
            if db.scalar(select(ModelTrainingJob.id)
                         .where(ModelTrainingJob.status == JOB_PENDING)) is None:
                return None
        if not self._train_lock.acquire(blocking=False):
            return None  # this process is already training; it re-checks pending when done
        job_id = None
        try:
            with advisory_lock(self._engine) as got:
                if not got:
                    # Another worker/process holds the training lock; check back later.
                    self._schedule(max(self.debounce_seconds, 5.0))
                    return None
                with self._sf() as db:
                    job = db.scalar(select(ModelTrainingJob)
                                    .where(ModelTrainingJob.status == JOB_PENDING))
                    if job is None:
                        return None
                    if respect_debounce:
                        remaining = self._remaining_debounce(job)
                        if remaining > 0.05:
                            self._schedule(remaining)
                            return None
                    claimed = db.execute(
                        update(ModelTrainingJob)
                        .where(ModelTrainingJob.id == job.id,
                               ModelTrainingJob.status == JOB_PENDING)
                        .values(status=JOB_TRAINING, started_at=utcnow())
                    ).rowcount
                    db.commit()
                    if claimed != 1:
                        return None
                    job_id = job.id
                self._job_runner(self._sf, job_id)
                return job_id
        finally:
            self._train_lock.release()
            if job_id is not None:
                self._rearm_if_pending()

    def _rearm_if_pending(self) -> None:
        """Changes that arrived during training created a new pending job."""
        try:
            with self._sf() as db:
                pending = db.scalar(select(ModelTrainingJob)
                                    .where(ModelTrainingJob.status == JOB_PENDING))
            if pending is not None:
                self._schedule(self._remaining_debounce(pending))
        except Exception:
            logger.exception("Could not re-check for pending retraining jobs")


_scheduler: RetrainingScheduler | None = None
_scheduler_lock = threading.Lock()


def get_scheduler() -> RetrainingScheduler:
    global _scheduler
    if _scheduler is None:
        with _scheduler_lock:
            if _scheduler is None:
                from app.core.database import SessionLocal, engine
                _scheduler = RetrainingScheduler(
                    SessionLocal, engine,
                    enabled=settings.auto_retrain_enabled,
                    debounce_seconds=settings.retrain_debounce_seconds,
                    poll_seconds=settings.retrain_poll_seconds,
                )
    return _scheduler


def set_scheduler(s: RetrainingScheduler | None) -> None:
    """Replace the process-wide scheduler (used by tests)."""
    global _scheduler
    _scheduler = s


def notify_training_data_changed(reason: str, user=None) -> int | None:
    """Router helper: schedule retraining; never fails the (already committed) request."""
    try:
        return get_scheduler().notify_data_changed(
            reason, getattr(user, "email", None), getattr(user, "id", None))
    except Exception:
        logger.exception("Data change committed, but scheduling retraining failed (%s)", reason)
        return None
