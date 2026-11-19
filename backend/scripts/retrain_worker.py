"""Persistent retraining worker — executes queued LSTM retraining jobs.

    cd backend
    ./venv/bin/python -m scripts.retrain_worker            # run until stopped (Ctrl+C / SIGTERM)
    ./venv/bin/python -m scripts.retrain_worker --once     # run the due job (if any), then exit

Why it exists
-------------
On Vercel the API runs as serverless functions: they are frozen once the
response is sent, so a background thread cannot be trusted to train, and the
500 MB Python bundle limit excludes PyTorch. The API therefore only *queues*
jobs (RETRAIN_EXECUTOR=worker), and this process — which has PyTorch and runs
continuously somewhere persistent — does the training:

    loop every WORKER_POLL_SECONDS:
        heartbeat → retraining_workers
        if a pending job's debounce window has elapsed:
            claim it atomically (pending → training) under a PostgreSQL advisory lock
            validate data → train → evaluate → store version → activate (one transaction)
            on transient failure: mark failed and re-queue with back-off (RETRAIN_MAX_ATTEMPTS)

Where to run it: a laptop/lab PC during a demo, a Vercel Daemon (container,
see worker.Dockerfile), or any always-on host (Render/Railway worker, VM).
Several workers may run at once; the claim + advisory lock ensure one
training at a time. Use the Session pooler (port 5432) via WORKER_DATABASE_URL
or DATABASE_URL — advisory locks need a session connection.
"""
from __future__ import annotations

import os

os.environ.setdefault("WCO_PROCESS_ROLE", "worker")   # must precede app imports

import argparse  # noqa: E402
import logging  # noqa: E402
import signal  # noqa: E402
import socket  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

logger = logging.getLogger("wco.worker")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true",
                    help="process the pending job if it is due (waiting out its debounce), then exit")
    ap.add_argument("--max-wait", type=float, default=120.0,
                    help="with --once: longest time to wait for a pending job's debounce (s)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    from app.core.config import settings
    from app.core.database import SessionLocal, engine, safe_url
    from app.services.retraining import (
        RetrainingScheduler, record_worker_heartbeat, run_training_job,
    )

    try:
        import torch  # noqa: F401
    except ImportError:
        logger.error("PyTorch is not installed. Install requirements.txt (it includes CPU PyTorch).")
        return 2

    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    hostname = socket.gethostname()
    logger.info("Retraining worker %s starting; database %s", worker_id, safe_url(str(engine.url)))

    state = {"value": "idle", "job": None}
    stop = threading.Event()

    def runner(sf, job_id):
        state["value"], state["job"] = "training", job_id
        beat()
        try:
            run_training_job(sf, job_id)
        finally:
            state["value"], state["job"] = "idle", None
            beat()

    def beat():
        try:
            with SessionLocal() as db:
                record_worker_heartbeat(db, worker_id, state=state["value"], hostname=hostname,
                                        current_job_id=state["job"])
        except Exception:
            logger.warning("Heartbeat failed (database unreachable?)", exc_info=True)

    def heartbeat_loop():
        while not stop.wait(settings.worker_heartbeat_seconds):
            beat()

    def on_signal(signum, _frame):
        logger.info("Signal %s received — finishing the current job (if any), then exiting.", signum)
        stop.set()

    previous = {sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGINT)}

    sched = RetrainingScheduler(SessionLocal, engine, enabled=True,
                                debounce_seconds=settings.retrain_debounce_seconds,
                                job_runner=runner, execute_jobs=True)
    beat()
    threading.Thread(target=heartbeat_loop, name="heartbeat", daemon=True).start()
    try:
        sched.recover_orphaned_jobs()
    except Exception:
        logger.exception("Startup recovery failed")

    processed = 0
    try:
        if args.once:
            due_in = sched.seconds_until_due()
            if due_in is None:
                logger.info("No pending job.")
            else:
                if due_in > 0:
                    wait = min(due_in, args.max_wait)
                    logger.info("Pending job due in %.0fs; waiting %.0fs.", due_in, wait)
                    stop.wait(wait)
                if sched.run_pending_now(respect_debounce=True, rearm=False):
                    processed += 1
        else:
            while not stop.is_set():
                try:
                    if sched.run_pending_now(respect_debounce=True, rearm=False):
                        processed += 1
                        continue          # check immediately for a job queued meanwhile
                except Exception:
                    logger.exception("Worker iteration failed; retrying after the poll interval")
                stop.wait(settings.worker_poll_seconds)
    finally:
        state["value"], state["job"] = "stopped", None
        beat()
        stop.set()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        logger.info("Worker stopped after processing %s job(s).", processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
