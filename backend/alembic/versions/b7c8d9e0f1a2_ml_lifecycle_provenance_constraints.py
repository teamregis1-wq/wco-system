"""ML lifecycle tables, data provenance, and data-integrity constraints

Adds:
  * model_training_jobs  — automatic/manual retraining job state machine
  * model_versions       — trained model weights + scaler + metrics (one active)
  * data_source column   — provenance label on establishments and WCO records
  * updated_at column    — on WCO records
  * UNIQUE (establishment_id, week_date) on wco_generation_records
    (replaces the non-unique ix_wco_estab_week index)
  * CHECK constraints    — quantity range, week_end_date >= week_date,
                           coordinate ranges, allowed data_source values

SAFETY: this migration never deletes or rewrites existing rows. Before adding
constraints it counts rows that would violate them; if any exist it aborts
(PostgreSQL runs the whole migration in one transaction, so nothing is
changed) and prints the queries to inspect them. Fix the data manually, then
re-run `alembic upgrade head`.

Existing rows get data_source = 'unspecified'. Labelling existing synthetic
rows is a separate, explicit step: `python -m scripts.label_data_source`.

Revision ID: b7c8d9e0f1a2
Revises: f2b3c4d5e6a7
Create Date: 2026-11-19
"""
import sqlalchemy as sa
from alembic import op

revision = "b7c8d9e0f1a2"
down_revision = "f2b3c4d5e6a7"
branch_labels = None
depends_on = None

_PRECHECKS = [
    (
        "duplicate (establishment_id, week_date) pairs in wco_generation_records",
        "SELECT COUNT(*) FROM (SELECT establishment_id, week_date FROM wco_generation_records "
        "GROUP BY establishment_id, week_date HAVING COUNT(*) > 1) d",
        "SELECT establishment_id, week_date, COUNT(*) FROM wco_generation_records "
        "GROUP BY establishment_id, week_date HAVING COUNT(*) > 1;",
    ),
    (
        "WCO records with quantity_liters outside [0, 10000] (or NaN/Infinity)",
        "SELECT COUNT(*) FROM wco_generation_records "
        "WHERE NOT (quantity_liters >= 0 AND quantity_liters <= 10000)",
        "SELECT id, establishment_id, week_date, quantity_liters FROM wco_generation_records "
        "WHERE NOT (quantity_liters >= 0 AND quantity_liters <= 10000);",
    ),
    (
        "WCO records whose week_end_date is before week_date",
        "SELECT COUNT(*) FROM wco_generation_records "
        "WHERE week_end_date IS NOT NULL AND week_end_date < week_date",
        "SELECT id, week_date, week_end_date FROM wco_generation_records "
        "WHERE week_end_date IS NOT NULL AND week_end_date < week_date;",
    ),
    (
        "establishments with out-of-range coordinates",
        "SELECT COUNT(*) FROM establishments WHERE NOT "
        "(latitude >= -90 AND latitude <= 90 AND longitude >= -180 AND longitude <= 180)",
        "SELECT id, wco_code, latitude, longitude FROM establishments WHERE NOT "
        "(latitude >= -90 AND latitude <= 90 AND longitude >= -180 AND longitude <= 180);",
    ),
]


