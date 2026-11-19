# Retraining worker image (Vercel Daemon, Render/Railway worker, or any Docker host).
#   docker build -f worker.Dockerfile -t wco-retrain-worker .
#   docker run --env-file .env wco-retrain-worker
# Needs DATABASE_URL (or WORKER_DATABASE_URL, Session pooler :5432) and JWT_SECRET.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WCO_PROCESS_ROLE=worker \
    RETRAIN_EXECUTOR=inprocess \
    MODEL_ARTIFACT_DIR=/tmp/wco-model-cache

WORKDIR /app

# CPU-only PyTorch first (the default Linux wheel pulls ~2 GB of CUDA libraries).
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.0
COPY requirements.txt requirements-worker.txt ./
RUN pip install -r requirements-worker.txt

COPY app ./app
COPY scripts ./scripts
COPY alembic ./alembic
COPY alembic.ini ./

# Run as an unprivileged user.
RUN useradd --create-home worker
USER worker

CMD ["python", "-m", "scripts.retrain_worker"]
