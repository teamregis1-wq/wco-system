"""Automatic batch retraining: triggers, coalescing, locking, failure, recovery."""
import threading
import time
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.models.ml import ModelTrainingJob, ModelVersion
from app.services import model_store, retraining
from app.services.retraining import RetrainingScheduler, run_training_job

API = "/api/v1"


def jobs(db):
    db.expire_all()
    return db.scalars(select(ModelTrainingJob).order_by(ModelTrainingJob.id)).all()


def next_week(db, estab_id):
    from sqlalchemy import func

    from app.models import WCOGenerationRecord
    last = db.scalar(select(func.max(WCOGenerationRecord.week_date))
                     .where(WCOGenerationRecord.establishment_id == estab_id))
    return last + timedelta(weeks=1)


def add_record(client, headers, estab_id, week, qty=50.0):
    return client.post(f"{API}/wco/records", headers=headers, json={
        "establishment_id": estab_id, "week_date": str(week), "quantity_liters": qty})


# ── Triggers ─────────────────────────────────────────────────────────────────

def test_create_schedules_retraining_after_commit(client, researcher_headers, seeded, db):
    e = seeded[0]
    assert add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=60)).status_code == 201
    [job] = jobs(db)
    assert job.status == "pending" and job.trigger == "automatic"
    assert job.reason == "wco_record.create" and job.change_count == 1
    assert job.requested_by_email == "researcher@test.local"


def test_failed_write_does_not_schedule(client, researcher_headers, seeded, db):
    e = seeded[0]
    week = next_week(db, e.id) - timedelta(weeks=1)        # already exists → 409
    assert add_record(client, researcher_headers, e.id, week).status_code == 409
    assert add_record(client, researcher_headers, e.id, week, qty=-1).status_code == 422
    assert jobs(db) == []


def test_edit_delete_and_bulk_all_trigger_and_coalesce(client, researcher_headers, seeded, db):
    e = seeded[0]
    rows = client.get(f"{API}/wco/records?establishment_id={e.id}", headers=researcher_headers).json()
    client.patch(f"{API}/wco/records/{rows[0]['id']}", headers=researcher_headers, json={"quantity_liters": 33})
    client.delete(f"{API}/wco/records/{rows[1]['id']}", headers=researcher_headers)
    week0 = date.fromisoformat(rows[-1]["week_date"]) - timedelta(weeks=1)
    client.post(f"{API}/wco/records/bulk", headers=researcher_headers, json=[
        {"establishment_id": e.id, "week_date": str(week0 - timedelta(weeks=k)), "quantity_liters": 30}
        for k in range(3)])
    [job] = jobs(db)                      # three changes → ONE pending job
    assert job.status == "pending" and job.change_count == 3
    assert job.reason == "wco_record.bulk_import"


def test_bulk_import_with_nothing_new_does_not_trigger(client, researcher_headers, seeded, db):
    e = seeded[0]
    rows = client.get(f"{API}/wco/records?establishment_id={e.id}", headers=researcher_headers).json()
    r = client.post(f"{API}/wco/records/bulk", headers=researcher_headers, json=[
        {"establishment_id": e.id, "week_date": rows[0]["week_date"], "quantity_liters": 1}])
    assert r.json()["imported"] == 0 and r.json()["retraining_job_id"] is None
    assert jobs(db) == []


def test_auto_retrain_can_be_disabled(client, researcher_headers, seeded, db):
    retraining.set_scheduler(RetrainingScheduler(SessionLocal, engine, enabled=False, debounce_seconds=0))
    e = seeded[0]
    add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=70))
    assert jobs(db) == []


# ── Debounce + end-to-end completion ─────────────────────────────────────────

def test_debounce_defers_then_training_completes_and_activates(
        client, researcher_headers, seeded, db, scheduler):
    e = seeded[0]
    add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=70))
    # Inside the debounce window the timer callback must NOT start training.
    assert scheduler.run_pending_now(respect_debounce=True) is None
    assert jobs(db)[0].status == "pending"

    status = client.get(f"{API}/forecast/training-status", headers=researcher_headers).json()
    assert status["status"] == "pending" and status["pending_job"]["change_count"] == 1

    job_id = scheduler.run_pending_now()            # debounce elapsed (forced)
    [job] = jobs(db)
    assert job.id == job_id and job.status == "completed", job.error
    assert job.activated and job.model_version.startswith("lstm-")
    assert job.started_at is not None and job.finished_at is not None
    assert job.dataset_records == 6 * 40 and job.dataset_establishments == 6
    assert job.train_samples > 0 and job.val_samples > 0 and job.test_samples > 0
    assert job.metrics["multi_step"]["horizon_weeks"] == 13
    assert job.data_report["records_total"] == 6 * 40 + 1

    active = db.scalar(select(ModelVersion).where(ModelVersion.is_active.is_(True)))
    assert active.version == job.model_version

    status = client.get(f"{API}/forecast/training-status", headers=researcher_headers).json()
    assert status["status"] == "completed"
    assert status["model_version"] == job.model_version
    for k in ("mae", "rmse", "r2", "mape"):
        assert status["metrics"][k] is not None
    assert status["auto_retraining"]["mode"].startswith("automatic batch retraining")

    fc = client.get(f"{API}/forecast/{e.id}", headers=researcher_headers).json()
    assert fc["model_version"] == job.model_version and len(fc["points"]) == 13


