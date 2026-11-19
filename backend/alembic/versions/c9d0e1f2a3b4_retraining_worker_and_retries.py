"""retraining worker heartbeats and job retry attempts

Adds:
  * model_training_jobs.attempt  — retry counter for transiently failed jobs
  * retraining_workers           — heartbeat of each retraining worker process

Additive only; no existing rows are modified (existing jobs get attempt = 1).

Revision ID: c9d0e1f2a3b4
Revises: b7c8d9e0f1a2
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op

revision = "c9d0e1f2a3b4"
down_revision = "b7c8d9e0f1a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("model_training_jobs", sa.Column(
        "attempt", sa.Integer(), nullable=False, server_default="1"))
    op.create_table(
        "retraining_workers",
        sa.Column("worker_id", sa.String(length=120), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("current_job_id", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("worker_id"),
    )
    op.create_index("ix_retraining_workers_last_seen_at", "retraining_workers", ["last_seen_at"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE public.retraining_workers ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_retraining_workers_last_seen_at", table_name="retraining_workers")
    op.drop_table("retraining_workers")
    with op.batch_alter_table("model_training_jobs") as batch:
        batch.drop_column("attempt")