def _precheck(bind) -> None:
    problems = []
    for label, count_sql, inspect_sql in _PRECHECKS:
        n = bind.execute(sa.text(count_sql)).scalar() or 0
        if n:
            problems.append(f"  - {n} {label}\n      inspect with: {inspect_sql}")
    if problems:
        raise RuntimeError(
            "Migration b7c8d9e0f1a2 aborted — existing data would violate the new "
            "constraints. No changes were made.\n" + "\n".join(problems) +
            "\nResolve these rows manually (after taking a backup), then re-run "
            "`alembic upgrade head`."
        )


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    _precheck(bind)

    # ── Provenance + updated_at ──────────────────────────────────────────────
    op.add_column("establishments", sa.Column(
        "data_source", sa.String(length=20), nullable=False, server_default="unspecified"))
    op.add_column("wco_generation_records", sa.Column(
        "data_source", sa.String(length=20), nullable=False, server_default="unspecified"))
    op.add_column("wco_generation_records", sa.Column(
        "updated_at", sa.DateTime(timezone=True), nullable=True))

    # ── Constraints on wco_generation_records ────────────────────────────────
    with op.batch_alter_table("wco_generation_records") as batch:
        batch.drop_index("ix_wco_estab_week")
        batch.create_unique_constraint(
            "uq_wco_records_estab_week", ["establishment_id", "week_date"])
        batch.create_check_constraint(
            "ck_wco_records_quantity_range",
            "quantity_liters >= 0 AND quantity_liters <= 10000")
        batch.create_check_constraint(
            "ck_wco_records_week_end_after_start",
            "week_end_date IS NULL OR week_end_date >= week_date")
        batch.create_check_constraint(
            "ck_wco_records_data_source",
            "data_source IN ('synthetic', 'observed', 'unspecified')")

    # establishments has a PostGIS column; SQLite (tests only) cannot ALTER in
    # CHECK constraints without recreating the table, so add them on PostgreSQL.
    if is_pg:
        op.create_check_constraint(
            "ck_establishments_coordinates", "establishments",
            "latitude >= -90 AND latitude <= 90 AND longitude >= -180 AND longitude <= 180")
        op.create_check_constraint(
            "ck_establishments_data_source", "establishments",
            "data_source IN ('synthetic', 'observed', 'unspecified')")

    # ── Retraining jobs ──────────────────────────────────────────────────────
    op.create_table(
        "model_training_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("trigger", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=True),
        sa.Column("change_count", sa.Integer(), nullable=False),
        sa.Column("requested_by_email", sa.String(length=255), nullable=True),
        sa.Column("requested_by_id", sa.Integer(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_change_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("model_version", sa.String(length=64), nullable=True),
        sa.Column("activated", sa.Boolean(), nullable=False),
        sa.Column("dataset_records", sa.Integer(), nullable=True),
        sa.Column("dataset_establishments", sa.Integer(), nullable=True),
        sa.Column("dataset_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("train_samples", sa.Integer(), nullable=True),
        sa.Column("val_samples", sa.Integer(), nullable=True),
        sa.Column("test_samples", sa.Integer(), nullable=True),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("data_report", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_model_training_jobs_status", "model_training_jobs", ["status"])
    op.create_index(
        "uq_model_training_jobs_single_pending", "model_training_jobs", ["status"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
        sqlite_where=sa.text("status = 'pending'"),
    )

    # ── Model versions ───────────────────────────────────────────────────────
    op.create_table(
        "model_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("hyperparams", sa.JSON(), nullable=True),
        sa.Column("scaler_min", sa.Float(), nullable=False),
        sa.Column("scaler_max", sa.Float(), nullable=False),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("dataset_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("data_cutoff_date", sa.String(length=10), nullable=True),
        sa.Column("weights", sa.LargeBinary(), nullable=False),
        sa.Column("weights_sha256", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["model_training_jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version"),
    )
    op.create_index("ix_model_versions_is_active", "model_versions", ["is_active"])
    op.create_index(
        "uq_model_versions_single_active", "model_versions", ["is_active"],
        unique=True,
        postgresql_where=sa.text("is_active"),
        sqlite_where=sa.text("is_active = 1"),
    )

    # Same policy as f2b3c4d5e6a7: block Supabase's auto-generated REST API.
    if is_pg:
        for table in ("model_training_jobs", "model_versions"):
            op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    op.drop_index("uq_model_versions_single_active", table_name="model_versions")
    op.drop_index("ix_model_versions_is_active", table_name="model_versions")
    op.drop_table("model_versions")
    op.drop_index("uq_model_training_jobs_single_pending", table_name="model_training_jobs")
    op.drop_index("ix_model_training_jobs_status", table_name="model_training_jobs")
    op.drop_table("model_training_jobs")

    if is_pg:
        op.drop_constraint("ck_establishments_data_source", "establishments", type_="check")
        op.drop_constraint("ck_establishments_coordinates", "establishments", type_="check")

    with op.batch_alter_table("wco_generation_records") as batch:
        batch.drop_constraint("ck_wco_records_data_source", type_="check")
        batch.drop_constraint("ck_wco_records_week_end_after_start", type_="check")
        batch.drop_constraint("ck_wco_records_quantity_range", type_="check")
        batch.drop_constraint("uq_wco_records_estab_week", type_="unique")
        batch.create_index("ix_wco_estab_week", ["establishment_id", "week_date"])

    op.drop_column("wco_generation_records", "updated_at")
    op.drop_column("wco_generation_records", "data_source")
    op.drop_column("establishments", "data_source")