def test_manual_training_endpoint(client, admin_headers, seeded, db):
    r = client.post(f"{API}/forecast/train", headers=admin_headers)
    assert r.status_code == 202 and r.json()["status"] == "training_started"
    # The request armed a 0-second timer; wait for the background thread.
    deadline = time.time() + 120
    while time.time() < deadline:
        if jobs(db)[0].status in ("completed", "failed"):
            break
        time.sleep(0.2)
    [job] = jobs(db)
    assert job.trigger == "manual" and job.status == "completed", job.error


def test_manual_request_absorbs_pending_automatic_job(client, admin_headers, researcher_headers,
                                                       seeded, db, scheduler, monkeypatch):
    monkeypatch.setattr(scheduler, "_schedule", lambda delay: None)   # keep it synchronous
    e = seeded[0]
    add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=70))
    client.post(f"{API}/forecast/train", headers=admin_headers)
    [job] = jobs(db)
    assert job.trigger == "manual" and job.change_count == 2


def test_manual_training_rejected_while_training(client, admin_headers, db):
    db.add(ModelTrainingJob(status="training", trigger="automatic", change_count=1, activated=False))
    db.commit()
    assert client.post(f"{API}/forecast/train", headers=admin_headers).status_code == 409


# ── Locking / deduplication ──────────────────────────────────────────────────

def test_only_one_training_runs_at_a_time(db):
    started, release, runs = threading.Event(), threading.Event(), []

    def slow_runner(sf, job_id):
        runs.append(job_id)
        started.set()
        release.wait(10)
        with sf() as s:
            j = s.get(ModelTrainingJob, job_id)
            j.status = "completed"
            s.commit()

    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=0,
                                job_runner=slow_runner)
    sched._schedule = lambda delay: None
    retraining.set_scheduler(sched)
    sched.notify_data_changed("test")

    t = threading.Thread(target=sched.run_pending_now)
    t.start()
    assert started.wait(10)
    # While the first run holds the lock, a second attempt and a new change must not start training.
    assert sched.run_pending_now() is None
    sched.notify_data_changed("change during training")
    assert sched.run_pending_now() is None
    release.set()
    t.join(10)
    assert len(runs) == 1
    statuses = sorted(j.status for j in jobs(db))
    assert statuses == ["completed", "pending"]   # the mid-training change is queued, not lost
    sched.run_pending_now()
    assert len(runs) == 2


def test_claim_is_atomic(db):
    """A job already claimed by another worker cannot be claimed again."""
    calls = []
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=0,
                                job_runner=lambda sf, jid: calls.append(jid))
    sched._schedule = lambda delay: None
    job_id = sched.notify_data_changed("x")
    with SessionLocal() as s:   # simulate another worker claiming it first
        s.get(ModelTrainingJob, job_id).status = "training"
        s.commit()
    assert sched.run_pending_now() is None and calls == []


def test_single_pending_row_enforced_by_database(db):
    from sqlalchemy.exc import IntegrityError
    db.add_all([ModelTrainingJob(status="pending", trigger="automatic", change_count=1, activated=False),
                ModelTrainingJob(status="pending", trigger="automatic", change_count=1, activated=False)])
    with pytest.raises(IntegrityError):
        db.commit()


# ── Failure handling / rollback ──────────────────────────────────────────────

def _train_successfully(scheduler):
    scheduler._schedule = lambda delay: None
    scheduler.notify_data_changed("initial")
    scheduler.run_pending_now()


