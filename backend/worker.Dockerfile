# Optional stand-alone retraining worker image (any Docker host). Not needed on Railway:
# there the API trains in-process. Use this only if the API runs with RETRAIN_EXECUTOR=worker.
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

# requirements.txt pulls the CPU-only PyTorch wheel on Linux.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts
COPY alembic ./alembic
COPY alembic.ini ./

# Run as an unprivileged user.
RUN useradd --create-home worker
USER worker

CMD ["python", "-m", "scripts.retrain_worker"]