def test_failed_training_keeps_previous_model(client, researcher_headers, seeded, db, scheduler, monkeypatch):
    _train_successfully(scheduler)
    v1 = db.scalar(select(ModelVersion.version).where(ModelVersion.is_active.is_(True)))
    assert v1

    def boom(*a, **k):
        raise RuntimeError("simulated failure during training")
    monkeypatch.setattr(retraining, "run_training_pipeline", boom)
    scheduler.notify_data_changed("second")
    scheduler.run_pending_now()

    failed, retry = jobs(db)[-2:]
    assert failed.status == "failed" and "simulated failure" in failed.error and not failed.activated
    assert retry.status == "pending" and retry.trigger == "retry"      # transient → re-queued
    assert db.scalar(select(ModelVersion.version).where(ModelVersion.is_active.is_(True))) == v1
    assert db.query(ModelVersion).count() == 1

    status = client.get(f"{API}/forecast/training-status", headers=researcher_headers).json()
    assert status["status"] == "pending" and status["model_version"] == v1   # retry queued
    assert status["last_finished_job"]["status"] == "failed"
    fc = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert fc.status_code == 200 and fc.json()["model_version"] == v1


def test_failure_during_activation_rolls_back(seeded, db, scheduler, monkeypatch):
    _train_successfully(scheduler)
    v1 = db.scalar(select(ModelVersion.version).where(ModelVersion.is_active.is_(True)))

    def broken_activate(db_, mv, when):
        raise RuntimeError("simulated crash while activating")
    monkeypatch.setattr(model_store, "activate_version", broken_activate)
    scheduler.notify_data_changed("second")
    scheduler.run_pending_now()
    db.expire_all()
    assert jobs(db)[-2].status == "failed" and jobs(db)[-1].trigger == "retry"
    assert db.query(ModelVersion).count() == 1          # half-written version was rolled back
    assert db.scalar(select(ModelVersion.version).where(ModelVersion.is_active.is_(True))) == v1


def test_insufficient_data_fails_cleanly_with_report(db, scheduler):
    from conftest import seed_series
    seed_series(db, n_estab=2, weeks=14)          # far too short for a train/val/test split
    scheduler._schedule = lambda delay: None
    scheduler.notify_data_changed("tiny")
    scheduler.run_pending_now()
    [job] = jobs(db)
    assert job.status == "failed" and "DataValidationError" in job.error
    assert job.data_report["records_total"] == 28
    assert db.query(ModelVersion).count() == 0


# ── Restart recovery ─────────────────────────────────────────────────────────

def test_restart_marks_orphaned_training_failed_and_rearms_pending(db):
    db.add(ModelTrainingJob(status="training", trigger="automatic", change_count=1, activated=False))
    db.commit()
    armed = []
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=5)
    sched._schedule = lambda delay: armed.append(delay)
    sched.start()
    orphan, retry = jobs(db)
    assert orphan.status == "failed" and "Interrupted" in orphan.error
    assert retry.status == "pending" and retry.attempt == 2
    assert armed                                          # the re-queued job was armed

    sched.notify_data_changed("after restart")
    armed.clear()
    sched2 = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=5)
    sched2._schedule = lambda delay: armed.append(delay)
    sched2.start()
    assert len(armed) == 1 and 0 <= armed[0] <= 5     # pending job re-armed after "restart"


def test_run_training_job_directly_is_reproducible(seeded, db):
    """Same data + same seed → identical weights (reproducibility)."""
    ids = []
    for _ in range(2):
        with SessionLocal() as s:
            j = ModelTrainingJob(status="training", trigger="manual", change_count=1, activated=False)
            s.add(j)
            s.commit()
            ids.append(j.id)
        run_training_job(SessionLocal, ids[-1])
    db.expire_all()
    a, b = (db.get(ModelTrainingJob, i) for i in ids)
    assert a.status == b.status == "completed"
    va, vb = (db.scalar(select(ModelVersion).where(ModelVersion.version == j.model_version)) for j in (a, b))
    assert va.weights_sha256 == vb.weights_sha256
    assert a.metrics["mae"] == b.metrics["mae"]
    assert va.dataset_fingerprint == vb.dataset_fingerprint


def test_poller_runs_job_queued_by_another_process(db):
    """A pending job written by another worker/script is picked up by polling."""
    done = threading.Event()

    def runner(sf, job_id):
        with sf() as s:
            s.get(ModelTrainingJob, job_id).status = "completed"
            s.commit()
        done.set()

    with SessionLocal() as s:   # e.g. scripts/load_demo_data.py queues a job directly
        retraining.upsert_pending_job(s, trigger="automatic", reason="demo_data_loader")
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=0,
                                job_runner=runner, poll_seconds=0.2)
    try:
        sched.start()
        assert done.wait(10)
    finally:
        sched.shutdown()
    assert jobs(db)[0].status == "completed"


# ── Deployment architecture: queue-only API + separate worker ────────────────

@pytest.fixture
def queue_only_api(monkeypatch):
    """The API as deployed on Vercel: it only queues jobs (RETRAIN_EXECUTOR=worker)."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "retrain_executor", "worker")
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=0,
                                execute_jobs=False)
    retraining.set_scheduler(sched)
    return sched


def test_executor_defaults_to_worker_on_vercel(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "retrain_executor", "")
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    assert settings.effective_retrain_executor == "inprocess"
    monkeypatch.setenv("VERCEL", "1")
    assert settings.effective_retrain_executor == "worker"


def test_queue_only_api_never_trains(client, researcher_headers, admin_headers, seeded, db, queue_only_api):
    e = seeded[0]
    add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=70))
    queue_only_api.start()                                  # must not recover/execute anything
    r = client.post(f"{API}/forecast/train", headers=admin_headers)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert r.json()["executor"] == "worker"
    time.sleep(0.3)
    [job] = jobs(db)
    assert job.status == "pending" and job.trigger == "manual" and job.change_count == 2
    s = client.get(f"{API}/forecast/training-status", headers=admin_headers).json()
    assert s["status"] == "pending" and s["auto_retraining"]["executor"] == "worker"
    assert s["auto_retraining"]["worker"] is None           # no worker has ever run


def test_worker_process_executes_queued_job(client, researcher_headers, seeded, db,
                                            queue_only_api, monkeypatch):
    """API queues → worker (scripts.retrain_worker --once) trains → API serves new version."""
    from app.core.config import settings
    from scripts import retrain_worker
    monkeypatch.setattr(settings, "retrain_debounce_seconds", 0)
    e = seeded[0]
    add_record(client, researcher_headers, e.id, next_week(db, e.id) - timedelta(weeks=70))
    assert jobs(db)[0].status == "pending"

    assert retrain_worker.main(["--once", "--max-wait", "0"]) == 0

    [job] = jobs(db)
    assert job.status == "completed" and job.activated, job.error
    s = client.get(f"{API}/forecast/training-status", headers=researcher_headers).json()
    assert s["model_version"] == job.model_version
    w = s["auto_retraining"]["worker"]
    assert w["state"] == "stopped" and w["online"] is False      # --once exits cleanly
    fc = client.get(f"{API}/forecast/{e.id}", headers=researcher_headers).json()
    assert fc["model_version"] == job.model_version and len(fc["points"]) == 13


def test_worker_once_without_jobs_exits_cleanly(db, monkeypatch):
    from scripts import retrain_worker
    assert retrain_worker.main(["--once", "--max-wait", "0"]) == 0
    assert jobs(db) == []


def test_transient_failure_is_retried_with_backoff(seeded, db, scheduler, monkeypatch):
    scheduler._schedule = lambda delay: None
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        raise ConnectionError("simulated network blip")
    monkeypatch.setattr(retraining, "run_training_pipeline", flaky)
    scheduler.notify_data_changed("x")
    scheduler.run_pending_now()
    first, retry = jobs(db)
    assert first.status == "failed" and first.attempt == 1
    assert retry.status == "pending" and retry.trigger == "retry" and retry.attempt == 2
    assert "retry of job" in retry.reason
    from app.services.retraining import _aware, utcnow
    assert (_aware(retry.last_change_at) - utcnow()).total_seconds() > 20     # back-off applied

    # Exhaust the attempts: no further retries after RETRAIN_MAX_ATTEMPTS (3).
    scheduler.run_pending_now()
    scheduler.run_pending_now()
    statuses = [(j.attempt, j.status) for j in jobs(db)]
    assert statuses == [(1, "failed"), (2, "failed"), (3, "failed")]


def test_data_validation_failure_is_not_retried(db, scheduler):
    from conftest import seed_series
    seed_series(db, n_estab=2, weeks=14)
    scheduler._schedule = lambda delay: None
    scheduler.notify_data_changed("tiny")
    scheduler.run_pending_now()
    assert [(j.status, j.trigger) for j in jobs(db)] == [("failed", "automatic")]


def test_orphaned_job_is_failed_and_requeued(db):
    db.add(ModelTrainingJob(status="training", trigger="automatic", change_count=1, activated=False))
    db.commit()
    sched = RetrainingScheduler(SessionLocal, engine, enabled=True, debounce_seconds=0)
    assert sched.recover_orphaned_jobs() == 1
    orphan, retry = jobs(db)
    assert orphan.status == "failed" and "Interrupted" in orphan.error
    assert retry.status == "pending" and retry.attempt == 2


def test_worker_heartbeat_reported_online(client, admin_headers, db):
    from app.services.retraining import record_worker_heartbeat
    record_worker_heartbeat(db, "laptop:123", state="idle", hostname="laptop")
    w = client.get(f"{API}/forecast/training-status", headers=admin_headers).json()["auto_retraining"]["worker"]
    assert w["online"] is True and w["worker_id"] == "laptop:123"
